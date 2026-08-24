/** 本地预演：对当前库状态跑 validatePipeline，预测下一轮 E5 会开什么卡（零 Token，不落库）。 */
import { executeEpisodePipeline } from "@/lib/episode-pipeline";
import { prisma } from "@/lib/prisma";

const projectId = "cmsvgadrc00cvu3uki0u56d71";
const episodeId = "cmsvgadrq00cxu3ukzmj06q5b";

void (async () => {
  // 复用 executeEpisodePipeline 的 E5 分支但用假 runner：validatePipeline 在 E5 执行前跑，
  // runner 返回 pass 后 persistReviewIssues 会落库——不想落库，这里只捕获 prompt 里的 revision_issues
  // 不行；直接内联调用 loadPipelineContext + validatePipeline。
  const { loadPipelineContext } = await import("@/lib/episode-pipeline");
  const { validatePipeline } = await import("@/lib/episode-pipeline");
  const context = await loadPipelineContext(projectId, episodeId);
  const shots = await (async () => {
    const { hydrateWorkingShots } = await import("@/lib/episode-pipeline");
    return hydrateWorkingShots(context);
  })();
  const { hydrateUnitOutput } = await import("@/lib/episode-pipeline");
  const unitOutput = await hydrateUnitOutput(context);
  const issues = validatePipeline(context, shots, unitOutput.units);
  const open = issues.filter((item) => item.severity === "BLOCKER");
  console.log(`总卡数=${issues.length} BLOCKER=${open.length}`);
  for (const item of open) {
    console.log(`[BLOCKER] ${item.coordinate} | ${item.code} | owner=${item.ownerRole} | ${item.evidence}`);
  }
  const majors = issues.filter((item) => item.severity === "MAJOR");
  console.log(`\nMAJOR=${majors.length}`);
  for (const item of majors.slice(0, 25)) {
    console.log(`[MAJOR] ${item.coordinate} | ${item.code} | owner=${item.ownerRole} | ${item.evidence}`);
  }
  await prisma.$disconnect();
})();
