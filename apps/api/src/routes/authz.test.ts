/**
 * Authorization regressions: role gates on capture/void, tenant scoping of
 * payment-link cancel, and impersonation can never act as a writer.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { requireMerchantWriterActor } from "../auth/requireMerchantAuth.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("authz.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function merchant(label: string) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Authz ${label} ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `o-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const key = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label });
  return { merchantId, rawKey: key.rawKey };
}

/** Logged-in session cookie for a user with the given role in that merchant. */
async function sessionFor(merchantId: string, role: "owner" | "finance" | "support") {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, $3, 'x') RETURNING id`,
    [merchantId, `${role}-${randomUUID()}@example.test`, role],
  );
  const raw = randomUUID();
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, authenticated_at, expires_at)
     VALUES ($1, $2, true, now(), now() + interval '1 hour')`,
    [u.rows[0]!.id, createHash("sha256").update(raw).digest("hex")],
  );
  return `${config.cookieName}=${raw}`;
}

async function authorize(rawKey: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: 10_000, card: CARD, reference: "r" },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { id: string }).id;
}

test("a support-role user cannot capture or void; a finance user can", async () => {
  const { merchantId, rawKey } = await merchant("roles");
  const support = await sessionFor(merchantId, "support");
  const finance = await sessionFor(merchantId, "finance");
  const txn = await authorize(rawKey);

  const cap = await app.inject({ method: "POST", url: `/v1/transactions/${txn}/capture`, headers: { cookie: support, "idempotency-key": randomUUID() }, payload: {} });
  assert.equal(cap.statusCode, 403, cap.body);
  const voi = await app.inject({ method: "POST", url: `/v1/transactions/${txn}/void`, headers: { cookie: support } });
  assert.equal(voi.statusCode, 403, voi.body);

  const ok = await app.inject({ method: "POST", url: `/v1/transactions/${txn}/capture`, headers: { cookie: finance, "idempotency-key": randomUUID() }, payload: {} });
  assert.equal(ok.statusCode, 200, ok.body);
});

test("merchant A cannot cancel merchant B's payment link", async () => {
  const a = await merchant("link-a");
  const b = await merchant("link-b");
  const created = await app.inject({
    method: "POST",
    url: `/v1/merchants/${b.merchantId}/payment-links`,
    headers: { authorization: `Bearer ${b.rawKey}` },
    payload: { amountFils: 5_000, reference: "x", description: "x", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(created.statusCode, 201, created.body);
  const linkId = (created.json() as { id: string }).id;

  const res = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${a.merchantId}/payment-links/${linkId}`,
    headers: { authorization: `Bearer ${a.rawKey}` },
  });
  assert.equal(res.statusCode, 404, res.body);
  const row = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [linkId]);
  assert.equal(row.rows[0]!.status, "active", "B's link must still be active");
});

test("an admin impersonation grant can never be a writer actor", () => {
  assert.throws(() =>
    requireMerchantWriterActor({
      merchantId: randomUUID(),
      actorType: "admin_impersonation",
      actorId: randomUUID(),
      role: "finance",
    } as never),
  );
});
