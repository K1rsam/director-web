"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { SelectionMotionProvider } from "./motion-selection";

function RouteMotion({ frame }: { frame: RefObject<HTMLDivElement | null> }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const previous = useRef({ pathname, search });
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLayoutEffect(() => {
    const root = frame.current;
    if (!root) return;
    root.removeAttribute("data-navigating");
    root.querySelectorAll("[data-route-pending]").forEach(el => el.removeAttribute("data-route-pending"));
    clearTimeout(pending.current);
    const old = previous.current;
    previous.current = { pathname, search };
    if ((old.pathname === pathname && old.search === search)
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const animations: Animation[] = [];
    const samePage = old.pathname === pathname;
    // Only incoming content moves; the fixed glass header stays anchored.
    const tick = requestAnimationFrame(() => {
      const selector = samePage
        ? ".episodeReadingCanvas > .storyboardTableWrap, .episodeReadingCanvas > .unitList, .episodeReadingCanvas > .logView"
        : ".appMain > .projectDashboard > *, .appMain > .episodeDashboard > *, .appMain > .projectLibrary > *, .appMain > :not(.projectDashboard):not(.episodeDashboard):not(.projectLibrary)";
      const surfaces = [...root.querySelectorAll<HTMLElement>(selector)].filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
      });
      surfaces.slice(0, 5).forEach((surface, index) => {
        animations.push(surface.animate([
          { opacity: .35, transform: `translate3d(0,${samePage ? 5 : 9}px,0)` },
          { opacity: 1, transform: "translate3d(0,0,0)" }
        ], { duration: samePage ? 240 : 340, delay: index * 28, easing: "cubic-bezier(.2,.78,.2,1)", fill: "backwards" }));
      });
      if (!samePage) {
        const label = root.querySelector<HTMLElement>("[data-route-label]");
        if (label) animations.push(label.animate([{ opacity: .35 }, { opacity: 1 }], { duration: 220, easing: "ease-out" }));
      }
    });
    return () => { cancelAnimationFrame(tick); animations.forEach(animation => animation.cancel()); };
  }, [pathname, search, frame]);

  useEffect(() => {
    const root = frame.current;
    if (!root) return;
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
      if (!link || link.target || link.hasAttribute("download")) return;
      const target = new URL(link.href, location.href);
      if (target.origin !== location.origin || (target.pathname === pathname && target.search === location.search)) return;
      root.querySelectorAll("[data-route-pending]").forEach(el => el.removeAttribute("data-route-pending"));
      link.setAttribute("data-route-pending", "true");
      clearTimeout(pending.current);
      // Cached navigation completes immediately; show progress only for a real wait.
      pending.current = setTimeout(() => {
        root.setAttribute("data-navigating", "true");
        pending.current = setTimeout(() => {
          root.removeAttribute("data-navigating");
          link.removeAttribute("data-route-pending");
        }, 10000);
      }, 180);
    };
    root.addEventListener("click", onClick);
    return () => { root.removeEventListener("click", onClick); clearTimeout(pending.current); };
  }, [pathname, search, frame]);
  return null;
}

export function PageTransition({ children }: { children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  return (
    <SelectionMotionProvider>
      <div ref={frame} className="visionRouteFrame">
        {children}
        <Suspense fallback={null}><RouteMotion frame={frame} /></Suspense>
      </div>
    </SelectionMotionProvider>
  );
}
