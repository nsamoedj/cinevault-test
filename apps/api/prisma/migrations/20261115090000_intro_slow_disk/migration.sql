-- Look again where nothing was found (2026-11-15): a read of a big file (a
-- 4K remux on a busy disk) was given up after a guessed time (about 3
-- minutes), and that episode was then marked as having no intro or credits.
-- The transcoder now says how far it read, and the API waits while it reads
-- on. Fingerprints that were read are in CACHE_DIR/intro already; only the
-- ones given up are read again.
UPDATE "MediaFile" SET "recapCheckedAt" = NULL
  WHERE "episodeId" IS NOT NULL AND "recapSource" IS NULL AND "recapCheckedAt" IS NOT NULL
    AND "introSource" IS NULL AND "introCheckedAt" IS NOT NULL;
UPDATE "MediaFile" SET "introCheckedAt" = NULL
  WHERE "episodeId" IS NOT NULL AND "introSource" IS NULL AND "introCheckedAt" IS NOT NULL;
UPDATE "MediaFile" SET "creditsCheckedAt" = NULL
  WHERE "episodeId" IS NOT NULL AND "creditsSource" IS NULL AND "creditsCheckedAt" IS NOT NULL;
