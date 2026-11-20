-- CreateEnum
CREATE TYPE "RequestKind" AS ENUM ('MOVIE', 'SHOW');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'APPROVED', 'AVAILABLE', 'DECLINED', 'FAILED');

-- CreateTable
CREATE TABLE "MediaRequest" (
    "id" UUID NOT NULL,
    "kind" "RequestKind" NOT NULL,
    "tmdbId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "overview" TEXT,
    "posterPath" TEXT,
    "anime" BOOLEAN NOT NULL DEFAULT false,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "availableAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaRequestUser" (
    "requestId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaRequestUser_pkey" PRIMARY KEY ("requestId","userId")
);

-- CreateIndex
CREATE INDEX "MediaRequest_status_idx" ON "MediaRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MediaRequest_kind_tmdbId_key" ON "MediaRequest"("kind", "tmdbId");

-- AddForeignKey
ALTER TABLE "MediaRequestUser" ADD CONSTRAINT "MediaRequestUser_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MediaRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaRequestUser" ADD CONSTRAINT "MediaRequestUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

