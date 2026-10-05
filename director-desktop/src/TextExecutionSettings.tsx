import { useCallback, useEffect, useRef, useState } from 'react';
import { choose, request } from './api';
import { Badge, Button, formatDate, messageOf } from './components';
import type { Settings, TextCliLimitWindow, TextCliLogin, TextCliStatus, Workspace } from './types';

type Props = { workspace: Workspace; settings: Settings; writable: boolean; update: (key: string, value: string) => void; saveSettings: () => Promise<boolean>; onError?: (message: string) => void };

export function TextExecutionSummary({ settings, onConfigure, stage }: { settings: Settings; onConfigure: () => void; stage?: 'foundation' | 'images' | 'storyboard' }) {
  return <div className="text-execution-summary"><span>{stage === 'images' ? '提示词设计' : '文本执行'}：{settings.textProvider === 'api' ? '文本 API' : 'Codex CLI'} · {settings.textModel || '未选择模型'}{settings.textProvider !== 'api' ? ` · ${settings.reasoning || 'medium'}` : ''}{stage === 'images' ? '；图片按出图渠道生成' : ''}</span><Button variant="ghost" icon="settings" onClick={onConfigure}>调整执行设置</Button></div>;
}

function windowText(window?: TextCliLimitWindow | null): string | undefined {
  if (!window) return;
  const minutes = window.windowDurationMins;
  const period = minutes && minutes >= 1440 ? `${Math.round(minutes / 1440)} 天` : minutes && minutes >= 60 ? `${Math.round(minutes / 60)} 小时` : minutes ? `${minutes} 分钟` : '当前';
  const remaining = typeof window.remainingPercent === 'number' ? window.remainingPercent : typeof window.usedPercent === 'number' ? 100 - window.usedPercent : undefined;
  return remaining === undefined ? undefined : `${period}额度剩余 ${Math.max(0, Math.min(100, remaining)).toFixed(0)}%`;
}

