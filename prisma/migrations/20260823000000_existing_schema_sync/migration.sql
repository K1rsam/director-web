-- Record schema changes that already exist in the development database but were
-- previously created with `prisma db push` instead of a checked-in migration.

ALTER TABLE "Project" ADD COLUMN "archivedAt" DATETIME;

CREATE TABLE "PresentationContract" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "episodeId" TEXT,
    "category" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" TEXT NOT NULL,
    "evidence" TEXT,
    "userAnswer" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "round" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PresentationContract_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PresentationContract_projectId_status_idx" ON "PresentationContract"("projectId", "status");

CREATE TABLE "ApiRoleSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL DEFAULT '',
    "stageCode" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "messages" TEXT NOT NULL,
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "inputChars" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApiRoleSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ApiRoleSession_projectId_episodeId_idx" ON "ApiRoleSession"("projectId", "episodeId");
CREATE UNIQUE INDEX "ApiRoleSession_projectId_episodeId_stageCode_key" ON "ApiRoleSession"("projectId", "episodeId", "stageCode");

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_CliRoleSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL DEFAULT '',
    "stageCode" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "reasoningEffort" TEXT NOT NULL,
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "inputChars" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CliRoleSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_CliRoleSession" (
    "createdAt", "id", "inputChars", "model", "projectId",
    "reasoningEffort", "sessionId", "stageCode", "turnCount", "updatedAt"
)
SELECT
    "createdAt", "id", "inputChars", "model", "projectId",
    "reasoningEffort", "sessionId", "stageCode", "turnCount", "updatedAt"
FROM "CliRoleSession";

DROP TABLE "CliRoleSession";
ALTER TABLE "new_CliRoleSession" RENAME TO "CliRoleSession";
CREATE INDEX "CliRoleSession_projectId_episodeId_idx" ON "CliRoleSession"("projectId", "episodeId");
CREATE UNIQUE INDEX "CliRoleSession_projectId_episodeId_stageCode_key" ON "CliRoleSession"("projectId", "episodeId", "stageCode");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
