"use client";

import { useState } from "react";

export type InfoPanelScene = {
  sceneKey: string;
  heading: string;
  timeOfDay: string;
  interiorExterior: string;
  timeLayer: string;
};

export type InfoPanelAsset = {
  code: string;
  type: string;
  name: string;
  status: string;
};

type EpisodeInfoPanelProps = {
  content: string;
  scenes: InfoPanelScene[];
  assets: InfoPanelAsset[];
  infoPackage: string;
  onClose?: () => void;
};

const ASSET_CHIP_TYPE: Record<string, string> = {
  CH: "人物", LOOK: "人物状态", GROUP: "群像", BEAST: "非人", LOC: "场景", PROP: "道具", STYLE: "风格", NEG: "负面约束"
};

const ASSET_GROUPS: Array<{ key: string; title: string; types: string[] }> = [
  { key: "people", title: "人物", types: ["CH", "LOOK"] },
  { key: "groups", title: "群像", types: ["GROUP"] },
  { key: "beasts", title: "非人", types: ["BEAST"] },
  { key: "scenes", title: "场景", types: ["LOC"] },
  { key: "props", title: "道具", types: ["PROP"] },
  { key: "other", title: "其他", types: ["STYLE", "NEG"] }
];

export function EpisodeInfoPanel({ content, scenes, assets, infoPackage, onClose }: EpisodeInfoPanelProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (key: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const isOpen = (key: string) => expanded.has(key);

  return (
    <aside className="infoPanel">
      <div className="infoPanelHead">
        <div><span>EPISODE PACK</span><h2>本集信息包</h2></div>
        {onClose ? (
          <button type="button" className="infoPanelClose" onClick={onClose} aria-label="收起本集信息包">×</button>
        ) : null}
      </div>

      <section className="infoSection">
        <button type="button" className="infoSectionHead" onClick={() => toggle("script")} aria-expanded={isOpen("script")}>
          <span>剧本原文</span>
          <em>{isOpen("script") ? "−" : "+"}</em>
        </button>
        {isOpen("script") ? (
          <div className="scriptFullText">{content || "本集暂无剧本正文。"}</div>
        ) : null}
      </section>

      <section className="infoSection">
        <button type="button" className="infoSectionHead" onClick={() => toggle("scenes")} aria-expanded={isOpen("scenes")}>
          <span>场次结构</span>
          <em>{isOpen("scenes") ? "−" : "+"}</em>
        </button>
        {isOpen("scenes") ? (
          scenes.length ? (
            <div className="sceneChipList">
              {scenes.map((scene) => (
                <div className="sceneChip" key={scene.sceneKey}>
                  <b>{scene.sceneKey}</b>
                  <span>{scene.heading}</span>
                  <small>{scene.timeOfDay} · {scene.interiorExterior} · {scene.timeLayer}</small>
                </div>
              ))}
            </div>
          ) : (
            <p className="panelEmpty">尚未建立场次表</p>
          )
        ) : null}
      </section>

      <section className="infoSection">
        <button type="button" className="infoSectionHead" onClick={() => toggle("assets")} aria-expanded={isOpen("assets")}>
          <span>本集命中资产</span>
          <em>{isOpen("assets") ? "−" : "+"}</em>
        </button>
        {isOpen("assets") ? (
          <div className="assetGroupGrid">
            {ASSET_GROUPS.map((group) => {
              const groupAssets = assets.filter((asset) => group.types.includes(asset.type));
              if (!groupAssets.length) return null;
              return (
                <div className="assetGroup" key={group.key}>
                  <h4>{group.title}</h4>
                  <div className="assetChips">
                    {groupAssets.map((asset) => (
                      <span key={asset.code} title={asset.status === "confirmed" ? "已确认" : "待确认"}>
                        <b>{asset.code}</b><i className="assetChipType">{ASSET_CHIP_TYPE[asset.type] ?? asset.type}</i>{asset.name}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
            {!assets.length ? <p className="panelEmpty">本集暂无命中资产</p> : null}
          </div>
        ) : null}
      </section>

      <section className="infoSection">
        <button type="button" className="infoSectionHead" onClick={() => toggle("json")} aria-expanded={isOpen("json")}>
          <span>完整信息包（JSON）</span>
          <em>{isOpen("json") ? "−" : "+"}</em>
        </button>
        {isOpen("json") ? <pre className="infoPackageJson">{infoPackage || "尚未生成本集信息包。"}</pre> : null}
      </section>
    </aside>
  );
}
