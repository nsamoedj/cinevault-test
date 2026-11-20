-- Look again where the audio found nothing (2026-11-12): the matching now
-- joins pieces of the tune that dialogue or a sound effect broke apart (up to
-- 6 s apart), no longer drops a pair of episodes whose longest shared part is
-- too long for an intro (a replayed scene), and lets the episodes vote over
-- every part they share. The fingerprints are in CACHE_DIR/intro already, so
-- this reads nothing from the disks again.
UPDATE "MediaFile" SET "introCheckedAt" = NULL
  WHERE "episodeId" IS NOT NULL AND "introSource" IS NULL AND "introCheckedAt" IS NOT NULL;
UPDATE "MediaFile" SET "creditsCheckedAt" = NULL
  WHERE "episodeId" IS NOT NULL AND "creditsSource" IS NULL AND "creditsCheckedAt" IS NOT NULL;
