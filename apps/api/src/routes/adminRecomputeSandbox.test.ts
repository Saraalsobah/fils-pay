/**
 * "Recompute transaction statuses" is a status backfill. It must never change
 * whether a merchant is a sandbox (test_mode) merchant, because test_mode is what
 * keeps their activity out of real settlement.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("adminRecomputeSandbox.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

async function financeAdminCookie(): Promise<string> {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'x', 'T', 'finance') RETURNING id`,
    [`fin-${randomUUID()}@admin.test`],
  );
  const raw = randomUUID();
  await pool.query(
    `INSERT INTO admin_sessions (admin_user_id, token_hash, authenticated, authenticated_at, expires_at)
     VALUES ($1, $2, true, now(), now() + interval '1 hour')`,
    [u.rows[0]!.id, createHash("sha256").update(raw).digest("hex")],
  );
  return `${config.adminCookieName}=${raw}`;
}

test("recomputing statuses does not take a sandbox merchant out of test_mode", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, test_mode) VALUES ($1, 250, true) RETURNING id`,
    [`Sandbox ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  // one captured, fully-settled-looking transaction so the recompute scans something and no
  // authorization is open (the condition that used to flip the flag)
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', 5000, 5000, $2)`,
    [merchantId, `acq_${randomUUID()}`],
  );

  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/transactions/recompute-statuses`,
    headers: { cookie: await financeAdminCookie() },
  });
  assert.equal(res.statusCode, 200, res.body);

  const row = await pool.query<{ test_mode: boolean }>(`SELECT test_mode FROM merchants WHERE id = $1`, [merchantId]);
  assert.equal(row.rows[0]!.test_mode, true, "a status recompute must not switch a sandbox merchant into live settlement");
});
