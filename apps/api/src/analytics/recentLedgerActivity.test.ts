import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { getRecentLedgerActivity } from "./query.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("recentLedgerActivity.test.ts requires DATABASE_URL (migrated Postgres)");
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(async () => {
  await pool.end();
});

// The day filter was rewritten from a per-row `(occurred_at AT TIME ZONE ..)::date BETWEEN` (which
// could not use the (merchant_id, occurred_at) index) to a plain time range. These pin the
// Bahrain day boundaries so the rewrite cannot shift which rows a day includes.
test("from/to are Bahrain calendar days: [from 00:00, to+1 00:00) at UTC+3", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ('ledger day bounds', 250) RETURNING id`,
  );
  const merchantId = m.rows[0]!.id;
  const stamps: Record<string, string> = {
    beforeStart: "2026-03-09T20:59:59Z", // 23:59:59 Bahrain on Mar 9: excluded
    startInclusive: "2026-03-09T21:00:00Z", // 00:00:00 Bahrain on Mar 10: included
    endLastSecond: "2026-03-10T20:59:59Z", // 23:59:59 Bahrain on Mar 10: included
    afterEnd: "2026-03-10T21:00:00Z", // 00:00:00 Bahrain on Mar 11: excluded
  };
  for (const [name, at] of Object.entries(stamps)) {
    const g = randomUUID();
    await pool.query(
      `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description) VALUES
         ($1,$2,'merchant_payable','debit',5,$3,$4), ($1,$2,'platform_cash','credit',5,$3,$4)`,
      [g, merchantId, at, name],
    );
  }
  const res = await getRecentLedgerActivity(pool, { merchantId, from: "2026-03-10", to: "2026-03-10" });
  const names = new Set(res.points.map((p) => p.description));
  assert.deepEqual([...names].sort(), ["endLastSecond", "startInclusive"]);
});
