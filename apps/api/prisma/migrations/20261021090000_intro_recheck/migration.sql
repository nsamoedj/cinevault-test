-- Look again where nothing was found: an episode searched before its
-- neighbours were there (the first of a new show) found no intro, and the
-- recap search now also looks at the whole episode before and the two before
-- that. Fingerprints are cached, so this mostly costs comparing.
UPDATE "MediaFile" SET "introCheckedAt" = NULL
  WHERE "introSource" IS NULL AND "introCheckedAt" IS NOT NULL;
UPDATE "MediaFile" SET "creditsCheckedAt" = NULL
  WHERE "creditsSource" IS NULL AND "creditsCheckedAt" IS NOT NULL;
UPDATE "MediaFile"
  SET "recapCheckedAt" = NULL, "recapStartMs" = NULL, "recapEndMs" = NULL, "recapSource" = NULL
  WHERE "recapSource" IS NULL OR "recapSource" = 'audio';
