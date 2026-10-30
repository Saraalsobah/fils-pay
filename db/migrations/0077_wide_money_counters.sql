-- Two running money totals were too narrow.
--
-- platform_stats.total_processed_fils was INTEGER (32-bit, max 2,147,483,647 fils =
-- 2.1M BD) while the volume-tier threshold is 2,000,000,000. The migration comment
-- "INTEGER in PostgreSQL is 64-bit" is wrong. Past the max the Go side wrapped the
-- value negative, silently switching the platform-wide MDR bonus back off.
ALTER TABLE platform_stats ALTER COLUMN total_processed_fils TYPE BIGINT;

-- merchants.lifetime_net_payout_monitoring_estimate was REAL (float32): not exact above
-- 16,777,216 fils (16,777 BD), so adding a small payout to a big total was rounded away.
-- Money totals are integer fils. Re-derive the exact value from the paid batches.
ALTER TABLE merchants
    ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT
    USING round(lifetime_net_payout_monitoring_estimate)::bigint;
ALTER TABLE merchants ALTER COLUMN lifetime_net_payout_monitoring_estimate SET DEFAULT 0;

UPDATE merchants m
   SET lifetime_net_payout_monitoring_estimate = COALESCE((
         SELECT SUM(sb.net_payout_fils) FROM settlement_batches sb
          WHERE sb.merchant_id = m.id AND sb.status = 'paid'), 0);
