CREATE TABLE IF NOT EXISTS "ApiRoleSession" (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "Asset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "episodeId" TEXT,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'needs_confirmation',
    "sourceText" TEXT,
    "notes" TEXT,
    "metadata" TEXT,
    "parentId" TEXT,
    "firstSeenNode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Asset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Asset_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Asset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "CliRoleSession" (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "CompiledPromptVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "unitId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "syncStatus" TEXT NOT NULL DEFAULT 'DRAFT_COMPILED',
    "selectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompiledPromptVersion_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "SeedanceUnit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "Episode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Episode_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "FinalScript" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "episodeId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FinalScript_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FinalScript_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "GenerationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "taskPackageId" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "prompt" TEXT,
    "output" TEXT,
    "conversationUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GenerationRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GenerationRun_taskPackageId_fkey" FOREIGN KEY ("taskPackageId") REFERENCES "TaskPackage" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "PipelineRun" (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "PresentationContract" (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "style" TEXT,
    "aspectRatio" TEXT NOT NULL DEFAULT '16:9',
    "executionMode" TEXT NOT NULL DEFAULT 'CLI',
    "ruleVersion" TEXT NOT NULL DEFAULT 'TASK_SCHEMA_V4',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
, "archivedAt" DATETIME);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ProjectRole" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectRole_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ReviewRound" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "episodeId" TEXT,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ReviewRound_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReviewRound_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "SceneSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "episodeId" TEXT,
    "sceneKey" TEXT,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SceneSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SceneSnapshot_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ScriptScene" (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "SeedanceUnit" (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "SeedanceUnitShot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "unitId" TEXT NOT NULL,
    "shotId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    CONSTRAINT "SeedanceUnitShot_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "SeedanceUnit" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SeedanceUnitShot_shotId_fkey" FOREIGN KEY ("shotId") REFERENCES "StoryboardShot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "StoryboardShot" (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "TaskPackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "episodeId" TEXT,
    "title" TEXT NOT NULL,
    "brief" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "payload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TaskPackage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskPackage_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "WorkflowIssue" (
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ApiRoleSession_projectId_episodeId_idx" ON "ApiRoleSession"("projectId", "episodeId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ApiRoleSession_projectId_episodeId_stageCode_key" ON "ApiRoleSession"("projectId", "episodeId", "stageCode");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Asset_episodeId_idx" ON "Asset"("episodeId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Asset_parentId_idx" ON "Asset"("parentId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "Asset_projectId_code_key" ON "Asset"("projectId", "code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Asset_projectId_idx" ON "Asset"("projectId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "CliRoleSession_projectId_episodeId_idx" ON "CliRoleSession"("projectId", "episodeId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "CliRoleSession_projectId_episodeId_stageCode_key" ON "CliRoleSession"("projectId", "episodeId", "stageCode");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "CompiledPromptVersion_unitId_selectedAt_idx" ON "CompiledPromptVersion"("unitId", "selectedAt");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "CompiledPromptVersion_unitId_version_key" ON "CompiledPromptVersion"("unitId", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Episode_projectId_idx" ON "Episode"("projectId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "Episode_projectId_number_key" ON "Episode"("projectId", "number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "FinalScript_episodeId_idx" ON "FinalScript"("episodeId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "FinalScript_projectId_episodeId_version_key" ON "FinalScript"("projectId", "episodeId", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "FinalScript_projectId_idx" ON "FinalScript"("projectId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "GenerationRun_projectId_idx" ON "GenerationRun"("projectId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "GenerationRun_taskPackageId_idx" ON "GenerationRun"("taskPackageId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "PipelineRun_episodeId_stageCode_idx" ON "PipelineRun"("episodeId", "stageCode");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "PipelineRun_projectId_createdAt_idx" ON "PipelineRun"("projectId", "createdAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "PresentationContract_projectId_status_idx" ON "PresentationContract"("projectId", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ProjectRole_projectId_idx" ON "ProjectRole"("projectId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectRole_userId_projectId_role_key" ON "ProjectRole"("userId", "projectId", "role");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ReviewRound_episodeId_idx" ON "ReviewRound"("episodeId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ReviewRound_projectId_idx" ON "ReviewRound"("projectId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "SceneSnapshot_episodeId_idx" ON "SceneSnapshot"("episodeId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "SceneSnapshot_projectId_idx" ON "SceneSnapshot"("projectId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ScriptScene_episodeId_sceneKey_key" ON "ScriptScene"("episodeId", "sceneKey");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ScriptScene_episodeId_sortOrder_idx" ON "ScriptScene"("episodeId", "sortOrder");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "SeedanceUnitShot_shotId_idx" ON "SeedanceUnitShot"("shotId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "SeedanceUnitShot_unitId_shotId_key" ON "SeedanceUnitShot"("unitId", "shotId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "SeedanceUnitShot_unitId_sortOrder_idx" ON "SeedanceUnitShot"("unitId", "sortOrder");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "SeedanceUnit_episodeId_unitKey_key" ON "SeedanceUnit"("episodeId", "unitKey");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "SeedanceUnit_sceneId_sortOrder_idx" ON "SeedanceUnit"("sceneId", "sortOrder");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Session_expiresAt_idx" ON "Session"("expiresAt");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "Session_tokenHash_key" ON "Session"("tokenHash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Session_userId_idx" ON "Session"("userId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "StoryboardShot_episodeId_shotKey_key" ON "StoryboardShot"("episodeId", "shotKey");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "StoryboardShot_sceneId_sortOrder_idx" ON "StoryboardShot"("sceneId", "sortOrder");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "TaskPackage_episodeId_idx" ON "TaskPackage"("episodeId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "TaskPackage_projectId_idx" ON "TaskPackage"("projectId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "WorkflowIssue_episodeId_status_idx" ON "WorkflowIssue"("episodeId", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "WorkflowIssue_shotId_idx" ON "WorkflowIssue"("shotId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "WorkflowIssue_unitId_idx" ON "WorkflowIssue"("unitId");
