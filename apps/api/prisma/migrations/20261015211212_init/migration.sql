-- Trigram matching for fuzzy title search (MediaItem_title_trgm_idx)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "LibraryType" AS ENUM ('MOVIES', 'SHOWS');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('MOVIE', 'SHOW');

-- CreateEnum
CREATE TYPE "SubtitleSource" AS ENUM ('EMBEDDED', 'EXTERNAL', 'OPENSUBTITLES', 'WHISPER');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Library" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LibraryType" NOT NULL,
    "path" TEXT NOT NULL,
    "lastScannedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Library_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaItem" (
    "id" UUID NOT NULL,
    "libraryId" UUID NOT NULL,
    "type" "MediaType" NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sortTitle" TEXT NOT NULL,
    "originalTitle" TEXT,
    "year" INTEGER,
    "overview" TEXT,
    "tagline" TEXT,
    "posterPath" TEXT,
    "backdropPath" TEXT,
    "tmdbId" INTEGER,
    "tvmazeId" INTEGER,
    "imdbId" TEXT,
    "matchLocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Season" (
    "id" UUID NOT NULL,
    "mediaItemId" UUID NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "title" TEXT,
    "overview" TEXT,
    "posterPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Episode" (
    "id" UUID NOT NULL,
    "seasonId" UUID NOT NULL,
    "episodeNumber" INTEGER NOT NULL,
    "title" TEXT,
    "overview" TEXT,
    "airDate" DATE,
    "stillPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Episode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaFile" (
    "id" UUID NOT NULL,
    "mediaItemId" UUID,
    "episodeId" UUID,
    "path" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "modifiedAt" TIMESTAMP(3) NOT NULL,
    "container" TEXT,
    "videoCodec" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "bitDepth" INTEGER,
    "hdr" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER,
    "bitrate" INTEGER,
    "audioTracks" JSONB NOT NULL DEFAULT '[]',
    "subtitleTracks" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subtitle" (
    "id" UUID NOT NULL,
    "mediaFileId" UUID NOT NULL,
    "language" TEXT NOT NULL,
    "label" TEXT,
    "source" "SubtitleSource" NOT NULL,
    "streamIndex" INTEGER,
    "externalId" TEXT,
    "path" TEXT NOT NULL,
    "offsetMs" INTEGER NOT NULL DEFAULT 0,
    "forced" BOOLEAN NOT NULL DEFAULT false,
    "hearingImpaired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subtitle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchProgress" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "mediaFileId" UUID NOT NULL,
    "positionMs" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Library_path_key" ON "Library"("path");

-- CreateIndex
CREATE INDEX "MediaItem_type_idx" ON "MediaItem"("type");

-- CreateIndex
CREATE INDEX "MediaItem_tmdbId_idx" ON "MediaItem"("tmdbId");

-- CreateIndex
CREATE INDEX "MediaItem_title_trgm_idx" ON "MediaItem" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "MediaItem_libraryId_path_key" ON "MediaItem"("libraryId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "Season_mediaItemId_seasonNumber_key" ON "Season"("mediaItemId", "seasonNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Episode_seasonId_episodeNumber_key" ON "Episode"("seasonId", "episodeNumber");

-- CreateIndex
CREATE UNIQUE INDEX "MediaFile_path_key" ON "MediaFile"("path");

-- CreateIndex
CREATE INDEX "MediaFile_mediaItemId_idx" ON "MediaFile"("mediaItemId");

-- CreateIndex
CREATE INDEX "MediaFile_episodeId_idx" ON "MediaFile"("episodeId");

-- CreateIndex
CREATE INDEX "Subtitle_mediaFileId_idx" ON "Subtitle"("mediaFileId");

-- CreateIndex
CREATE INDEX "WatchProgress_userId_updatedAt_idx" ON "WatchProgress"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WatchProgress_userId_mediaFileId_key" ON "WatchProgress"("userId", "mediaFileId");

-- AddForeignKey
ALTER TABLE "MediaItem" ADD CONSTRAINT "MediaItem_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "Library"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Season" ADD CONSTRAINT "Season_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "MediaItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaFile" ADD CONSTRAINT "MediaFile_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "MediaItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaFile" ADD CONSTRAINT "MediaFile_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subtitle" ADD CONSTRAINT "Subtitle_mediaFileId_fkey" FOREIGN KEY ("mediaFileId") REFERENCES "MediaFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchProgress" ADD CONSTRAINT "WatchProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchProgress" ADD CONSTRAINT "WatchProgress_mediaFileId_fkey" FOREIGN KEY ("mediaFileId") REFERENCES "MediaFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
