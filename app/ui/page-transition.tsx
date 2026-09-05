"use client";

import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";

function routeLevel(pathname: string) {
  if (pathname === "/") return 0;
  if (pathname.includes("/episodes/")) return 2;
  return 1;
}

export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const frame = useRef<HTMLDivElement>(null);
  const previous = useRef(pathname);
  const selectedTop = useRef<number | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLayoutEffect(() => {
    const root = frame.current;
    if (!root) return;
    root.removeAttribute("data-navigating");
    root.querySelectorAll("[data-route-pending]").forEach(el => el.removeAttribute("data-route-pending"));
    clearTimeout(pending.current);
    const changed = previous.current !== pathname;
    const direction = routeLevel(pathname) < routeLevel(previous.current) ? -1 : 1;
    previous.current = pathname;
    if (!changed || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Keep navigation anchored while the destination workspace settles into place.
    const animations: Animation[] = [];
    [".appTopbar", ".appMain"].forEach((selector, index) => {
      const surface = root.querySelector<HTMLElement>(selector);
      if (surface) animations.push(surface.animate([
        { opacity: .35, transform: `translate3d(${direction * (index ? 14 : 7)}px,${index ? 5 : 0}px,0)` },
        { opacity: 1, transform: "translate3d(0,0,0)" }
      ], { duration: index ? 380 : 280, easing: "cubic-bezier(.22,.8,.28,1)" }));
    });
    const selected = root.querySelector<HTMLElement>(".sidebarNav [aria-current=page], .sidebarEpisodeScroller [aria-current=page]");
    if (selected && selectedTop.current !== null) {
      const distance = Math.max(-48, Math.min(48, selectedTop.current - selected.getBoundingClientRect().top));
      animations.push(selected.animate([{ transform: `translateY(${distance}px)`, opacity: .55 }, { transform: "translateY(0)", opacity: 1 }], { duration: 340, easing: "cubic-bezier(.22,.8,.28,1)" }));
    }
    selectedTop.current = null;
    return () => animations.forEach(animation => animation.cancel());
  }, [pathname]);

  useEffect(() => {
    const root = frame.current;
    if (!root) return;
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
      if (!link || link.target || link.hasAttribute("download")) return;
      const target = new URL(link.href, location.href);
      if (target.origin !== location.origin || target.pathname === pathname) return;
      const selected = root.querySelector<HTMLElement>(".sidebarNav [aria-current=page], .sidebarEpisodeScroller [aria-current=page]");
      selectedTop.current = selected?.getBoundingClientRect().top ?? null;
      root.querySelectorAll("[data-route-pending]").forEach(el => el.removeAttribute("data-route-pending"));
      link.setAttribute("data-route-pending", "true");
      root.setAttribute("data-navigating", "true");
      clearTimeout(pending.current);
      pending.current = setTimeout(() => {
        root.removeAttribute("data-navigating");
        link.removeAttribute("data-route-pending");
      }, 10000);
    };
    root.addEventListener("click", onClick);
    return () => { root.removeEventListener("click", onClick); clearTimeout(pending.current); };
  }, [pathname]);

  return (
    <div ref={frame} className="visionRouteFrame">{children}</div>
  );
}
