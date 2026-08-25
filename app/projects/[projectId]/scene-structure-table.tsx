"use client";

import { useState } from "react";

export type SceneStructureRow = {
  episodeNumber: number;
  sceneKey: string;
  heading: string;
  location: string;
  timeOfDay: string;
  interiorExterior: string;
  weather: string;
  timeLayer: string;
  sourceText: string;
};

/** 全剧场次结构表：可收起 + 内部滚动（不再强制整页滑过全部场次）。 */
export function SceneStructureTable({ scenes }: { scenes: SceneStructureRow[] }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="studioCard fullWidthCard">
      <button type="button" className="sceneStructureHead" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <div className="cardHeader" style={{ borderBottom: "none" }}>
          <div><span>SCENE STRUCTURE</span><h3>全剧场次结构表</h3></div>
          <em>{scenes.length}场 · {open ? "收起" : "展开"}</em>
        </div>
      </button>
      {open ? (
        <div className="sceneStructureScroll">
          <div className="studioTableScroll sceneTable">
            <table className="sceneStructureTable">
              <colgroup>
                <col className="sceneColEpisode" />
                <col className="sceneColKey" />
                <col className="sceneColLocation" />
                <col className="sceneColTime" />
                <col className="sceneColInterior" />
                <col className="sceneColWeather" />
                <col className="sceneColLayer" />
                <col className="sceneColSource" />
              </colgroup>
              <thead><tr><th>集</th><th>场次</th><th>场景</th><th>时间</th><th>内外</th><th>天气</th><th>时间层</th><th>源文</th></tr></thead>
              <tbody>
                {scenes.map((scene) => (
                  <tr key={`${scene.episodeNumber}-${scene.sceneKey}`}>
                    <td>第{scene.episodeNumber}集</td><td>{scene.sceneKey}</td><td>{scene.location ?? scene.heading}</td><td>{scene.timeOfDay ?? "待补充"}</td><td>{scene.interiorExterior ?? "待补充"}</td><td>{scene.weather ?? "默认"}</td><td>{scene.timeLayer}</td><td className="wideText">{scene.sourceText.replace(/\s+/g, " ").slice(0, 100)}</td>
                  </tr>
                ))}
                {!scenes.length ? <tr><td colSpan={8} className="emptyCell">重新执行第一阶段后，将自动形成按集、场次可查看的结构表。</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </article>
  );
}
