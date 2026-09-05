"use client";

import type { ReactNode } from "react";

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
  episodeLabel?: string;
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

function PackSection({ title, meta, icon, open, children }: { title: string; meta: string; icon: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="infoSection" open={open}>
      <summary className="infoSectionHead">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icon} /></svg>
        <span>{title}</span><small>{meta}</small>
        <svg className="infoSectionChevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
      </summary>
      <div className="infoSectionContent">{children}</div>
    </details>
  );
}

export function EpisodeInfoPanel({ episodeLabel, content, scenes, assets, infoPackage, onClose }: EpisodeInfoPanelProps) {
  return (
    <aside className="infoPanel">
      <div className="infoPanelHead">
        <div><span>EPISODE PACK</span><h2>本集信息包</h2><p>{episodeLabel || "剧本、场次与本集引用资料"}</p></div>
        {onClose ? (
          <button type="button" className="infoPanelClose" onClick={onClose} aria-label="收起本集信息包" autoFocus><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12 M18 6 6 18" /></svg></button>
        ) : null}
      </div>

      <div className="infoPanelBody">
      <div className="infoPackOverview" aria-label="信息包概览"><span><b>{scenes.length}</b> 场戏</span><span><b>{assets.length}</b> 项资产</span><span>{infoPackage ? "信息包已整理" : "信息包待整理"}</span></div>
      <PackSection title="剧本原文" meta={content ? "查看全文" : "待补充"} icon="M5 3h10l4 4v14H5z M14 3v5h5 M9 12h6 M9 16h6" open={!scenes.length && !assets.length}>
        <div className="scriptFullText">{content || "本集暂无剧本正文。"}</div>
      </PackSection>

      <PackSection title="场次结构" meta={`${scenes.length} 场`} icon="M4 5h16v14H4z M4 10h16 M8 5l3 5 M14 5l3 5" open={Boolean(scenes.length)}>
          {scenes.length ? (
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
          )}
      </PackSection>

      <PackSection title="本集引用资产" meta={`${assets.length} 项`} icon="m12 3 9 5-9 5-9-5z M3 12l9 5 9-5 M3 16l9 5 9-5" open={Boolean(assets.length)}>
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
      </PackSection>

      <PackSection title="完整信息包" meta="JSON" icon="m8 7-5 5 5 5 M16 7l5 5-5 5 M14 4l-4 16">
        <pre className="infoPackageJson">{infoPackage || "尚未生成本集信息包。"}</pre>
      </PackSection>
      </div>
    </aside>
  );
}
