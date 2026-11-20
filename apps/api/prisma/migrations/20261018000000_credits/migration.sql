-- End credits: where they start and end in each episode, and whether they were looked for.
ALTER TABLE "MediaFile" ADD COLUMN "creditsStartMs" INTEGER,
ADD COLUMN "creditsEndMs" INTEGER,
ADD COLUMN "creditsSource" TEXT,
ADD COLUMN "creditsCheckedAt" TIMESTAMP(3);
