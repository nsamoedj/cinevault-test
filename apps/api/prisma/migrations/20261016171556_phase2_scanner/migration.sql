/*
  Warnings:

  - You are about to drop the column `hdr` on the `MediaFile` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "MetadataStatus" AS ENUM ('PENDING', 'MATCHED', 'UNMATCHED', 'FAILED');

-- AlterEnum
ALTER TYPE "LibraryType" ADD VALUE 'ANIME';

-- AlterTable
ALTER TABLE "Episode" ADD COLUMN     "absoluteNumber" INTEGER,
ADD COLUMN     "runtimeMinutes" INTEGER;

-- AlterTable
ALTER TABLE "MediaFile" DROP COLUMN "hdr",
ADD COLUMN     "hdrFormat" TEXT,
ADD COLUMN     "probeError" TEXT,
ADD COLUMN     "probedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MediaItem" ADD COLUMN     "cast" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "genres" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "metadataError" TEXT,
ADD COLUMN     "metadataProvider" TEXT,
ADD COLUMN     "metadataStatus" "MetadataStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "metadataUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "rating" DOUBLE PRECISION,
ADD COLUMN     "runtimeMinutes" INTEGER,
ADD COLUMN     "status" TEXT,
ADD COLUMN     "tvdbId" INTEGER;

-- CreateIndex
CREATE INDEX "MediaItem_metadataStatus_idx" ON "MediaItem"("metadataStatus");
