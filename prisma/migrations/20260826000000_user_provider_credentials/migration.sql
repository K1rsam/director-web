-- Store provider credentials per user. The API key is encrypted by the application
-- before it reaches this table; this migration never stores plaintext credentials.
CREATE TABLE "UserProviderCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'DEEPSEEK',
    "apiKeyCiphertext" TEXT NOT NULL,
    "apiKeyHint" TEXT,
    "apiBase" TEXT NOT NULL DEFAULT 'https://api.deepseek.com',
    "model" TEXT NOT NULL DEFAULT 'deepseek-chat',
    "lastTestedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserProviderCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "UserProviderCredential_userId_provider_key" ON "UserProviderCredential"("userId", "provider");
CREATE INDEX "UserProviderCredential_userId_updatedAt_idx" ON "UserProviderCredential"("userId", "updatedAt");

