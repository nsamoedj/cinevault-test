-- Collecties: the TMDB collection of each film, and the collections with their parts.
ALTER TABLE "MediaItem" ADD COLUMN "collectionTmdbId" INTEGER;
ALTER TABLE "MediaItem" ADD COLUMN "collectionName" TEXT;
CREATE INDEX "MediaItem_collectionTmdbId_idx" ON "MediaItem"("collectionTmdbId");

CREATE TABLE "Collection" (
    "tmdbId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "overview" TEXT,
    "posterPath" TEXT,
    "backdropPath" TEXT,
    "parts" JSONB NOT NULL DEFAULT '[]',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("tmdbId")
);
