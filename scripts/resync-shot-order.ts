/**
 * 一次性修复工具：renormalizeShotOrder 旧正则不支持 "-a/-x0/-c0" 后缀镜号，
 * 导致这些后继镜被排到场景末尾（覆盖 100% 但叙事顺序错乱）。
 * 本脚本对项目内所有集：
 *  1. 按修正后的镜号自然序重排 sortOrder；
 *  2. 按新顺序重建单元分组（同场次连续打包 ≤15s，字段待补充，由 E3 修复轮补写）。
 */
import { prisma } from "@/lib/prisma";

const PROJECT_ID = "cmsvgadrc00cvu3uki0u56d71";
const FORCE = process.argv.includes("--force");

function naturalKey(shotKey: string): [string, number, string] {
  const match = /^(.*?)-S(\d+)(?:-([a-z0-9]+))?$/.exec(shotKey);
  if (!match) return [shotKey, 0, ""];
  return [match[1], Number(match[2]), match[3] ?? ""];
}

const nodeSeq = new Map<string, number>();

function computePartition(rows: Array<{ shotKey: string; sceneKey: string; timeLayer: string; duration: number }>) {
  const sceneKeys = [...new Set(rows.map((r) => r.sceneKey))];
  const partition: Array<{ unitKey: string; sceneId: string; timeLayer: string; shotKeys: string[]; duration: number }> = [];
  let unitSeq = 0;
  for (const sceneKey of sceneKeys) {
    const layers = [...new Set(rows.filter((r) => r.sceneKey === sceneKey).map((r) => r.timeLayer))];
    for (const layer of layers) {
      const group = rows.filter((r) => r.sceneKey === sceneKey && r.timeLayer === layer);
      const units: Array<{ shotKeys: string[]; duration: number }> = [];
      let current: string[] = [];
      let currentDuration = 0;
      for (const shot of group) {
        const duration = Number(shot.duration);
        if (current.length && currentDuration + duration > 15.0001) {
          units.push({ shotKeys: current, duration: Math.round(currentDuration * 10) / 10 });
          current = [shot.shotKey];
          currentDuration = duration;
        } else {
          current.push(shot.shotKey);
          currentDuration += duration;
        }
      }
      if (current.length) units.push({ shotKeys: current, duration: Math.round(currentDuration * 10) / 10 });
      while (units.length >= 2 && units[units.length - 1].duration < 12 && units[units.length - 2].duration + units[units.length - 1].duration <= 15.0001) {
        const tail = units.pop()!;
        const head = units[units.length - 1];
        head.shotKeys = [...head.shotKeys, ...tail.shotKeys];
        head.duration = Math.round((head.duration + tail.duration) * 10) / 10;
      }
      for (const unit of units) {
        unitSeq += 1;
        partition.push({ unitKey: `${sceneKey}-U${String(unitSeq).padStart(2, "0")}`, sceneId: sceneKey, timeLayer: layer, shotKeys: unit.shotKeys, duration: unit.duration });
      }
    }
  }
  return partition;
}

