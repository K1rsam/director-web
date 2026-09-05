"use client";

import { createContext, useContext, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

type Position = { key: string; x: number; y: number; width: number; height: number; containerWidth: number };
const SelectionPositions = createContext<Map<string, Position> | null>(null);

export function SelectionMotionProvider({ children }: { children: ReactNode }) {
  const positions = useRef(new Map<string, Position>());
  return <SelectionPositions.Provider value={positions.current}>{children}</SelectionPositions.Provider>;
}

/** One moving glass surface; labels and hit targets never move with the highlight. */
export function MotionSelection({ as: Tag = "nav", group, activeKey, className, label, containerRef, children }: {
  as?: "nav" | "div" | "span";
  group: string;
  activeKey: string;
  className: string;
  label?: string;
  containerRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const localRef = useRef<HTMLElement | null>(null);
  const glassRef = useRef<HTMLSpanElement>(null);
  const animation = useRef<Animation | null>(null);
  const sharedPositions = useContext(SelectionPositions);
  const localPositions = useRef(new Map<string, Position>());
  const positions = sharedPositions ?? localPositions.current;

  useLayoutEffect(() => {
    const container = localRef.current, glass = glassRef.current;
    if (!container || !glass) return;
    const measure = (animate: boolean) => {
      const selected = container.querySelector<HTMLElement>("[aria-current=page], [aria-pressed=true]");
      if (!selected) {
        glass.style.opacity = "0";
        container.removeAttribute("data-selection-ready");
        return;
      }
      const box = selected.getBoundingClientRect(), parent = container.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const next: Position = {
        key: activeKey,
        x: box.left - parent.left + container.scrollLeft - container.clientLeft,
        y: box.top - parent.top + container.scrollTop - container.clientTop,
        width: box.width, height: box.height, containerWidth: container.clientWidth
      };
      const previous = positions.get(group);
      animation.current?.cancel();
      Object.assign(glass.style, { width: `${next.width}px`, height: `${next.height}px`, opacity: "1", transform: `translate3d(${next.x}px,${next.y}px,0)` });
      container.setAttribute("data-selection-ready", "true");
      if (animate && previous && previous.key !== next.key
        && Math.abs(previous.containerWidth - next.containerWidth) < 2
        && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        animation.current = glass.animate([
          { transform: `translate3d(${previous.x}px,${previous.y}px,0)`, width: `${previous.width}px`, height: `${previous.height}px` },
          { transform: `translate3d(${next.x}px,${next.y}px,0)`, width: `${next.width}px`, height: `${next.height}px` }
        ], { duration: 380, easing: "cubic-bezier(.2,.78,.2,1)" });
      }
      positions.set(group, next);
    };
    measure(true);
    let width = container.clientWidth, height = container.clientHeight;
    const observer = new ResizeObserver(() => {
      if (width === container.clientWidth && height === container.clientHeight) return;
      width = container.clientWidth; height = container.clientHeight;
      measure(false);
    });
    observer.observe(container);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stop = () => { if (reduced.matches) animation.current?.cancel(); };
    reduced.addEventListener("change", stop);
    return () => { observer.disconnect(); reduced.removeEventListener("change", stop); animation.current?.cancel(); };
  }, [activeKey, group, positions]);

  return (
    <Tag ref={(node: HTMLElement | null) => { localRef.current = node; if (containerRef) containerRef.current = node as HTMLDivElement | null; }}
      className={`${className} motionSelection`} aria-label={label} data-selection-group={group}>
      <span ref={glassRef} className="selectionGlass" aria-hidden="true" />
      {children}
    </Tag>
  );
}
