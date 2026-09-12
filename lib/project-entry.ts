export type ProjectSubmissionMode = "upload" | "paste";

/** 执行方式：CLI（本机 Codex）/ API（DeepSeek）。 */
export type ProjectExecutionMode = "CLI" | "API";

export const EXECUTION_MODE_OPTIONS: ReadonlyArray<{ value: ProjectExecutionMode; label: string; hint: string }> = [
  { value: "CLI", label: "CLI（本机 Codex）", hint: "v0.2 第一阶段测试：运行 F1、F2、Q1 普通提示词，后续阶段未启用" },
  { value: "API", label: "API（DeepSeek）", hint: "v0.2 第一阶段测试：用同一套 F1、F2、Q1 普通提示词调用 API，后续阶段未启用" }
];

export type ProjectStyleOption = {
  id: string;
  label: string;
  category: "真人" | "3D" | "2D" | "其他";
  description: string;
  recommended: boolean;
  visualClass: string;
  coverImage: string;
};

export type ProjectCardMetrics = {
  episodeCount: number;
  foundationReady: boolean;
  unitEpisodeCount: number;
};

export type ProjectSubmission =
  | {
      title: string;
      mode: "paste";
      style: string;
      aspectRatio: string;
      executionMode: ProjectExecutionMode;
      sourceName: string;
      sourceText: string;
    }
  | {
      title: string;
      mode: "upload";
      style: string;
      aspectRatio: string;
      executionMode: ProjectExecutionMode;
      sourceName: string;
      buffer: Buffer;
    };

const ALLOWED_ASPECT_RATIOS = new Set(["16:9", "9:16", "4:3", "3:4", "1:1"]);

export const PROJECT_STYLE_OPTIONS: ProjectStyleOption[] = [
  {
    id: "live-action-cinematic",
    label: "真人电影写实",
    category: "真人",
    description: "电影级写实光影与自然人物质感",
    recommended: true,
    visualClass: "styleLiveAction",
    coverImage: "/style-covers/live-action-cinematic.webp"
  },
  {
    id: "3d-guoman",
    label: "3D国漫",
    category: "3D",
    description: "电影级三维国漫、可信材质与空间光影",
    recommended: true,
    visualClass: "style3DGuoman",
    coverImage: "/style-covers/3d-guoman.webp"
  },
  {
    id: "2d-anime",
    label: "2D动漫",
    category: "2D",
    description: "清晰线稿、稳定角色与动画电影构图",
    recommended: true,
    visualClass: "style2DAnime",
    coverImage: "/style-covers/2d-anime.webp"
  },
  {
    id: "costume-cinematic",
    label: "古装电影写实",
    category: "真人",
    description: "古装实拍质感、考究服化与层次光影",
    recommended: false,
    visualClass: "styleCostume",
    coverImage: "/style-covers/costume-cinematic.webp"
  },
  {
    id: "cyber-cinematic",
    label: "赛博科幻",
    category: "其他",
    description: "冷调未来空间与克制霓虹光效",
    recommended: false,
    visualClass: "styleCyber",
    coverImage: "/style-covers/cyber-cinematic.webp"
  },
  {
    id: "custom",
    label: "其他风格",
    category: "其他",
    description: "先创建项目，后续选择或补充固定模板",
    recommended: false,
    visualClass: "styleCustom",
    coverImage: "/style-covers/custom.webp"
  }
];

export function resolveProjectDestination(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

export function deriveProjectCardState(metrics: ProjectCardMetrics) {
  if (metrics.foundationReady !== true || metrics.episodeCount === 0) {
    return { stage: "全剧资料", progress: 20, actionLabel: "继续整理" } as const;
  }

  return { stage: "全剧资料就绪", progress: 100, actionLabel: "查看第一阶段资料" } as const;
}

export function readProjectSubmissionMode(value: FormDataEntryValue | null): ProjectSubmissionMode {
  if (value === "upload" || value === "paste") return value;
  throw new Error("请选择上传剧本或粘贴文本。");
}

export function readExecutionMode(value: FormDataEntryValue | null): ProjectExecutionMode {
  return String(value ?? "CLI").toUpperCase() === "API" ? "API" : "CLI";
}

export function getProjectStyle(styleId: string): ProjectStyleOption {
  const style = PROJECT_STYLE_OPTIONS.find((option) => option.id === styleId);
  if (!style) throw new Error("请选择有效的画面风格。");
  return style;
}

export function resolveProjectStyleCover(styleLabel: string | null | undefined): string {
  const value = String(styleLabel ?? "").trim();
  const exact = PROJECT_STYLE_OPTIONS.find((option) => option.label === value);
  if (exact) return exact.coverImage;
  if (/3D|三维|国漫/i.test(value)) return getProjectStyle("3d-guoman").coverImage;
  if (/2D|动漫|动画|二次元/i.test(value)) return getProjectStyle("2d-anime").coverImage;
  if (/古装|武侠|仙侠/i.test(value)) return getProjectStyle("costume-cinematic").coverImage;
  if (/赛博|科幻|未来/i.test(value)) return getProjectStyle("cyber-cinematic").coverImage;
  if (/真人|写实|短剧|电影/i.test(value)) return getProjectStyle("live-action-cinematic").coverImage;
  return getProjectStyle("custom").coverImage;
}

export async function readProjectSubmission(formData: FormData): Promise<ProjectSubmission> {
  const title = String(formData.get("title") ?? "").trim();
  if (!title) throw new Error("请输入项目名称。");
  if (title.length > 50) throw new Error("项目名称不能超过50个字符。");

  const mode = readProjectSubmissionMode(formData.get("mode"));
  const style = getProjectStyle(String(formData.get("styleId") ?? ""));
  const aspectRatio = String(formData.get("aspectRatio") ?? "16:9");
  if (!ALLOWED_ASPECT_RATIOS.has(aspectRatio)) throw new Error("请选择有效的画面比例。");
  const executionMode = readExecutionMode(formData.get("executionMode"));

  if (mode === "paste") {
    const sourceText = String(formData.get("scriptText") ?? "");
    if (!sourceText.trim()) throw new Error("请粘贴剧本正文。");
    return {
      title,
      mode,
      style: style.label,
      aspectRatio,
      executionMode,
      sourceName: `${title}.txt`,
      sourceText
    };
  }

  const file = formData.get("script");
  if (!(file instanceof File) || file.size === 0) throw new Error("请选择剧本文件。");
  if (!/\.(txt|md|docx)$/i.test(file.name)) throw new Error("仅支持 TXT、MD 或 DOCX 剧本文件。");

  return {
    title,
    mode,
    style: style.label,
    aspectRatio,
    executionMode,
    sourceName: file.name,
    buffer: Buffer.from(await file.arrayBuffer())
  };
}
