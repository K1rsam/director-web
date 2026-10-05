import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Modal } from './components';
import type { Mutation, Source } from './types';

type Row = NonNullable<Source['rows']>[number];
type Diagnostic = NonNullable<Source['diagnostics']>[number];
export type SourceFragment = { id: string; code: string; message: string; first: number; last: number; rows: Row[] };
const LOCAL_SCOPE_CODES = new Set(['BOUNDARY_UNCONFIRMED', 'SCENE_BOUNDARY_UNCONFIRMED']);

// A diagnostic can name several disconnected fragments. Empty original lines may
// join a fragment; recognized headings and body must never be swallowed by it.
export function sourceFragments(source?: Source | null): SourceFragment[] {
  const rows = source?.rows || [], fragments: SourceFragment[] = [];
  for (const issue of source?.diagnostics || []) {
    if (!issue.blocking || !LOCAL_SCOPE_CODES.has(issue.code)) continue;
    const ids = new Set(issue.rowIds || []), indices = rows.flatMap((row, index) => ids.has(row.id) ? [index] : []);
    let first = -1, last = -1;
    function append() { if (first >= 0) fragments.push({ id: `${issue.code}:${rows[first].id}:${rows[last].id}`, code: issue.code, message: issue.message, first, last, rows: rows.slice(first, last + 1) }); }
    for (const index of indices) {
      if (first < 0) first = last = index;
      else if (rows.slice(last + 1, index).every(row => !row.text.trim())) last = index;
      else { append(); first = last = index; }
    }
    append();
  }
  return fragments;
}

export function sourceContextRows(source?: Source | null): Row[] {
  const rows = source?.rows || [], indices = rows.flatMap((row, index) => row.kind === 'context' ? [index] : []);
  if (!indices.length) return [];
  return rows.filter((row, index) => row.kind === 'context' || index > indices[0] && index < indices[indices.length - 1] && !row.text.trim() && !row.episodeId);
}

function originalEpisodeNumber(value?: string | number): string {
  if (typeof value === 'number') return value > 0 ? String(value) : '';
  if (!value) return '';
  if (/^\d+$/.test(value)) return Number(value) > 0 ? String(Number(value)) : '';
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }, units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0, digit = 0;
  for (const char of value) { if (char in digits) digit = digits[char]; else if (char in units) { total += (digit || 1) * units[char]; digit = 0; } else return ''; }
  return total + digit > 0 ? String(total + digit) : '';
}

function fragmentDefaults(source: Source, fragment: SourceFragment) {
  const episodeIds = [...new Set(fragment.rows.flatMap(row => row.episodeId ? [row.episodeId] : []))], sceneIds = [...new Set(fragment.rows.flatMap(row => row.sceneId ? [row.sceneId] : []))];
  const episode = episodeIds.length === 1 ? source.episodes?.find(item => item.id === episodeIds[0]) : undefined;
  const scene = sceneIds.length === 1 ? source.scenes?.find(item => item.id === sceneIds[0]) : undefined;
  return { number: originalEpisodeNumber(episode?.sourceNumber || episode?.number), sceneTitle: scene?.title || '' };
}

