"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

function routeLevel(pathname: string) {
  if (pathname === "/") return 0;
  if (pathname.includes("/episodes/")) return 2;
  return 1;
}

export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const previousLevel = useRef(routeLevel(pathname));
  const currentLevel = routeLevel(pathname);
  const direction = currentLevel < previousLevel.current ? "visionRouteBack" : "visionRouteForward";

  useEffect(() => {
    previousLevel.current = currentLevel;
  }, [currentLevel, pathname]);

  return (
    <div className="visionRouteFrame">
      <div className={direction} key={pathname}>{children}</div>
    </div>
  );
}
