export type ProjectEpisodeGuidanceInput = {
  id: string;
  number: number;
  shotCount: number;
  running: boolean;
  failed: boolean;
  finished: boolean;
};

export type ProjectGuidance = {
  kind: "contracts" | "foundation" | "running" | "repair" | "continue" | "complete";
  eyebrow: string;
  title: string;
  description: string;
  actionLabel: string;
  episodeId?: string;
};

export function deriveProjectGuidance(input: {
  pendingContracts: number;
  planningReady: boolean;
  assetsReady: boolean;
  foundationActive?: boolean;
  foundationReady?: boolean;
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
      eyebrow: "正在整理",
      title: "正在整理全剧基础工程",
      description: "P1 完成后会继续执行 P2；完成后再进入单集分镜生产。",
      actionLabel: "查看 P1/P2 进度"
    };
  }

  if (input.foundationReady === false || !input.planningReady || !input.assetsReady) {
    return {
      kind: "foundation",
      eyebrow: "推荐下一步",
      title: "建立全剧基础工程",
      description: "先完成基础策划与资产索引，再进入单集分镜生产。",
      actionLabel: "开始整理全剧资料"
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
      description: "本集存在失败步骤或阻断问题，处理后再继续生成。",
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