export type SourceReadScope = { kind: 'context' | 'episode' | 'scene'; episodeId?: string; sceneId?: string };
type Props = { source: Source; writable: boolean; mutate: Mutation; onReadScope: (scope: SourceReadScope) => void };
export function SourceStructure({ source, writable, mutate, onReadScope }: Props) {
  const fragments = sourceFragments(source), otherIssues = (source.diagnostics || []).filter(issue => issue.blocking && !LOCAL_SCOPE_CODES.has(issue.code));
  const episodes = source.episodes || [], scenes = source.scenes || [], contextRows = sourceContextRows(source);
  const [expanded, setExpanded] = useState(false), [active, setActive] = useState<{ fragment: SourceFragment; version: number } | null>(null);
  const [kind, setKind] = useState(''), [number, setNumber] = useState(''), [sceneTitle, setSceneTitle] = useState(''), [startLine, setStartLine] = useState(0), [endLine, setEndLine] = useState(0);
  useEffect(() => { setActive(null); setKind(''); }, [source.version, source.sha256]);
  function open(fragment: SourceFragment) {
    const defaults = fragmentDefaults(source, fragment);
    setActive({ fragment, version: source.version || 0 }); setKind(''); setNumber(defaults.number); setSceneTitle(defaults.sceneTitle);
    setStartLine(fragment.rows[0].number); setEndLine(fragment.rows[fragment.rows.length - 1].number);
  }
  const selectedRows = active?.fragment.rows.filter(row => row.number >= startLine && row.number <= endLine) || [];
  const validRange = !!active && active.fragment.rows.some(row => row.number === startLine) && active.fragment.rows.some(row => row.number === endLine) && startLine <= endLine;
  const current = !!active && active.version === (source.version || 0);
  const validBody = /^[1-9]\d*$/.test(number) && !!sceneTitle.trim();
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!current || !validRange || !['body', 'context'].includes(kind) || kind === 'body' && !validBody) return;
    const first = selectedRows[0], last = selectedRows[selectedRows.length - 1];
    const reason = kind === 'context' ? `用户将原文第 ${first.number}–${last.number} 行标记为补充资料，原文保留。` : `用户将原文第 ${first.number}–${last.number} 行归入第 ${Number(number)} 集「${sceneTitle.trim()}」，原文保留。`;
    const next = await mutate('source.resolve', { expectedSourceVersion: active!.version, decisions: [{ start: first.range.start, end: last.range.end, kind, episodeNumber: kind === 'body' ? Number(number) : null, sceneTitle: kind === 'body' ? sceneTitle.trim() : null, reason }] }, kind === 'context' ? '这段已作为补充资料保留，原文没有改动。' : '这段已归入指定集场，原文没有改动。');
    if (next) setActive(null);
  }
  const pendingCount = fragments.length + otherIssues.length;
  return <div className="source-structure">
    <div className="source-structure-summary"><div><strong>已识别 {episodes.length} 集 / {scenes.length} 场</strong><span>{contextRows.length ? '背景资料已保留' : '完整原文已保留'}{pendingCount ? ` · ${pendingCount} 处待确认` : ' · 可直接整理制作基础'}</span></div><div className="actions"><Button variant="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? '收起分集结构' : '查看分集结构'}</Button><Button icon="refresh" disabled={!writable} onClick={() => void mutate('source.reparse', { expectedSourceVersion: source.version || 0 }, '集场结构已重新识别，原文保持原样。')}>重新识别</Button></div></div>
    {expanded && <div className="source-structure-directory" aria-label="原文识别结构">{contextRows.length > 0 && <button className="source-context-link" onClick={() => onReadScope({ kind: 'context' })}><strong>背景资料</strong><span>故事简介、人物资料等 · 原文保留</span></button>}{episodes.map(episode => <article key={episode.id || episode.title}><button onClick={() => onReadScope({ kind: 'episode', episodeId: episode.id })}><strong>{episode.title || `第 ${episode.number} 集`}</strong><span>{scenes.filter(scene => scene.episodeId === episode.id).length} 场</span></button><div>{scenes.filter(scene => scene.episodeId === episode.id).map(scene => <button key={scene.id} onClick={() => onReadScope({ kind: 'scene', episodeId: episode.id, sceneId: scene.id })}>{scene.title}</button>)}</div></article>)}{!episodes.length && <p className="muted">暂未识别到分集标题；可重新识别或确认下方的局部片段。</p>}</div>}
    {fragments.length > 0 && <div className="source-fragment-list">{fragments.map(fragment => <article key={fragment.id}><div><strong>{fragment.code === 'SCENE_BOUNDARY_UNCONFIRMED' ? '这段正文缺少场景' : '这段内容的用途待确认'}</strong><span>原文第 {fragment.rows[0].number}–{fragment.rows[fragment.rows.length - 1].number} 行</span></div><p>{fragment.rows.map(row => row.text).join('').trim().slice(0, 140)}</p><Button disabled={!writable} onClick={() => open(fragment)}>确认这段用途</Button></article>)}</div>}
    {otherIssues.map((issue: Diagnostic, index) => <div className="production-inline-warning" key={`${issue.code}:${index}`}><strong>原文仍有待处理事项</strong><p>{issue.message}</p>{issue.code === 'DIALOGUE_MULTI_SPEAKER_UNCONFIRMED' && <p>这是说者分段问题，不能通过调整集场或改成资料解决。</p>}</div>)}
    {active && current && <Modal title="确认这段内容的用途" onClose={() => setActive(null)}><form onSubmit={event => void save(event)}><p className="muted">仅处理下方片段，已识别的其他集场保持原样。</p><pre className="production-source-document source-fragment-preview">{selectedRows.map(row => row.text).join('')}</pre><fieldset className="source-fragment-options"><legend>这段内容是</legend><label><input type="radio" name="fragment-kind" checked={kind === 'context'} onChange={() => setKind('context')}/>补充资料</label><label><input type="radio" name="fragment-kind" checked={kind === 'body'} onChange={() => setKind('body')}/>正文剧情</label></fieldset>{kind === 'context' && <p className="muted">保留为故事与人物资料，后续整理时会读取。</p>}{kind === 'body' && <div className="form-grid"><label>所属集号<input type="number" min={1} step={1} required value={number} onChange={event => setNumber(event.target.value)} placeholder="填写原文所属集号"/></label><label>场景名称<input required value={sceneTitle} onChange={event => setSceneTitle(event.target.value)} placeholder="填写这段发生的场景"/></label></div>}<details className="production-secondary"><summary>调整片段范围</summary><p>只在当前待确认片段内选择完整原行。</p><div className="form-grid"><label>起始行<input type="number" min={active.fragment.rows[0].number} max={active.fragment.rows[active.fragment.rows.length - 1].number} value={startLine} onChange={event => setStartLine(Number(event.target.value))}/></label><label>结束行<input type="number" min={active.fragment.rows[0].number} max={active.fragment.rows[active.fragment.rows.length - 1].number} value={endLine} onChange={event => setEndLine(Number(event.target.value))}/></label></div>{!validRange && <p className="warning">请选择当前片段内的有效起止行。</p>}</details><div className="form-actions"><Button onClick={() => setActive(null)}>取消</Button><Button type="submit" variant="primary" disabled={!writable || !current || !validRange || !kind || kind === 'body' && !validBody}>{kind === 'context' ? '保留为补充资料' : kind === 'body' ? '归入这集正文' : '请选择用途'}</Button></div></form></Modal>}
  </div>;
}
