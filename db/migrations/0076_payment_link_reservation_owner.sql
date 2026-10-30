-- Incident 2026-05-14 (payment links charged twice). The postmortem blamed duplicate
-- acquirer callbacks and ruled out the claim in pay.ts, but the claim CAN be taken
-- twice: a reservation older than the timeout is re-claimable, and the first payer's
-- authorize+capture is still running without any lock. Each claim now gets its own
-- reservation_id, and only the holder of the current reservation may finalize or
-- release the link.
ALTER TABLE payment_links ADD COLUMN reservation_id UUID;

-- A payer who loses that race has already been charged; we refund them automatically.
-- That refund is made by the system, not by a merchant user.
ALTER TABLE refunds DROP CONSTRAINT refunds_created_by_type_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_created_by_type_check
    CHECK (created_by_type IN ('merchant_session', 'merchant_api_key', 'system'));
