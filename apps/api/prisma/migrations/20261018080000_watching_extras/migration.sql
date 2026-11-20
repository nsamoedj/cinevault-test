-- Logos, trailers, recommendations and the next episode of a show (TMDB, TVmaze),
-- and the Dolby Vision profile of a file.
ALTER TABLE "MediaItem" ADD COLUMN "logoPath" TEXT,
ADD COLUMN "trailerKey" TEXT,
ADD COLUMN "recommendedTmdbIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN "nextEpisodeSeason" INTEGER,
ADD COLUMN "nextEpisodeNumber" INTEGER,
ADD COLUMN "nextEpisodeTitle" TEXT,
ADD COLUMN "nextEpisodeAirDate" DATE;

ALTER TABLE "MediaFile" ADD COLUMN "dvProfile" INTEGER,
ADD COLUMN "dvCompatibility" INTEGER;
