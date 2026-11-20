-- Look again where nothing was found. Since 2026-10-21 most fingerprint
-- requests failed before they reached the transcoder (a timeout that was no
-- whole number: AbortSignal.timeout throws a RangeError), and the episode was
-- marked as looked at with nothing found. And fingerprints are now every
-- 0.031 s instead of 0.124 s (apps/transcoder/src/fingerprint.ts): at the
-- coarse step half of all episode pairs shared too few frames. What was found
-- stays until the episode is looked at again; the old fingerprints in
-- CACHE_DIR/intro are read again, at the new step.
UPDATE "MediaFile" SET "introCheckedAt" = NULL
  WHERE "episodeId" IS NOT NULL AND "introSource" IS NULL AND "introCheckedAt" IS NOT NULL;
UPDATE "MediaFile" SET "creditsCheckedAt" = NULL
  WHERE "episodeId" IS NOT NULL AND "creditsSource" IS NULL AND "creditsCheckedAt" IS NOT NULL;
UPDATE "MediaFile" SET "recapCheckedAt" = NULL
  WHERE "episodeId" IS NOT NULL AND "recapSource" IS NULL AND "recapCheckedAt" IS NOT NULL;
