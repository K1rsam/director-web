CREATE TABLE "CliRoleSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
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

CREATE UNIQUE INDEX "CliRoleSession_projectId_stageCode_key" ON "CliRoleSession"("projectId", "stageCode");
CREATE INDEX "CliRoleSession_projectId_idx" ON "CliRoleSession"("projectId");
