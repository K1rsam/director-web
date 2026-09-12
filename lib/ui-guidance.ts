export type ProjectEpisodeGuidanceInput = {
  id: string;
  number: number;
  shotCount: number;
  running: boolean;
  failed: boolean;
  finished: boolean;
};

export type ProjectGuidance = {
  kind: "contracts" | "foundation" | "review";
  eyebrow: string;
  title: string;
  description: string;
  actionLabel: string;
  episodeId?: string;
};

export function deriveProjectGuidance(input: {
  pendingContracts: number;
  foundationReady: boolean;
  episodes: ProjectEpisodeGuidanceInput[];
}): ProjectGuidance {
  if (input.pendingContracts > 0) {
    return {
      kind: "contracts",
      eyebrow: "F1 · F2 · Q1 的必要取舍",
      title: `${input.pendingContracts} 项需要你确认`,
      description: "F1、F2、Q1 只把原文和现有资料无法决定的取舍交给你。查看选项与推荐，明确选择后保存；不会自动运行。",
      actionLabel: "查看需要确认的决定"
    };
  }

  if (!input.foundationReady) {
    return {
      kind: "foundation",
      eyebrow: "推荐下一步",
      title: "整理 v0.2 第一阶段资料",
      description: "F1整理分集导航，F2列基础资产与必要着装／形态，Q1直接完成最后一轮优化。",
      actionLabel: "开始整理全剧资料"
    };
  }

  return {
    kind: "review",
    eyebrow: "第一阶段资料已形成",
    title: "查看第一阶段最终资料",
    description: "资产与分集资料已形成，可用于准备图片；v0.2后续分镜阶段尚未启用。",
    actionLabel: "下载第一阶段资料"
  };
}
