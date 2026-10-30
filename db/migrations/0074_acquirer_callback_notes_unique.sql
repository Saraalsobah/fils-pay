-- FP-201: acquirer callbacks must be recorded once per callback_id. The comment in
-- 0051 says a unique index was added (FP-238) but it never existed, and
-- processed_events does not exist either. Drop existing duplicate rows (keep the
-- earliest) so the index can be created, then enforce it.
DELETE FROM acquirer_callback_notes a
 USING acquirer_callback_notes b
 WHERE a.callback_id = b.callback_id
   AND (a.created_at, a.id) > (b.created_at, b.id);

CREATE UNIQUE INDEX uq_acquirer_callback_notes_callback_id
    ON acquirer_callback_notes (callback_id);
