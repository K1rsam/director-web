-- Preserve the local project's presentation-rule scope during data transfer.
-- Business tables originate in 0001_original_business_schema.sql.
ALTER TABLE "PresentationContract" ADD COLUMN "scopeMode" TEXT NOT NULL DEFAULT 'SOURCE_EPISODES';
--> statement-breakpoint
ALTER TABLE "PresentationContract" ADD COLUMN "targetEpisodeNumbers" TEXT;
--> statement-breakpoint
ALTER TABLE "PresentationContract" ADD COLUMN "ruleKey" TEXT;
