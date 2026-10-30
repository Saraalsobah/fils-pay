-- scheme_export_lines.amount was computed from the untruncated gross as a float and rounded by
-- NUMERIC(10,2), so it could differ from amount_fils by 0.01 BD (4,747 fils -> 4.75 vs 4.74).
-- amount_fils is the truncated figure the scheme file is defined by; make amount agree.
UPDATE scheme_export_lines SET amount = amount_fils::numeric / 1000 WHERE amount <> amount_fils::numeric / 1000;
