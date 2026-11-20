-- Requests for a part of a show (seasons, episodes): more than one request per show.

-- DropIndex
DROP INDEX "MediaRequest_kind_tmdbId_key";

-- AlterTable
ALTER TABLE "MediaRequest" ADD COLUMN     "episodes" JSONB,
ADD COLUMN     "seasons" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- CreateIndex
CREATE INDEX "MediaRequest_kind_tmdbId_idx" ON "MediaRequest"("kind", "tmdbId");

