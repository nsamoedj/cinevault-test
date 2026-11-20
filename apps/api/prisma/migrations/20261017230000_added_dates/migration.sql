-- "Recent toegevoegd" and "Nieuwe releases": when files arrived, and release dates.
ALTER TABLE "MediaFile" ADD COLUMN "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "MediaItem" ADD COLUMN "addedAt" TIMESTAMP(3),
ADD COLUMN "releaseDate" DATE;

-- The first scan saw every file at once: the file's mtime says when it really came.
UPDATE "MediaFile" SET "addedAt" = LEAST("createdAt", "modifiedAt");

UPDATE "MediaItem" i SET "addedAt" = latest.at
FROM (
  SELECT coalesce(f."mediaItemId", s."mediaItemId") AS id, max(f."addedAt") AS at
  FROM "MediaFile" f
  LEFT JOIN "Episode" e ON e.id = f."episodeId"
  LEFT JOIN "Season" s ON s.id = e."seasonId"
  GROUP BY 1
) latest
WHERE latest.id = i.id;

CREATE INDEX "MediaFile_addedAt_idx" ON "MediaFile"("addedAt");
CREATE INDEX "MediaItem_addedAt_idx" ON "MediaItem"("addedAt");
