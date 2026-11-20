-- The audio and subtitles a profile chose for a show, for all its episodes.
CREATE TABLE "TrackPreference" (
    "userId" UUID NOT NULL,
    "mediaItemId" UUID NOT NULL,
    "audioLanguage" TEXT,
    "subtitle" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackPreference_pkey" PRIMARY KEY ("userId","mediaItemId")
);

ALTER TABLE "TrackPreference" ADD CONSTRAINT "TrackPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrackPreference" ADD CONSTRAINT "TrackPreference_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "MediaItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
