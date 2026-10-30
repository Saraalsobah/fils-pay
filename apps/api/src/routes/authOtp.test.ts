/**
 * Login / OTP security regressions. Real Postgres (DATABASE_URL), via app.inject.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { randomDigits, randomFromAlphabet } from "../lib/random.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("authOtp.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const WEBHOOK_KEY = "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=";
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: WEBHOOK_KEY,
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const PASSWORD = "correct horse battery staple 1!";

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@example.test`;
}

function cookieOf(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!header) throw new Error("expected Set-Cookie");
  return header.split(";")[0] as string;
}

async function signup(label: string, email = uniqueEmail(label)) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: {
      businessProfile: {
        legalName: `OTP Co ${label}`,
        registrationNumber: `RC-${randomUUID().slice(0, 8)}`,
        businessType: "llc",
        contactEmail: uniqueEmail("contact"),
        contactPhone: "+97300000000",
        addressLine1: "1 Test Street",
        city: "Manama",
      },
      owner: { email, password: PASSWORD },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return { merchantId: (res.json() as { merchantId: string }).merchantId, email };
}

async function login(merchantId: string, email: string) {
  const res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password: PASSWORD } });
  assert.equal(res.statusCode, 200, res.body);
  return { cookie: cookieOf(res.headers["set-cookie"]), code: (res.json() as { devOtpCode: string }).devOtpCode };
}

function wrongCode(real: string): string {
  return real === "000000" ? "111111" : "000000";
}

test("a password-only (pre-OTP) session is NOT logged in", async () => {
  const { merchantId, email } = await signup("pending");
  const { cookie } = await login(merchantId, email); // password ok, OTP not entered
  for (const url of ["/v1/auth/me", "/v1/transactions"]) {
    const res = await app.inject({ method: "GET", url, headers: { cookie } });
    assert.equal(res.statusCode, 401, `${url} answered ${res.statusCode} before the OTP step`);
  }
});

test("logging into merchant B never yields a session for merchant A that shares the email", async () => {
  const email = uniqueEmail("shared");
  const a = await signup("shared-a", email);
  const b = await signup("shared-b", email);
  const { cookie, code } = await login(b.merchantId, email);
  const verify = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code } });
  assert.equal(verify.statusCode, 200, verify.body);
  const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });
  assert.equal(me.json().merchant.id, b.merchantId);
  assert.notEqual(me.json().merchant.id, a.merchantId);
});

test("parallel OTP guesses cannot exceed the attempt limit", async () => {
  const { merchantId, email } = await signup("race");
  const { cookie, code } = await login(merchantId, email);
  const bad = wrongCode(code);
  const results = await Promise.all(
    Array.from({ length: 40 }, () =>
      app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code: bad } }),
    ),
  );
  const evaluated = results.filter((r) => r.statusCode === 401 && r.json().error === "invalid_code").length;
  assert.ok(evaluated <= config.otpMaxAttempts, `${evaluated} guesses were evaluated, the limit is ${config.otpMaxAttempts}`);
  const row = await pool.query<{ attempt_count: number }>(
    `SELECT oc.attempt_count FROM otp_challenges oc JOIN sessions s ON s.otp_challenge_id = oc.id WHERE s.token_hash = encode(sha256($1::bytea), 'hex')`,
    [cookie.split("=")[1]],
  );
  if (row.rows[0]) assert.ok(row.rows[0].attempt_count <= config.otpMaxAttempts);
});

test("resending the OTP does not reset the guess budget", async () => {
  const { merchantId, email } = await signup("resend");
  const { cookie, code } = await login(merchantId, email);
  for (let i = 0; i < 3; i += 1) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code: wrongCode(code) } });
    assert.equal(r.statusCode, 401, r.body);
  }
  await pool.query(`UPDATE otp_challenges SET created_at = now() - interval '5 minutes' WHERE consumed_at IS NULL AND attempt_count = 3`);
  const resend = await app.inject({ method: "POST", url: "/v1/auth/otp/resend", headers: { cookie } });
  assert.equal(resend.statusCode, 200, resend.body);
  const fresh = (resend.json() as { devOtpCode: string }).devOtpCode;
  // Only 2 of the 5 guesses are left, so 3 wrong guesses must hit the limit.
  const statuses: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code: wrongCode(fresh) } });
    statuses.push(r.statusCode);
  }
  assert.deepEqual(statuses.slice(0, 2), [401, 401], "first two guesses are evaluated");
  assert.equal(statuses[2], 429, `third guess after the resend should be refused, got ${statuses}`);
});

test("a correct code is accepted exactly once", async () => {
  const { merchantId, email } = await signup("once");
  const { cookie, code } = await login(merchantId, email);
  const first = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code } });
  assert.equal(first.statusCode, 200, first.body);
  const second = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code } });
  assert.notEqual(second.statusCode, 200, "the same OTP must not verify twice");
});

test("OTP codes and link tokens never use Math.random", () => {
  const original = Math.random;
  Math.random = () => {
    throw new Error("Math.random must not be used for secrets");
  };
  try {
    const code = randomDigits(6);
    assert.match(code, /^\d{6}$/);
    const token = randomFromAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 22);
    assert.match(token, /^[A-Z2-9]{22}$/);
  } finally {
    Math.random = original;
  }
});

test("production refuses to start with the OTP-in-response flag on", () => {
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: databaseUrl,
        NODE_ENV: "production",
        OTP_DEV_EXPOSE: "true",
        INTERNAL_API_TOKEN: "x",
        SETTLEMENT_INTERNAL_TOKEN: "prod-token",
        ACQUIRER_CALLBACK_SIGNING_SECRET: "prod-secret",
        WEBHOOK_SECRET_ENCRYPTION_KEY: WEBHOOK_KEY,
      }),
    /OTP_DEV_EXPOSE/,
  );
});
