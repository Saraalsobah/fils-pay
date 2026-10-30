/**
 * A pay request whose capture outlasts the reservation timeout must not
 * result in two successful charges for one single-use link.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { createAcquirerSimulator } from "../acquirer/simulator.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { payPaymentLink } from "./pay.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("payRace.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "t",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 8 });
test.after(() => pool.end());

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a slow first payer cannot double-charge a link that a second payer re-claimed", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Race ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const link = await pool.query<{ id: string; token: string }>(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, status, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, 5000, 'active', now() + interval '1 hour', 'merchant_api_key', $3) RETURNING id, token`,
    [merchantId, `tok-${randomUUID()}`, randomUUID()],
  );

  // The FIRST capture is slow (longer than the 1 s reservation timeout); later ones are instant.
  const real = createAcquirerSimulator(config);
  let captureCalls = 0;
  const acquirer: AcquirerSimulator = {
    authorize: (r) => real.authorize(r),
    refund: (r) => real.refund(r),
    capture: async (r) => {
      captureCalls += 1;
      if (captureCalls === 1) await sleep(2_500);
      return real.capture(r);
    },
  };
  const cfg = { paymentLinkReservationTimeoutSeconds: 1 };

  const first = payPaymentLink(pool, acquirer, cfg, { token: link.rows[0]!.token, card: CARD, idempotencyKey: randomUUID() });
  await sleep(1_600); // reservation is now stale; a second customer arrives
  const second = await payPaymentLink(pool, acquirer, cfg, { token: link.rows[0]!.token, card: CARD, idempotencyKey: randomUUID() });
  const firstResult = await first;

  const results = [firstResult, second];
  const wins = results.filter((r) => r.statusCode === 200).length;
  assert.equal(wins, 1, `exactly one payer may be told "paid", got ${JSON.stringify(results.map((r) => r.statusCode))}`);

  // Money check: net captured (captured - refunded) across the merchant's transactions is ONE link amount.
  const net = await pool.query<{ net: string }>(
    `SELECT COALESCE(sum(captured_fils - refunded_fils), 0)::text AS net FROM transactions WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(net.rows[0]!.net, "5000", "the link must be charged exactly once net");

  const row = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [link.rows[0]!.id]);
  assert.equal(row.rows[0]!.status, "paid");
});
