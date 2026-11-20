-- The calendar: a secret link per person, and the air dates of shows' episodes.
ALTER TABLE "User" ADD COLUMN "calendarToken" TEXT;
CREATE UNIQUE INDEX "User_calendarToken_key" ON "User"("calendarToken");

CREATE TABLE "ScheduledEpisode" (
    "id" UUID NOT NULL,
    "mediaItemId" UUID NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "episodeNumber" INTEGER NOT NULL,
    "title" TEXT,
    "overview" TEXT,
    "airDate" DATE NOT NULL,

    CONSTRAINT "ScheduledEpisode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScheduledEpisode_mediaItemId_seasonNumber_episodeNumber_key" ON "ScheduledEpisode"("mediaItemId", "seasonNumber", "episodeNumber");
CREATE INDEX "ScheduledEpisode_airDate_idx" ON "ScheduledEpisode"("airDate");

ALTER TABLE "ScheduledEpisode" ADD CONSTRAINT "ScheduledEpisode_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "MediaItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
