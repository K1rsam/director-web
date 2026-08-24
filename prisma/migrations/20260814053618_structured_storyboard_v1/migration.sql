-- CreateTable
CREATE TABLE "ScriptScene" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "episodeId" TEXT NOT NULL,
    "sceneKey" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "heading" TEXT,
    "location" TEXT,
    "interiorExterior" TEXT,
    "timeOfDay" TEXT,
    "weather" TEXT,
    "timeLayer" TEXT NOT NULL DEFAULT '现实',
    "sourceText" TEXT NOT NULL,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "revision" TEXT NOT NULL DEFAULT 'V1',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ScriptScene_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StoryboardShot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "episodeId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "shotKey" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "duration" REAL NOT NULL,
    "timeLayer" TEXT NOT NULL DEFAULT '现实',
    "sourceNodeRefs" TEXT NOT NULL DEFAULT '[]',
    "dialogue" TEXT NOT NULL DEFAULT '[]',
    "e1Data" TEXT NOT NULL DEFAULT '{}',
    "e2Data" TEXT NOT NULL DEFAULT '{}',
    "e3Data" TEXT NOT NULL DEFAULT '{}',
    "e4Data" TEXT NOT NULL DEFAULT '{}',
    "revision" TEXT NOT NULL DEFAULT 'V1',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoryboardShot_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StoryboardShot_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "ScriptScene" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SeedanceUnit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "episodeId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "unitKey" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "duration" REAL NOT NULL,
    "shortUnitReason" TEXT,
    "dominantGoal" TEXT,
    "startPremise" TEXT NOT NULL,
    "endState" TEXT NOT NULL,
    "data" TEXT NOT NULL DEFAULT '{}',
    "revision" TEXT NOT NULL DEFAULT 'V1',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SeedanceUnit_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SeedanceUnit_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "ScriptScene" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SeedanceUnitShot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "unitId" TEXT NOT NULL,
    "shotId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    CONSTRAINT "SeedanceUnitShot_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "SeedanceUnit" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SeedanceUnitShot_shotId_fkey" FOREIGN KEY ("shotId") REFERENCES "StoryboardShot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CompiledPromptVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "unitId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "syncStatus" TEXT NOT NULL DEFAULT 'DRAFT_COMPILED',
    "selectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompiledPromptVersion_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "SeedanceUnit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowIssue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "shotId" TEXT,
    "unitId" TEXT,
    "coordinate" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "ownerRole" TEXT NOT NULL,
    "expected" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "requestedEffect" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkflowIssue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkflowIssue_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkflowIssue_shotId_fkey" FOREIGN KEY ("shotId") REFERENCES "StoryboardShot" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "WorkflowIssue_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "SeedanceUnit" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PipelineRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "episodeId" TEXT,
    "stageCode" TEXT NOT NULL,
    "roleName" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'CLI',
    "model" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "inputSummary" TEXT,
    "outputSummary" TEXT,
    "log" TEXT,
    "error" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PipelineRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PipelineRun_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "style" TEXT,
    "aspectRatio" TEXT NOT NULL DEFAULT '16:9',
    "executionMode" TEXT NOT NULL DEFAULT 'CLI',
    "ruleVersion" TEXT NOT NULL DEFAULT 'TASK_SCHEMA_V4',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Project" ("createdAt", "description", "id", "ruleVersion", "style", "title", "updatedAt") SELECT "createdAt", "description", "id", "ruleVersion", "style", "title", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ScriptScene_episodeId_sortOrder_idx" ON "ScriptScene"("episodeId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ScriptScene_episodeId_sceneKey_key" ON "ScriptScene"("episodeId", "sceneKey");

-- CreateIndex
CREATE INDEX "StoryboardShot_sceneId_sortOrder_idx" ON "StoryboardShot"("sceneId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "StoryboardShot_episodeId_shotKey_key" ON "StoryboardShot"("episodeId", "shotKey");

-- CreateIndex
CREATE INDEX "SeedanceUnit_sceneId_sortOrder_idx" ON "SeedanceUnit"("sceneId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "SeedanceUnit_episodeId_unitKey_key" ON "SeedanceUnit"("episodeId", "unitKey");

-- CreateIndex
CREATE INDEX "SeedanceUnitShot_unitId_sortOrder_idx" ON "SeedanceUnitShot"("unitId", "sortOrder");

-- CreateIndex
CREATE INDEX "SeedanceUnitShot_shotId_idx" ON "SeedanceUnitShot"("shotId");

-- CreateIndex
CREATE UNIQUE INDEX "SeedanceUnitShot_unitId_shotId_key" ON "SeedanceUnitShot"("unitId", "shotId");

-- CreateIndex
CREATE INDEX "CompiledPromptVersion_unitId_selectedAt_idx" ON "CompiledPromptVersion"("unitId", "selectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CompiledPromptVersion_unitId_version_key" ON "CompiledPromptVersion"("unitId", "version");

-- CreateIndex
CREATE INDEX "WorkflowIssue_episodeId_status_idx" ON "WorkflowIssue"("episodeId", "status");

-- CreateIndex
CREATE INDEX "WorkflowIssue_shotId_idx" ON "WorkflowIssue"("shotId");

-- CreateIndex
CREATE INDEX "WorkflowIssue_unitId_idx" ON "WorkflowIssue"("unitId");

-- CreateIndex
CREATE INDEX "PipelineRun_projectId_createdAt_idx" ON "PipelineRun"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "PipelineRun_episodeId_stageCode_idx" ON "PipelineRun"("episodeId", "stageCode");
