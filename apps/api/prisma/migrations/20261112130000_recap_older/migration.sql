-- Look again for the recaps that weren't found (2026-11-12): a recap may now
-- show older episodes too (up to 12 back, from what is in CACHE_DIR/intro
-- already), clips from 1.5 s, and clips from many places that cover less of
-- it (narration in between). Mostly from the cache: little is read again.
UPDATE "MediaFile" SET "recapCheckedAt" = NULL
  WHERE "episodeId" IS NOT NULL AND "recapSource" IS NULL AND "recapCheckedAt" IS NOT NULL;
