-- AlterTable
ALTER TABLE "Subtitle" ALTER COLUMN "externalId" SET NOT NULL,
ALTER COLUMN "path" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Subtitle_mediaFileId_source_externalId_key" ON "Subtitle"("mediaFileId", "source", "externalId");