void (async () => {
  const episodes = await prisma.episode.findMany({ where: { projectId: PROJECT_ID }, orderBy: { number: "asc" } });
  const scenes = await prisma.scriptScene.findMany({ where: { episode: { projectId: PROJECT_ID } } });
  const sceneByKey = new Map(scenes.map((s) => [s.sceneKey, s]));

  for (const ep of episodes) {
    const rows = await prisma.storyboardShot.findMany({ where: { episodeId: ep.id }, orderBy: { sortOrder: "asc" } });
    if (!rows.length) continue;
    if (nodeSeq.size === 0) {
      // 构建源节点序号映射
      const scenes = await prisma.scriptScene.findMany({ where: { episodeId: ep.id }, orderBy: { sortOrder: "asc" } });
      const { buildSourcePackage } = await import("@/lib/episode-pipeline-contracts");
      const pkg = buildSourcePackage(scenes.map((sc) => ({ sceneKey: sc.sceneKey, heading: sc.heading, location: sc.location, interiorExterior: sc.interiorExterior, timeOfDay: sc.timeOfDay, weather: sc.weather, timeLayer: sc.timeLayer, sourceText: sc.sourceText })));
      let idx = 0;
      for (const sc of pkg.scenes) for (const n of sc.source_nodes) nodeSeq.set(n.source_node_id, ++idx);
    }
    const orderKeyOf = (row: (typeof rows)[number]) => {
      const dialogue = JSON.parse(row.dialogue || "[]");
      let seqs = dialogue.map((e: { source_node_id?: string }) => e.source_node_id ?? "").map((id: string) => nodeSeq.get(id)).filter((v: number | undefined): v is number => v !== undefined);
      if (!seqs.length) {
        const refs = JSON.parse(row.sourceNodeRefs || "[]");
        seqs = refs.map((id: string) => nodeSeq.get(id)).filter((v: number | undefined): v is number => v !== undefined);
      }
      const e1 = JSON.parse(row.e1Data || "{}");
      return { scene: String(e1.scene_id ?? ""), minSeq: seqs.length ? Math.min(...seqs) : Number.POSITIVE_INFINITY, shotKey: row.shotKey };
    };
    const sorted = [...rows].sort((a, b) => {
      const ka = orderKeyOf(a);
      const kb = orderKeyOf(b);
      if (ka.scene !== kb.scene) return ka.scene < kb.scene ? -1 : 1;
      if (ka.minSeq !== kb.minSeq) return ka.minSeq - kb.minSeq;
      return ka.shotKey < kb.shotKey ? -1 : 1;
    });
    // 检测是否有顺序变化
    let changed = 0;
    for (let i = 0; i < rows.length; i++) if (rows[i].shotKey !== sorted[i].shotKey) changed++;
    if (!changed && !FORCE) {
      const unitCount = await prisma.seedanceUnit.count({ where: { episodeId: ep.id } });
      if (unitCount > 0) {
        console.log(`ep${ep.number}: 顺序无变化且单元完整（跳过）`);
        continue;
      }
      console.log(`ep${ep.number}: 顺序无变化但单元缺失（${unitCount}），强制重建`);
    }
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].sortOrder !== i + 1) {
        await prisma.storyboardShot.update({ where: { id: sorted[i].id }, data: { sortOrder: i + 1 } });
      }
    }
    // 重建单元分组
    const partition = computePartition(sorted.map((r) => {
      const e1 = JSON.parse(r.e1Data || '{}');
      return { shotKey: r.shotKey, sceneKey: String(e1.scene_id ?? r.sceneId ?? ''), timeLayer: r.timeLayer, duration: r.duration };
    }));
    await prisma.compiledPromptVersion.deleteMany({ where: { unit: { episodeId: ep.id } } });
    await prisma.seedanceUnitShot.deleteMany({ where: { unit: { episodeId: ep.id } } });
    await prisma.seedanceUnit.deleteMany({ where: { episodeId: ep.id } });
    const shotByKey = new Map(sorted.map((r) => [r.shotKey, r]));
    for (const [index, part] of partition.entries()) {
      const scene = sceneByKey.get(part.sceneId);
      if (!scene) throw new Error(`ep${ep.number} ${part.unitKey} 找不到场次 ${part.sceneId}`);
      const data = {
        unit_id: part.unitKey,
        shot_ids: part.shotKeys,
        unit_duration: part.duration,
        unit_dominant_goal: null,
        unit_start_premise: "待补充",
        unit_end_state: "待补充",
        short_unit_reason: part.duration < 12 ? "本场分镜时长组合余数不足12秒" : null,
        subject_bindings: [],
        crowd: false
      };
      const unit = await prisma.seedanceUnit.create({
        data: {
          episodeId: ep.id,
          sceneId: scene.id,
          unitKey: part.unitKey,
          sortOrder: index + 1,
          duration: part.duration,
          shortUnitReason: data.short_unit_reason,
          startPremise: data.unit_start_premise,
          endState: data.unit_end_state,
          data: JSON.stringify(data),
          revision: `RESYNC_${new Date().toISOString().slice(0, 10)}`
        }
      });
      for (const [shotIndex, shotKey] of part.shotKeys.entries()) {
        const shot = shotByKey.get(shotKey);
        if (!shot) throw new Error(`ep${ep.number} ${part.unitKey} 找不到镜号 ${shotKey}`);
        await prisma.seedanceUnitShot.create({ data: { unitId: unit.id, shotId: shot.id, sortOrder: shotIndex + 1 } });
      }
    }
    console.log(`ep${ep.number}: 重排 ${rows.length} 镜（错位 ${changed}）→ ${partition.length} 单元重建，待 E3 补写字段`);
  }
  await prisma.$disconnect();
})();
