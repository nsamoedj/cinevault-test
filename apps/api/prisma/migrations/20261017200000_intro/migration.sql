-- Skip Intro: where each episode's intro is, and whether it was looked for.
ALTER TABLE "MediaFile" ADD COLUMN "introStartMs" INTEGER,
ADD COLUMN "introEndMs" INTEGER,
ADD COLUMN "introSource" TEXT,
ADD COLUMN "introCheckedAt" TIMESTAMP(3);
