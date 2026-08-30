-- Make presentation contracts explicit about which formal episodes receive them.
-- Existing rows default to SOURCE_EPISODES; the application resolves legacy rows
-- without a target list from their original episodeId/project-level semantics.
ALTER TABLE "PresentationContract" ADD COLUMN "scopeMode" TEXT NOT NULL DEFAULT 'SOURCE_EPISODES';
ALTER TABLE "PresentationContract" ADD COLUMN "targetEpisodeNumbers" TEXT;
