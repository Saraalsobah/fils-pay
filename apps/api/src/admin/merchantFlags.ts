import type { PoolClient } from "pg";

/**
 * UNUSED, kept only so history reads clearly. This helper cleared a merchant's
 * `test_mode` flag as a side effect of the admin "recompute transaction statuses"
 * button, which silently moved sandbox merchants into live settlement. Nothing calls
 * it any more; going live must be an explicit, audited action, never a side effect.
 */
export async function reconcileSandboxFlag(
  client: PoolClient,
  merchantId: string,
  summary: { scanned: number; openAuthorizations: number },
): Promise<string[]> {
  const flagsUpdated: string[] = [];
  if (summary.scanned > 0 && summary.openAuthorizations === 0) {
    const merchantRow = await client.query<{ test_mode: boolean }>(
      `SELECT test_mode FROM merchants WHERE id = $1 FOR UPDATE`,
      [merchantId],
    );
    if (merchantRow.rows[0]?.test_mode) {
      await client.query(`UPDATE merchants SET test_mode = false WHERE id = $1`, [merchantId]);
      flagsUpdated.push("test_mode");
    }
  }
  return flagsUpdated;
}
