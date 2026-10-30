-- Duplicate settlement.paid (incident 2026-08-21) had two causes the postmortem missed:
--  1. two overlapping scans both enqueued the event (the "unique index" a code
--     comment relied on never existed), and
--  2. the payout disbursement record is written once per webhook DELIVERY, so a
--     second endpoint or a replay wrote another one.
-- Enforce "once per batch" in the database for both.

-- Remove extra settlement.paid events that were never delivered anywhere (keep the earliest).
DELETE FROM outbox_events a
 USING outbox_events b
 WHERE a.event_type = 'settlement.paid' AND b.event_type = 'settlement.paid'
   AND a.aggregate_id = b.aggregate_id AND a.id > b.id
   AND NOT EXISTS (SELECT 1 FROM webhook_deliveries wd WHERE wd.outbox_event_id = a.id);

CREATE UNIQUE INDEX uq_outbox_settlement_paid_once
    ON outbox_events (aggregate_id) WHERE event_type = 'settlement.paid';

DELETE FROM settlement_payout_disbursements a
 USING settlement_payout_disbursements b
 WHERE a.settlement_batch_id = b.settlement_batch_id
   AND (a.created_at, a.id) > (b.created_at, b.id);

CREATE UNIQUE INDEX uq_settlement_payout_disbursements_batch
    ON settlement_payout_disbursements (settlement_batch_id);
