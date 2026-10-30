-- Refunds netted into a settlement batch (FP-300).
--
-- gross_fils / fee_fils keep meaning "what was captured in the batch window"
-- (the scheme export file and the MDR recalculation both depend on that).
-- A refund the batch claims (refunds.settlement_batch_id, 0042) is recorded
-- beside them instead:
--
--   net_payout_fils = gross_fils - fee_fils - refunds_fils + refund_fee_reversed_fils
--
-- refunds_fils            sum of the claimed refunds' amount_fils
-- refund_fee_reversed_fils sum of the MDR those refunds gave back to the merchant
ALTER TABLE settlement_batches
    ADD COLUMN refunds_fils             BIGINT NOT NULL DEFAULT 0 CHECK (refunds_fils >= 0),
    ADD COLUMN refund_fee_reversed_fils BIGINT NOT NULL DEFAULT 0 CHECK (refund_fee_reversed_fils >= 0);
