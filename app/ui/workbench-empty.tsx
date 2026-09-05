type WorkbenchEmptyProps = {
  kind: "shots" | "units" | "logs" | "issues";
  title: string;
  description: string;
  steps?: string[];
};

const paths = {
  shots: "M4 5h16v14H4z M4 10h16 M9 10v9 M8 5l3 5 M14 5l3 5",
  units: "M7 3h10l4 4v14H7z M17 3v5h4 M3 7v14 M11 12h6 M11 16h4",
  logs: "M12 8v5l3 2 M3 12a9 9 0 1 0 3-6 M3 3v6h6",
  issues: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12h8",
};

/** Empty views describe the current state without implying production or review has run. */
export function WorkbenchEmpty({ kind, title, description, steps }: WorkbenchEmptyProps) {
  return (
    <div className={`workbenchEmpty ${steps ? "with-steps" : ""}`}>
      <span className="workbenchEmptyIcon" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round"><path d={paths[kind]} /></svg>
      </span>
      <div className="workbenchEmptyCopy">
        <h3>{title}</h3>
        <p>{description}</p>
        {steps ? <ol className="workbenchEmptySteps" aria-label="内容制作顺序">{steps.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, "0")}</span>{step}</li>)}</ol> : null}
      </div>
    </div>
  );
}
