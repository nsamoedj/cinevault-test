-- Theme music: the intro of one of a show's episodes, chosen by an admin or not.
ALTER TABLE "MediaItem" ADD COLUMN "themeFileId" UUID,
ADD COLUMN "themeOff" BOOLEAN NOT NULL DEFAULT false;
