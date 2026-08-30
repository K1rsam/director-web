export type ProjectEpisodeGuidanceInput = {
  id: string;
  number: number;
  shotCount: number;
  running: boolean;
  failed: boolean;
  finished: boolean;
};

export type ProjectBatchGuidanceInput = {
  status: string;
  message?: string | null;
  error?: string | null;
  processed?: number | null;
  total?: number | null;
};

export type ProjectGuidance = {
  kind: "contracts" | "foundation" | "batch-running" | "batch-paused" | "running" | "repair" | "continue" | "complete";
  eyebrow: string;
  title: string;
  description: string;
  actionLabel: string;
  episodeId?: string;
  batchPauseReason?: "quota" | "error";
};

export function deriveProjectGuidance(input: {
  pendingContracts: number;
  planningReady: boolean;
  assetsReady: boolean;
  foundationActive?: boolean;
  foundationReady?: boolean;
  batchMonitor?: ProjectBatchGuidanceInput | null;
  episodes: ProjectEpisodeGuidanceInput[];
}): ProjectGuidance {
  if (input.pendingContracts > 0) {
    return {
      kind: "contracts",
      eyebrow: "需要你的决定",
      title: `确认 ${input.pendingContracts} 项表现规范`,
      description: "先确定非常规内容怎么呈现，后续资产和分镜才能保持一致。",
      actionLabel: "确认表现规范"
    };
  }

  if (input.foundationActive) {
    return {
      kind: "foundation",
      eyebrow: "基础工程执行中",
      title: "正在执行全剧基础工程",
      description: "P1 完成后会继续执行 P2；完成后再进入单集分镜生产。",
      actionLabel: "查看 P1/P2 进度"
    };
  }

  // 有完整成功的 P1/P2 批次时，以流水线事实为准；旧的策划/资产计数不能把页面再推回“未开始”。
  const foundationMissing = input.foundationReady !== true && (
    input.foundationReady === false || !input.planningReady || !input.assetsReady
  );
  if (foundationMissing) {
    return {
      kind: "foundation",
      eyebrow: "推荐下一步",
      title: "建立全剧基础工程",
      description: "先完成基础策划与资产索引，再进入单集分镜生产。",
      actionLabel: "开始全剧基础工程"
    };
  }

  const batchStatus = input.batchMonitor?.status;
  if (batchStatus === "QUEUED" || batchStatus === "RUNNING") {
    return {
      kind: "batch-running",
      eyebrow: "自动推进中",
      title: "正在批量生成全剧初稿",
      description: "页面会按集推进 E0–E5；每集完成后自动启动下一集，批量阶段不自动返修。",
      actionLabel: "查看批量状态"
    };
  }

  const hasIncompleteEpisode = input.episodes.some((episode) => !episode.finished);
  if (batchStatus === "FAILED" && hasIncompleteEpisode) {
    const rawReason = `${input.batchMonitor?.message ?? ""} ${input.batchMonitor?.error ?? ""}`;
    const quotaPause = isCapacityPause(rawReason);
    const progress = formatBatchProgress(input.batchMonitor?.processed, input.batchMonitor?.total);
    return {
      kind: "batch-paused",
      eyebrow: quotaPause ? "额度不足，已暂停" : "批量推进已暂停",
      title: quotaPause ? "等待额度恢复后继续" : "批量推进需要处理",
      description: progress
        ? `${progress} ${quotaPause ? "未继续启动新的剧集任务，也不会继续消耗额度。" : "未完成剧集不会自动继续，请先查看批量状态。"}`
        : quotaPause
          ? "未继续启动新的剧集任务，也不会继续消耗额度；额度恢复后可从批量卡继续。"
          : "未完成剧集不会自动继续，请先查看批量状态和暂停原因。",
      actionLabel: "查看批量状态",
      batchPauseReason: quotaPause ? "quota" : "error"
    };
  }

  const running = input.episodes.find((episode) => episode.running);
  if (running) {
    return {
      kind: "running",
      eyebrow: "正在生成",
      title: `第 ${running.number} 集正在执行`,
      description: "进入本集查看当前岗位、耗时与实时输出。",
      actionLabel: `查看第 ${running.number} 集进度`,
      episodeId: running.id
    };
  }

  const failed = input.episodes.find((episode) => episode.failed);
  if (failed) {
    return {
      kind: "repair",
      eyebrow: "需要处理",
      title: `修复第 ${failed.number} 集`,
      description: "本集已有生成记录存在失败步骤或阻断问题，请进入单集处理后再继续。",
      actionLabel: `修复第 ${failed.number} 集`,
      episodeId: failed.id
    };
  }

  const unfinished = input.episodes.find((episode) => !episode.finished);
  if (unfinished) {
    return {
      kind: "continue",
      eyebrow: unfinished.shotCount ? "继续上次工作" : "推荐下一步",
      title: `${unfinished.shotCount ? "继续制作" : "开始制作"}第 ${unfinished.number} 集`,
      description: unfinished.shotCount ? "从上次完成的岗位继续，不必重新生成已有结果。" : "基础工程已就绪，可以开始拆解本集分镜。",
      actionLabel: `进入第${unfinished.number}集`,
      episodeId: unfinished.id
    };
  }

  return {
    kind: "complete",
    eyebrow: "本轮已完成",
    title: "全部分集均已生成",
    description: "可以进入任意一集检查分镜单元并导出。",
    actionLabel: input.episodes.at(-1) ? `查看第 ${input.episodes.at(-1)!.number} 集` : "查看分集",
    episodeId: input.episodes.at(-1)?.id
  };
}

function isCapacityPause(value: string) {
  return /额度不足|配额不足|余额不足|频率限制|rate\s*limit|usage\s*limit|quota/i.test(value);
}

function formatBatchProgress(processed: number | null | undefined, total: number | null | undefined) {
  if (!Number.isInteger(processed) || !Number.isInteger(total) || Number(total) <= 0) return "";
  return `已完成 ${processed}/${total} 集初稿。`;
}
