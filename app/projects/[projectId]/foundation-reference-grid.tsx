"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

/**
 * Keep the asset index aligned with the project-bible card while the bible
 * accordions open and close. The table itself remains the only scroll area.
 */
export function FoundationReferenceGrid({ children }: { children: ReactNode }) {
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    const bibleCard = grid.querySelector<HTMLElement>('[data-reference-card="bible"]');
    const bibleBody = bibleCard?.querySelector<HTMLElement>(':scope > .bibleViewer, :scope > .biblePlaceholder');
    const assetCard = grid.querySelector<HTMLElement>('[data-reference-card="assets"]');
    const header = bibleCard?.querySelector<HTMLElement>(":scope > .cardHeader");
    if (!bibleCard || !bibleBody || !assetCard || !header) return;

    const desktop = window.matchMedia("(min-width: 1321px)");
    const syncHeight = () => {
      if (!desktop.matches) {
        assetCard.style.removeProperty("height");
        return;
      }
      const borderHeight = bibleCard.offsetHeight - bibleCard.clientHeight;
      assetCard.style.height = `${Math.ceil(header.offsetHeight + bibleBody.offsetHeight + borderHeight)}px`;
    };
    const observer = new ResizeObserver(syncHeight);
    observer.observe(bibleBody);
    observer.observe(header);
    window.addEventListener("resize", syncHeight);
    desktop.addEventListener?.("change", syncHeight);
    syncHeight();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncHeight);
      desktop.removeEventListener?.("change", syncHeight);
      assetCard.style.removeProperty("height");
    };
  }, []);

  return <div ref={gridRef} className="studioGrid twoColumns foundationReferenceGrid">{children}</div>;
}
