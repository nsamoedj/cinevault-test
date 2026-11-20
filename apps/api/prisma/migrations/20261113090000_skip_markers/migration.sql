-- Skip markers (2026-11-13): the preview of the next episode, how sure the
-- search is of each part, and per profile what the players skip by themselves.
ALTER TABLE "MediaFile" ADD COLUMN "previewStartMs" INTEGER;
ALTER TABLE "MediaFile" ADD COLUMN "previewEndMs" INTEGER;
ALTER TABLE "MediaFile" ADD COLUMN "previewSource" TEXT;
ALTER TABLE "MediaFile" ADD COLUMN "previewCheckedAt" TIMESTAMP(3);
ALTER TABLE "MediaFile" ADD COLUMN "introConfidence" DOUBLE PRECISION;
ALTER TABLE "MediaFile" ADD COLUMN "creditsConfidence" DOUBLE PRECISION;
ALTER TABLE "MediaFile" ADD COLUMN "recapConfidence" DOUBLE PRECISION;
ALTER TABLE "MediaFile" ADD COLUMN "previewConfidence" DOUBLE PRECISION;
ALTER TABLE "User" ADD COLUMN "skipSettings" JSONB;
-- What was found before has no confidence (shown, as before); the parts the audio
-- found are looked at again, from the fingerprints in the cache, so they get one.
UPDATE "MediaFile" SET "introCheckedAt" = NULL
  WHERE "episodeId" IS NOT NULL AND "introSource" = 'audio';
UPDATE "MediaFile" SET "creditsCheckedAt" = NULL
  WHERE "episodeId" IS NOT NULL AND "creditsSource" IN ('audio', 'picture');
UPDATE "MediaFile" SET "recapCheckedAt" = NULL
  WHERE "episodeId" IS NOT NULL AND "recapSource" = 'audio';
