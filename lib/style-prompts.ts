const LIVE_ACTION = "电影级真人写实质感，真实人体比例与自然皮肤材质，五官、眼神、手部和关键道具清晰稳定；自然环境光与电影级景深，克制中高对比，曝光准确；同场镜头保持人物造型、空间关系、光向、色温和道具状态连续。";

const THREE_D_GUOMAN = "3D国漫电影级品质，4K高清，可信PBR材质，写实人体比例与稳定五官；冷白灰蓝电影色调，青金冷光点缀，高光干净、暗部保留纹理；主辅轮廓光方向清楚，适量体积光与空气微尘，前中后景层次明确；同场镜头保持色温、光向、空间、服装和道具连续。";

const TWO_D_ANIME = "高品质2D动画电影风格，清晰稳定线稿，角色比例与面部设计统一，色块干净、材质层次明确；电影化构图、景深与光影，动作关键姿态清楚；同场镜头保持角色造型、空间方向、色彩和道具连续。";

const COSTUME = "电影级古装真人写实质感，考究服饰、发型与传统材质，真实人体比例和自然面部细节；克制东方电影色彩，层次光影与环境纵深清楚；同场镜头保持服装妆造、场景方位、光向和道具状态连续。";

const CYBER = "电影级赛博科幻写实质感，可信未来材质与空间结构，冷调环境中使用克制霓虹作为重点光；人物面部、手部与关键装置稳定清晰，空气透视和景深自然；同场镜头保持光色逻辑、空间关系、造型和道具连续。";

export const DEFAULT_NEGATIVE_PROMPT = "无任何可辨识文字、无字幕、无屏幕叠字、无人名条、无地点条、无时间条、无水印、无Logo、无BGM文字；避免五官漂移、糊脸、重影、闪烁、手指畸形、肢体穿插、动作失重、服装突变、道具断层、跳位、过曝、塑料皮肤、廉价滤镜与AI穿帮。";

export function resolveStylePrompt(style: string | null | undefined, aspectRatio: string): string {
  const value = String(style ?? "");
  const prompt = /3D|三维|国漫/i.test(value)
    ? THREE_D_GUOMAN
    : /2D|动漫|动画|二次元/i.test(value)
      ? TWO_D_ANIME
      : /古装|武侠|仙侠/i.test(value)
        ? COSTUME
        : /赛博|科幻|未来/i.test(value)
          ? CYBER
          : LIVE_ACTION;
  return `${aspectRatio}画幅；${prompt}`;
}
