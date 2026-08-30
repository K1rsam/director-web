"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="visionRouteFrame">
      <div className="visionRouteForward" key={pathname}>{children}</div>
    </div>
  );
}
