-- Kids profiles: an age limit per profile, an age rating per title.
ALTER TABLE "User" ADD COLUMN "maxAge" INTEGER;
ALTER TABLE "MediaItem" ADD COLUMN "ageRating" INTEGER;
ALTER TABLE "MediaItem" ADD COLUMN "certification" TEXT;
