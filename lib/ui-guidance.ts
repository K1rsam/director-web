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
  kind: "contracts" | "foundation" | "review";
  eyebrow: string;
  title: string;
  description: string;
  actionLabel: string;
  episodeId?: string;
  batchPauseReason?: "quota" | "error";
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
      title: "完成五步第一阶段资料",
      description: "先接收并保真清洗，再拆集分场、整理必要事实、核对素材目录，最后按集交接。",
      actionLabel: "开始整理全剧资料"
    };
  }

  return {
    kind: "review",
    eyebrow: "第一阶段资料已形成",
    title: "查看第一阶段最终资料",
    description: "资料已就绪，可按集下载交接。图片尚未生成，后续分镜阶段未启用。",
    actionLabel: "下载第一阶段资料"
  };
}

function isCapacityPause(value: string) {
  return /额度不足|配额不足|余额不足|频率限制|rate\s*limit|usage\s*limit|quota/i.test(value);
}

function formatBatchProgress(processed: number | null | undefined, total: number | null | undefined) {
  if (!Number.isInteger(processed) || !Number.isInteger(total) || Number(total) <= 0) return "";
  return `已完成 ${processed}/${total} 集初稿。`;
}
