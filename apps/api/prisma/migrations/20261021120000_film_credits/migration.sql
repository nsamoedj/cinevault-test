-- The end credits of films, from the picture: a film can have more parts of
-- credits, with a scene between them (a mid-credits scene); the first part
-- stays in creditsStartMs/EndMs, the others are here as [{ startMs, endMs }].
ALTER TABLE "MediaFile" ADD COLUMN "creditsMore" JSONB;
