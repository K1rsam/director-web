"use client";

import { useState, type ReactNode } from "react";
import { EpisodeInfoPanel, type InfoPanelAsset, type InfoPanelScene } from "./episode-info-panel";

export type WorkspaceGridProps = {
  rail?: ReactNode;
  canvas: ReactNode;
  content: string;
  scenes: InfoPanelScene[];
  assets: InfoPanelAsset[];
  infoPackage: string;
};

/**
 * 单集工作台网格：
 * - 默认只有两列（剧集栏 + 主内容），右上角一个正常大小的「本集信息包」浮动按钮，不占版面；
 * - 点击后网格追加第三列（330px 平滑展开），把分镜表/单元/日志整体向左推，信息包板块推出。
 */
export function WorkspaceGrid({ rail, canvas, content, scenes, assets, infoPackage }: WorkspaceGridProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`workspaceGrid ${rail ? "with-rail" : "no-rail"}`}>
      {rail ?? null}
      {canvas}
      {open ? (
        <div className="infoPanelBackdrop" role="presentation" onClick={() => setOpen(false)}>
          <aside className="infoPanelArea" onClick={(event) => event.stopPropagation()}>
            <EpisodeInfoPanel
              content={content}
              scenes={scenes}
              assets={assets}
              infoPackage={infoPackage}
              onClose={() => setOpen(false)}
            />
          </aside>
        </div>
      ) : (
        <button type="button" className="infoPanelToggleBtn" onClick={() => setOpen(true)} aria-label="展开本集信息包">
          本集信息包 <span aria-hidden="true">◂</span>
        </button>
      )}
    </div>
  );
}
