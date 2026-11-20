-- Skip Recap: where an episode's "Previously on…" is.
ALTER TABLE "MediaFile" ADD COLUMN "recapStartMs" INTEGER,
ADD COLUMN "recapEndMs" INTEGER,
ADD COLUMN "recapSource" TEXT,
ADD COLUMN "recapCheckedAt" TIMESTAMP(3);
