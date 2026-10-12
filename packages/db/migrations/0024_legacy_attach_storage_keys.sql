-- The files the old system brought into the library were recorded with the
-- public prefix in their storage key — `uploads/attach/2026/09/20260915/<hash>.jpg`
-- for the file at `<UPLOADS_DIR>/attach/2026/09/20260915/<hash>.jpg`, served as
-- `/uploads/attach/…`. The local driver resolves a key under UPLOADS_DIR, so it
-- looked in `<UPLOADS_DIR>/uploads/attach/…`, where nothing is: no thumbnail
-- could be written for them and the orphan sweep could not remove one.
--
-- Data only, no schema change. A row changes only when its URL already is
-- `/uploads/` + the corrected key, and no other row holds that key, so what a
-- shopper loads does not move. A fresh database and a second run match nothing.
UPDATE "attachments" AS a
SET "storage_key" = substr(a."storage_key", length('uploads/') + 1)
WHERE a."driver" = 'local'
  AND a."storage_key" LIKE 'uploads/attach/%'
  AND a."url" = '/uploads/' || substr(a."storage_key", length('uploads/') + 1)
  AND NOT EXISTS (
    SELECT 1 FROM "attachments" AS b
    WHERE b."storage_key" = substr(a."storage_key", length('uploads/') + 1)
  );
