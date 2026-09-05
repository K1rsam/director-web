"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { EpisodeInfoPanel, type InfoPanelAsset, type InfoPanelScene } from "./episode-info-panel";

export type WorkspaceGridProps = {
  rail?: ReactNode;
  canvas: ReactNode;
  content: string;
  scenes: InfoPanelScene[];
  assets: InfoPanelAsset[];
  infoPackage: string;
};

/** The information drawer overlays the canvas without changing its reading width. */
export function WorkspaceGrid({ rail, canvas, content, scenes, assets, infoPackage }: WorkspaceGridProps) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    dialog.showModal();
    return () => {
      dialog.close();
      triggerRef.current?.focus();
    };
  }, [open]);

  return (
    <div className={`workspaceGrid ${rail ? "with-rail" : "no-rail"}`}>
      {rail ?? null}
      {canvas}
      {open ? (
        <dialog ref={dialogRef} className="infoPanelBackdrop" aria-label="本集信息包" onCancel={() => setOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <aside className="infoPanelArea" onClick={(event) => event.stopPropagation()}>
            <EpisodeInfoPanel
              content={content}
              scenes={scenes}
              assets={assets}
              infoPackage={infoPackage}
              onClose={() => setOpen(false)}
            />
          </aside>
        </dialog>
      ) : null}
        <button ref={triggerRef} type="button" className="infoPanelToggleBtn" onClick={() => setOpen(true)} aria-label="展开本集信息包" aria-haspopup="dialog" aria-expanded={open}>
          本集信息包 <span aria-hidden="true">◂</span>
        </button>
    </div>
  );
}
