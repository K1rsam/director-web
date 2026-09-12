type ImportIssue = { code: string; message: string; start?: number; end?: number; count?: number; sectionKeys?: string[] };

export function ImportIssueSummary({ issues }: { issues: ImportIssue[] }) {
  const groups = new Map<string, ImportIssue[]>();
  for (const issue of issues) {
    const group = groups.get(issue.code) ?? [];
    group.push(issue);
    groups.set(issue.code, group);
  }
  return <div aria-label="待确认事项分类">{[...groups].map(([code, items]) => {
    const ranges = items.filter(i => typeof i.start === "number" && typeof i.end === "number").map(i => ({ start: i.start!, end: i.end! })).sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number }[] = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
    }
    return <details key={code}><summary>{items[0].message}（{items.reduce((sum, item) => sum + (item.count ?? 1), 0)} 处{merged.length ? `，${merged.length} 个范围` : ""}）</summary>
      {merged.length ? <p>来源位置：{merged.slice(0, 5).map(r => `${r.start}–${r.end}`).join("、")}{merged.length > 5 ? "，其余范围已保留" : ""}</p> : null}
      {[...new Set(items.map(i => i.message))].slice(0, 3).map(message => <p key={message}>{message}</p>)}
      <p>同类提示已合并，可在接收与清洗页查看原文并确认范围。</p>
    </details>;
  })}</div>;
}
