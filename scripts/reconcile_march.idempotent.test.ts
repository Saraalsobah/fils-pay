import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "pg";
import { postResidueCorrection, sweepEntryGroupId } from "./reconcile_march.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("reconcile_march.idempotent.test.ts requires DATABASE_URL (migrated Postgres)");

test("the group id is stable per merchant+month and a valid UUID", () => {
  const a = sweepEntryGroupId(2026, 3, "11111111-1111-1111-1111-111111111111");
  assert.equal(a, sweepEntryGroupId(2026, 3, "11111111-1111-1111-1111-111111111111"));
  assert.notEqual(a, sweepEntryGroupId(2026, 3, "22222222-2222-2222-2222-222222222222"));
  assert.notEqual(a, sweepEntryGroupId(2026, 4, "11111111-1111-1111-1111-111111111111"));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

// Running the sweep twice used to write the residue off twice (random entry_group_id each run).
test("running the sweep twice posts the write-off once", async () => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const m = await client.query<{ id: string }>(
      `INSERT INTO merchants (display_name, mdr_bps) VALUES ('Sweep Idempotency Test', 250) RETURNING id`,
    );
    const merchantId = m.rows[0]!.id;
    const merchant = { merchantId, lineCount: 3, residueFils: 17 };
    for (let run = 0; run < 2; run++) {
      await client.query("BEGIN");
      const posted = await postResidueCorrection(client, merchant, new Date());
      await client.query("COMMIT");
      assert.equal(posted, run === 0, `run ${run + 1} posted=${posted}`);
    }
    const rows = await client.query<{ n: string; total: string }>(
      `SELECT count(*)::text AS n, COALESCE(sum(amount_fils) FILTER (WHERE direction='debit'),0)::text AS total
         FROM ledger_entries WHERE merchant_id = $1`,
      [merchantId],
    );
    assert.equal(rows.rows[0]!.n, "2");
    assert.equal(rows.rows[0]!.total, "17");
  } finally {
    await client.end();
  }
});
