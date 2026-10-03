-- Latest project/source and project/job reads, plus the cross-project executor queue.
-- Indexes only: all source, history, private images and task rows stay intact.
CREATE INDEX "SceneSnapshot_projectId_sceneKey_createdAt_id_idx" ON "SceneSnapshot"("projectId", "sceneKey", "createdAt", "id");
CREATE INDEX "SceneSnapshot_sceneKey_createdAt_id_idx" ON "SceneSnapshot"("sceneKey", "createdAt", "id");
