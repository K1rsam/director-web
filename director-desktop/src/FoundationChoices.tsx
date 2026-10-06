import { useEffect, useState } from 'react';
import { request } from './api';
import { Badge, Button, messageOf } from './components';
import type { Mutation, Workspace } from './types';

type Choice = { id: string; decisionKey: string; revision: number; status: 'PENDING' | 'CONFIRMED' | 'APPLIED'; question: string; reason?: string; options: string[]; recommended?: string; evidence?: string; sourceRefs: string[]; interpretationOnly: boolean; requiresUserReview?: boolean; answer?: string; appliedNote?: string };
type Choices = { sourceVersion: number; foundationVersion: number; contracts: Choice[] };
type Props = { workspace: Workspace; writable: boolean; mutate: Mutation; onError?: (message: string) => void; onNotice?: (message: string) => void; onRead: (title: string, refs: unknown) => void };

export function FoundationChoices({ workspace, writable, mutate, onError, onNotice, onRead }: Props) {
  const [data, setData] = useState<Choices | null>(null), [drafts, setDrafts] = useState<Record<string, string>>({}), [busy, setBusy] = useState(''), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const projectId = workspace.project.id, sourceVersion = workspace.source?.version, foundationVersion = Number(workspace.foundation?.version || 0);
  useEffect(() => {
    let current = true;
    setData(null); setError(''); setDrafts({});
    if (foundationVersion) void request<Choices>({ action: 'foundation.choices.list', projectId }).then(value => { if (current) setData(value); }).catch(reason => { if (current) setError(messageOf(reason)); });
    return () => { current = false; };
  }, [projectId, sourceVersion, foundationVersion, retry]);
  const confirmed = data?.contracts.filter(item => item.requiresUserReview && item.status === 'CONFIRMED').length || 0;
  const running = workspace.jobs.some(job => job.kind === 'workflow' && ['queued', 'running'].includes(job.status));
  async function confirm(item: Choice) {
    if (!data) return;
    const customAnswer = (drafts[item.id] ?? item.answer ?? '').trim();
    if (!customAnswer) return;
    setBusy(item.id);
    try {
      const next = await request<Choices>({ action: 'foundation.choice.confirm', projectId, contractId: item.id, revision: item.revision, expectedSourceVersion: data.sourceVersion, expectedFoundationVersion: data.foundationVersion, customAnswer });
      setData(next); setDrafts(current => { const value = { ...current }; delete value[item.id]; return value; });
      onNotice?.('处理意见已确认。点击“应用已确认处理”后，由原资料整编流程更新制作基础。');
    } catch (reason) { onError?.(messageOf(reason)); } finally { setBusy(''); }
  }
  async function apply() {
    if (!data) return;
    setBusy('apply');
    try { await mutate('foundation.choices.apply', { expectedSourceVersion: data.sourceVersion, expectedFoundationVersion: data.foundationVersion }, '已开始应用确认的处理意见，沿用原资料整编流程。'); }
    finally { setBusy(''); }
  }
  if (error) return <div className="production-inline-warning">处理意见读取失败：{error}<Button onClick={() => setRetry(value => value + 1)}>重新读取</Button></div>;
  const visible = data?.contracts.filter(item => item.requiresUserReview || item.status === 'APPLIED') || [];
  if (!visible.length) return null;
  const waiting = visible.some(item => item.requiresUserReview && item.status !== 'APPLIED');
  return <details className="foundation-choices" open={waiting}>
    <summary>制作判断记录 · {visible.length} 项{waiting ? ' · 有指定审阅事项' : ' · 已自动处理'}</summary>
    <div className="production-reading-actions"><p className="muted">CLI 自动择优并继续，原文保持完整；这里只确认事先指定需要审阅的事项。</p>{waiting && <Button variant="primary" disabled={!writable || !!busy || running || !confirmed} onClick={() => void apply()}>应用已确认处理{confirmed ? ` · ${confirmed} 项` : ''}</Button>}</div>
    {visible.map(item => <article className="foundation-choice" key={item.id}>
      <div className="foundation-choice-heading"><strong>{item.question}</strong><Badge status={item.status === 'APPLIED' ? 'completed' : item.status === 'CONFIRMED' ? 'needs_review' : 'blocked'}>{item.status === 'APPLIED' ? '已应用' : item.status === 'CONFIRMED' ? '已确认待应用' : '待确认'}</Badge></div>
      {item.reason && <p className="prose">{item.reason}</p>}
      {item.evidence && <p className="muted">{item.evidence}</p>}
      {item.status === 'APPLIED' ? <p className="prose">{item.answer}{item.appliedNote ? `\n${item.appliedNote}` : ''}</p> : <>
        {!item.interpretationOnly && item.options.length > 0 && <div className="foundation-choice-options">{item.options.map((option, index) => <Button key={index} disabled={!writable || !!busy || running} onClick={() => setDrafts(current => ({ ...current, [item.id]: option }))}>{option}</Button>)}</div>}
        <label>制作处理意见<textarea rows={3} value={drafts[item.id] ?? item.answer ?? ''} onChange={event => setDrafts(current => ({ ...current, [item.id]: event.target.value }))} placeholder="确认人物身份、数量或视觉表现，原文台词与说者记录保留。"/></label>
      </>}
      <div className="actions"><Button variant="ghost" icon="source" onClick={() => onRead(item.question, item.sourceRefs)}>回读原文依据</Button>{item.status !== 'APPLIED' && <Button icon="check" disabled={!writable || !!busy || running || !(drafts[item.id] ?? item.answer ?? '').trim()} onClick={() => void confirm(item)}>{busy === item.id ? '正在保存' : '确认处理意见'}</Button>}</div>
    </article>)}
  </details>;
}
