import type { Pool } from "pg";

/**
 * effectiveFrom: when the rate starts applying. createdAt: when it was
 * keyed in. The display returns the latest row whose effectiveFrom is not
 * in the future.
 */
export interface CurrentFeeScheduleDisplay {
  mdrBps: number;
  effectiveFrom: Date;
  createdAt: Date;
}

/**
 * Fetches the rate currently in effect for a merchant, for display on the admin
 * merchant-detail page. It MUST pick the same row billing does (feeSchedule.ts):
 * the newest row whose effective_from has arrived, ties broken by created_at.
 *
 * It used to order by created_at alone ("most recently agreed"). A backdated
 * correction entered later (e.g. 245 bps for March onward, keyed in on Aug 15, after the
 * Aug 1 renegotiation to 225 bps) then displayed as the current rate while every capture and
 * settlement was actually charging 225, so support told merchants the wrong rate. A row whose
 * effective_from is in the future is also not "current" yet.
 */
export async function getCurrentFeeScheduleForDisplay(
  pool: Pool,
  merchantId: string,
): Promise<CurrentFeeScheduleDisplay | null> {
  const result = await pool.query<{ mdr_bps: number; effective_from: Date; created_at: Date }>(
    `SELECT mdr_bps, effective_from, created_at
       FROM fee_schedules
      WHERE merchant_id = $1 AND effective_from <= now()
      ORDER BY effective_from DESC, created_at DESC
      LIMIT 1`,
    [merchantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { mdrBps: row.mdr_bps, effectiveFrom: row.effective_from, createdAt: row.created_at };
}
