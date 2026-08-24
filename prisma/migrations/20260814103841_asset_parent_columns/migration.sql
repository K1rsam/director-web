-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Asset" (
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
INSERT INTO "new_Asset" ("code", "createdAt", "episodeId", "id", "metadata", "name", "notes", "projectId", "sourceText", "status", "type", "updatedAt") SELECT "code", "createdAt", "episodeId", "id", "metadata", "name", "notes", "projectId", "sourceText", "status", "type", "updatedAt" FROM "Asset";
DROP TABLE "Asset";
ALTER TABLE "new_Asset" RENAME TO "Asset";
CREATE INDEX "Asset_projectId_idx" ON "Asset"("projectId");
CREATE INDEX "Asset_episodeId_idx" ON "Asset"("episodeId");
CREATE INDEX "Asset_parentId_idx" ON "Asset"("parentId");
CREATE UNIQUE INDEX "Asset_projectId_code_key" ON "Asset"("projectId", "code");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
