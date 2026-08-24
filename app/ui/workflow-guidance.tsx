import Link from "next/link";
import type { ReactNode } from "react";

export function WorkflowGuidance({
  eyebrow,
  title,
  description,
  href,
  actionLabel,
  action,
  meta
}: {
  eyebrow: string;
  title: string;
  description: string;
  href?: string;
  actionLabel?: string;
  action?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <section className="workflowGuidance" aria-labelledby="workflow-guidance-title">
      <div className="guidanceSignal" aria-hidden="true"><span>→</span></div>
      <div className="guidanceCopy">
        <p>{eyebrow}</p>
        <h1 id="workflow-guidance-title">{title}</h1>
        <span>{description}</span>
      </div>
      {meta ? <div className="guidanceMeta">{meta}</div> : null}
      {action ?? (href && actionLabel ? <Link href={href} className="glassPrimary">{actionLabel}<span aria-hidden="true">→</span></Link> : null)}
    </section>
  );
}