export function TextExecutionSettings({ workspace, settings, writable, update, saveSettings, onError }: Props) {
  const [status, setStatus] = useState<TextCliStatus | null>(null), [login, setLogin] = useState<TextCliLogin>({ state: 'idle' }), [busy, setBusy] = useState(false), [error, setError] = useState(''), [checkedPath, setCheckedPath] = useState<string | null>(null);
  const sequence = useRef(0), mounted = useRef(true), autoCheckedProject = useRef(''), projectId = workspace.project.id;
  const provider = settings.textProvider || 'codex', models = status?.models || [], selectedModel = models.find(model => model.id === settings.textModel);
  const efforts = selectedModel?.supportedReasoningEfforts || [], reasoning = settings.reasoning || 'medium';
  const path = String(settings.codexPath || ''), pathRef = useRef(path); pathRef.current = path;

  const check = useCallback(async () => {
    const current = ++sequence.current;
    setBusy(true); setError('');
    try {
      const checkingPath = pathRef.current;
      const next = await request<TextCliStatus>({ action: 'textCli.status', projectId, settings: { codexPath: checkingPath } });
      if (!mounted.current || current !== sequence.current) return;
      setStatus(next); setCheckedPath(checkingPath); if (next.login) setLogin(next.login);
    } catch (reason) { if (mounted.current && current === sequence.current) setError(messageOf(reason)); }
    finally { if (mounted.current && current === sequence.current) setBusy(false); }
  }, [projectId]);

  useEffect(() => { mounted.current = true; setStatus(null); setCheckedPath(null); setLogin({ state: 'idle' }); return () => { mounted.current = false; sequence.current++; }; }, [projectId]);
  useEffect(() => { if (writable && autoCheckedProject.current !== projectId) { autoCheckedProject.current = projectId; void check(); } }, [projectId, writable, check]);
  useEffect(() => {
    if (login.state !== 'pending' || !writable) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await request<{ login: TextCliLogin }>({ action: 'textCli.loginStatus', projectId });
        if (cancelled) return;
        setLogin(next.login);
        if (next.login.state === 'pending') timer = setTimeout(() => void poll(), 3000);
        else if (next.login.state === 'completed') void check();
        else if (next.login.error) setError(next.login.error);
      } catch (reason) { if (!cancelled) { setError(messageOf(reason)); timer = setTimeout(() => void poll(), 5000); } }
    }
    timer = setTimeout(() => void poll(), 3000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [login.state, projectId, writable, check]);

  async function loginAction(action: 'textCli.login' | 'textCli.cancelLogin' | 'textCli.openLogin') {
    setBusy(true); setError('');
    try {
      if (action === 'textCli.login' && !await saveSettings()) return;
      const next = await request<{ login?: TextCliLogin }>({ action, projectId });
      if (mounted.current && next.login) setLogin(next.login);
    } catch (reason) { if (mounted.current) setError(messageOf(reason)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function selectExecutable() { try { const paths = await choose('file'); if (paths[0]) update('codexPath', paths[0]); } catch (reason) { onError?.(messageOf(reason)); } }
  const pathChanged = checkedPath !== null && checkedPath !== path;
  const labels = busy ? '正在检查' : login.state === 'pending' ? '等待网页登录' : pathChanged ? '路径待检查' : status?.ready ? '可执行' : status?.available ? status.loggedIn ? '需要处理' : '未登录' : status ? '未找到 CLI' : '尚未检查';

  return <section className="surface text-execution-settings"><div className="section-heading compact"><h3>文本执行 · 阶段 1 / 2 / 3</h3>{provider === 'codex' && <Badge status={!pathChanged && status?.ready ? 'available' : busy || login.state === 'pending' ? 'running' : 'not_configured'}>{labels}</Badge>}</div>
    <p className="muted">制作基础、图片提示词设计、分镜文字共用此设置。图片和视频生成使用各自渠道。</p>
    <label>文本渠道<select value={provider} onChange={event => update('textProvider', event.target.value)}><option value="codex">Codex CLI</option><option value="api">文本 API</option></select></label>
    {provider === 'codex' ? <>
      <label>Codex CLI 程序<div className="text-cli-path"><input value={path} onChange={event => update('codexPath', event.target.value)} placeholder="自动查找本机 Codex CLI，或填写完整路径"/><Button icon="source" disabled={!writable || busy} onClick={() => void selectExecutable()}>选择程序</Button></div></label>
      {status?.executable && <p className="control-hint text-cli-resolved">{status.version || 'Codex CLI'} · {status.executable}</p>}
      {pathChanged && <p className="control-hint">程序路径已更改，请重新检查并保存本机设置。下方模型目录来自上次检查。</p>}
      <div className="text-cli-account"><strong>{status?.account?.email || (status?.loggedIn ? '已登录本机 Codex 账户' : '连接本机 Codex 账户')}</strong>{status?.account?.planType && <span className="badge">{status.account.planType}</span>}</div>
      <div className="actions"><Button icon="refresh" disabled={!writable || busy} onClick={() => void check()}>检查 CLI 与账户</Button>{login.state === 'pending' ? <><Button disabled={!writable || busy} onClick={() => void loginAction('textCli.openLogin')}>打开登录网页</Button><Button disabled={!writable || busy} onClick={() => void loginAction('textCli.cancelLogin')}>取消等待</Button></> : <Button disabled={!writable || busy || status?.available === false} onClick={() => void loginAction('textCli.login')}>{status?.loggedIn ? '重新登录' : '登录 Codex'}</Button>}</div>
      {login.state === 'pending' && <p className="control-hint">请在已打开的官方网页完成登录，工作台会自动读取登录结果。</p>}
      {status?.limits?.length ? <div className="text-cli-limits">{status.limits.map(limit => { const windows = [windowText(limit.primary), windowText(limit.secondary)].filter(Boolean); return <div key={limit.id}><strong>{limit.name || '账户额度'}</strong>{windows.map((value, index) => <span key={index}>{value}</span>)}{limit.credits?.unlimited ? <span>额度不限</span> : limit.credits?.balance != null && <span>余额 {limit.credits.balance}</span>}</div>; })}</div> : status?.loggedIn ? <p className="control-hint">账户未返回额度明细。</p> : null}
      {error || status?.error ? <p className="warning" role="alert">{error || status?.error}</p> : null}
      {status?.warnings?.map((warning, index) => <p className="control-hint" key={index}>{warning}</p>)}
      <div className="form-grid"><label>文本模型<select value={settings.textModel || ''} onChange={event => { update('textModel', event.target.value); const model = models.find(item => item.id === event.target.value); if (model && !model.supportedReasoningEfforts.includes(reasoning)) update('reasoning', model.defaultReasoningEffort); }}><option value="" disabled>选择已核实的文本模型</option>{settings.textModel && !models.some(model => model.id === settings.textModel) && <option value={settings.textModel}>{settings.textModel} · 尚未核实</option>}{models.map(model => <option key={model.id} value={model.id}>{model.displayName || model.id}{model.isDefault ? ' · CLI 默认' : ''}</option>)}</select></label><label>推理强度<select value={reasoning} onChange={event => update('reasoning', event.target.value)}>{!efforts.includes(reasoning) && <option value={reasoning}>{reasoning} · 尚未核实</option>}{efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label></div>
      {models.length > 0 && (!selectedModel || !efforts.includes(reasoning)) && <p className="warning">当前模型或推理强度未获此 CLI 确认，请从目录中重新选择。</p>}
      <p className="control-hint">检查只读取程序、登录和模型目录，不发起生成。执行前会按已保存设置自动预检。{status?.checkedAt ? ` 最近检查：${formatDate(status.checkedAt)}` : ''}</p>
    </> : <>
      <label>文本模型<input value={settings.textModel || ''} onChange={event => update('textModel', event.target.value)} placeholder="填写 API 支持的模型"/></label>
      <label>API 地址<input value={settings.textEndpoint || ''} onChange={event => update('textEndpoint', event.target.value)} placeholder="https://…"/></label><label>本机凭据<input type="password" autoComplete="new-password" value={settings.textApiKey || ''} onChange={event => update('textApiKey', event.target.value)} placeholder="留空保留已保存凭据"/></label>
      <p className="control-hint">Rust 核心直接调用已保存的文本 API，推理策略使用服务默认值。</p>
    </>}
    <p className="note">全局上限 4 路，同集上限 2 路；连续依赖顺序执行。更改后保存本机设置。</p>
  </section>;
}
