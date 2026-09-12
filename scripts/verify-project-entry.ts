import assert from "node:assert/strict";
import {
  PROJECT_STYLE_OPTIONS,
  EXECUTION_MODE_OPTIONS,
  deriveProjectCardState,
  getProjectStyle,
  readProjectSubmission,
  readProjectSubmissionMode,
  resolveProjectStyleCover,
  resolveProjectDestination
} from "@/lib/project-entry";
import { existsSync } from "node:fs";
import { join } from "node:path";

async function main() {
  assert.equal(resolveProjectDestination("project-1"), "/projects/project-1");
  assert.equal(readProjectSubmissionMode("upload"), "upload");
  assert.equal(readProjectSubmissionMode("paste"), "paste");
  assert.throws(() => readProjectSubmissionMode("api"), /请选择上传剧本或粘贴文本/);

  assert.equal(PROJECT_STYLE_OPTIONS.filter((style) => style.recommended).length, 3);
  for (const style of PROJECT_STYLE_OPTIONS) {
    assert.match(style.coverImage, /^\/style-covers\/.+\.webp$/);
    assert.equal(existsSync(join(process.cwd(), "public", style.coverImage)), true, `${style.id} cover missing`);
  }
  assert.equal(getProjectStyle("3d-guoman").label, "3D国漫");
  assert.throws(() => getProjectStyle("unknown-style"), /请选择有效的画面风格/);
  assert.equal(resolveProjectStyleCover("3D国漫"), "/style-covers/3d-guoman.webp");
  assert.equal(resolveProjectStyleCover("真人竖屏短剧写实风格"), "/style-covers/live-action-cinematic.webp");
  assert.equal(resolveProjectStyleCover("未识别旧风格"), "/style-covers/custom.webp");
  assert.ok(EXECUTION_MODE_OPTIONS.every((option) => option.hint.includes("v0.2 第一阶段测试") && !option.hint.includes("E0")));

  assert.deepEqual(
    deriveProjectCardState({ episodeCount: 12, foundationReady: false, unitEpisodeCount: 0 }),
    { stage: "全剧资料", progress: 20, actionLabel: "继续整理" }
  );
  assert.deepEqual(
    deriveProjectCardState({ episodeCount: 12, foundationReady: true, unitEpisodeCount: 0 }),
    { stage: "全剧资料就绪", progress: 100, actionLabel: "查看第一阶段资料" }
  );
  assert.deepEqual(
    deriveProjectCardState({ episodeCount: 12, foundationReady: true, unitEpisodeCount: 4 }),
    { stage: "全剧资料就绪", progress: 100, actionLabel: "查看第一阶段资料" }
  );
  assert.deepEqual(
    deriveProjectCardState({ episodeCount: 12, foundationReady: true, unitEpisodeCount: 12 }),
    { stage: "全剧资料就绪", progress: 100, actionLabel: "查看第一阶段资料" }
  );

  const pasted = new FormData();
  pasted.set("title", "  测试项目  ");
  pasted.set("mode", "paste");
  pasted.set("styleId", "3d-guoman");
  pasted.set("aspectRatio", "16:9");
  pasted.set("scriptText", "第1集\n正文");
  assert.deepEqual(await readProjectSubmission(pasted), {
    title: "测试项目",
    mode: "paste",
    style: "3D国漫",
    aspectRatio: "16:9",
    executionMode: "CLI",
    sourceName: "测试项目.txt",
    sourceText: "第1集\n正文"
  });

  const uploaded = new FormData();
  uploaded.set("title", "上传项目");
  uploaded.set("mode", "upload");
  uploaded.set("styleId", "live-action-cinematic");
  uploaded.set("aspectRatio", "9:16");
  uploaded.set("script", new File(["第1集\n正文"], "script.txt", { type: "text/plain" }));
  const uploadResult = await readProjectSubmission(uploaded);
  assert.equal(uploadResult.mode, "upload");
  assert.equal(uploadResult.sourceName, "script.txt");
  assert.equal(uploadResult.style, "真人电影写实");
  assert.equal(uploadResult.aspectRatio, "9:16");
  assert.equal(uploadResult.buffer.toString("utf8"), "第1集\n正文");

  const empty = new FormData();
  empty.set("title", "空剧本");
  empty.set("mode", "paste");
  empty.set("styleId", "2d-anime");
  empty.set("aspectRatio", "16:9");
  empty.set("scriptText", "   ");
  await assert.rejects(() => readProjectSubmission(empty), /请粘贴剧本正文/);

  console.log("project entry verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
