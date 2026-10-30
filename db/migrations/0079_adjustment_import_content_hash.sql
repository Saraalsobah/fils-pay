-- The same CSV could be uploaded and applied any number of times: nothing identified an upload
-- (original_filename is not unique, and the code comment saying it blocked re-uploads was wrong).
-- content_sha256 is a hash of the normalised rows; the unique index makes "already applied" an
-- atomic database fact, including for two concurrent uploads. Nullable so historical imports
-- (no hash recorded) are unaffected; NULLs never collide in a unique index.
ALTER TABLE adjustment_imports ADD COLUMN content_sha256 TEXT;
CREATE UNIQUE INDEX uq_adjustment_imports_content_sha256
    ON adjustment_imports (content_sha256) WHERE content_sha256 IS NOT NULL;
