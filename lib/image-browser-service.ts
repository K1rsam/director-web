import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {prisma} from './prisma';
import {BridgeClient, readImageBrowserConfig} from './image-browser-client';

const STATE_KEY = 'ASSET_IMAGE_EXECUTOR_V1';
const stateId = (projectId: string) => `image_executor_${createHash('sha256').update(projectId).digest('hex')}`;
type ExecutorState = {schema: typeof STATE_KEY; projectId: string; enabled: boolean; enablingUserId: string; updatedAt: string};
type Heartbeat = {pid: number; updatedAt: string; currentProjectId?: string; currentJobId?: string; error?: unknown};
export type ImageBrowserStatus = {
  configured: boolean; status: 'UNCONFIGURED' | 'OFFLINE' | 'READY' | 'RUNNING' | 'PAUSED' | 'ERROR';
  message: string; enabled: boolean; available: boolean; updatedAt?: string; currentJobId?: string;
};
export class ImageBrowserServiceError extends Error {
  constructor(readonly status: number) {super('网页执行器操作未完成。');}
}
async function permission(projectId: string, actorId: string, db = prisma) {
  if (!actorId) throw new ImageBrowserServiceError(401);
  if (!projectId || !await db.projectRole.findFirst({where: {projectId, userId: actorId}, select: {id: true}})) throw new ImageBrowserServiceError(404);
}
function parseState(row: {id: string; projectId: string; sceneKey: string | null; content: string}): ExecutorState {
  const value = JSON.parse(row.content) as ExecutorState;
  if (!value || value.schema !== STATE_KEY || value.projectId !== row.projectId || row.id !== stateId(row.projectId) || row.sceneKey !== STATE_KEY
    || typeof value.enabled !== 'boolean' || typeof value.enablingUserId !== 'string' || !value.enablingUserId
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new ImageBrowserServiceError(409);
  return value;
}
async function readState(projectId: string) {
  const row = await prisma.sceneSnapshot.findUnique({where: {id: stateId(projectId)}});
  if (!row) return null;
  if (row.projectId !== projectId) throw new ImageBrowserServiceError(409);
  return parseState(row);
}
function processExists(pid: number) {
  try {process.kill(pid, 0); return true;}
  catch (error) {return (error as NodeJS.ErrnoException).code === 'EPERM';}
}
async function readHeartbeat(): Promise<Heartbeat | null> {
  try {
    const file = path.join(/*turbopackIgnore: true*/ process.cwd(), 'runtime-3008', 'image-browser', 'heartbeat.json');
    const bytes = await readFile(/*turbopackIgnore: true*/ file);
    if (bytes.length > 16384) return null;
    const value = JSON.parse(bytes.toString('utf8')) as Heartbeat;
    if (!value || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.updatedAt !== 'string') return null;
    const age = Date.now() - Date.parse(value.updatedAt);
    // A fresh timestamp alone cannot turn a dead worker into a connected executor.
    if (!Number.isFinite(age) || age < -5000 || age > 30000 || !processExists(value.pid)) return null;
    return value;
  } catch {return null;}
}
export async function readImageBrowserStatus(projectId: string, actorId: string): Promise<ImageBrowserStatus> {
  await permission(projectId, actorId);
  const state = await readState(projectId), enabled = state?.enabled ?? false;
  const common = {enabled, available: false, ...(state ? {updatedAt: state.updatedAt} : {})};
  let config;
  try {config = await readImageBrowserConfig();}
  catch {return {...common, configured: false, status: 'ERROR', message: '本地连接配置需检查，请打开连接设置页。'};}
  if (!config) return {...common, configured: false, status: 'UNCONFIGURED', message: '尚未配置 Chrome 网页执行器，请先完成本地连接设置。'};
  const client=new BridgeClient(config);
  const [heartbeat, health, availability] = await Promise.all([
    readHeartbeat(), client.health().catch(() => null), client.browserAvailability().catch(()=>null),
  ]);
  const browserConnected = !!health && Number.isSafeInteger(health.clients) && health.clients > 0;
  const connected = browserConnected && heartbeat !== null;
  const available = connected && !!availability && !!(availability.opener || heartbeat?.currentJobId) && !heartbeat?.error;
  const updated = heartbeat ? {updatedAt: heartbeat.updatedAt} : {};
  if (!enabled) return {...common, ...updated, configured: true, available, status: 'PAUSED', message: connected
    ? '本项目已暂停接新任务；已发送网页的生成不会自动取消。'
    : '本项目已暂停接新任务；Chrome 或后台执行器尚未连接，请完成本地设置后刷新。'};
  if (!connected) return {...common, ...updated, configured: true, status: 'OFFLINE', message: browserConnected
    ? '本项目已启用，但后台执行器未连接或心跳已过期；新任务尚不能执行。'
    : '本项目已启用，但 Chrome 网页未连接；请在本地设置页完成连接与登录。'};
  if (heartbeat.error && (!heartbeat.currentProjectId || heartbeat.currentProjectId === projectId)) return {...common, ...updated, configured: true, status: 'ERROR', message: '执行器需检查，请核对本地连接和本项目任务记录；未自动重发生图。'};
  if(!availability||!availability.opener&&!heartbeat.currentJobId) return {...common,...updated,configured:true,status:'ERROR',message:availability?.quarantined
    ? 'Chrome 已连接，但标签页被扩展锁定；请新开 ChatGPT 标签页并连接 Bridge，旧任务不会重发。'
    : 'Chrome 已连接，但尚无可执行的标签页；请确认页面已就绪并选择执行标签页。'};
  // A global heartbeat must never disclose another project's active job.
  if (heartbeat.currentProjectId === projectId && typeof heartbeat.currentJobId === 'string' && /^[a-f0-9-]{36}$/.test(heartbeat.currentJobId)) {
    const job = await prisma.sceneSnapshot.findFirst({where: {id: heartbeat.currentJobId, projectId, sceneKey: 'ASSET_IMAGE_JOB_V1'}, select: {id: true}});
    if (job) return {...common, ...updated, configured: true, available, status: 'RUNNING', currentJobId: job.id, message: 'Chrome 执行器正在处理本项目图片任务。'};
  }
  return {...common, ...updated, configured: true, available, status: 'READY', message: 'Chrome 与后台执行器已连接，本项目可接新任务；排队不代表已生成。'};
}
export async function changeImageBrowserState(projectId: string, actorId: string, action: 'enable' | 'pause' | 'refresh') {
  await permission(projectId, actorId);
  if (!['enable', 'pause', 'refresh'].includes(action)) throw new ImageBrowserServiceError(400);
  // Refresh only checks the existing connection; neither refresh nor enable launches Chrome.
  if (action === 'refresh') return readImageBrowserStatus(projectId, actorId);
  if (action === 'enable' && !await readImageBrowserConfig()) throw new ImageBrowserServiceError(409);
  await prisma.$transaction(async tx => {
    if (!await tx.projectRole.findFirst({where: {projectId, userId: actorId}, select: {id: true}})) throw new ImageBrowserServiceError(404);
    const id = stateId(projectId), before = await tx.sceneSnapshot.findUnique({where: {id}});
    const old = before ? parseState(before) : null;
    if (before && before.projectId !== projectId) throw new ImageBrowserServiceError(409);
    const value: ExecutorState = {schema: STATE_KEY, projectId, enabled: action === 'enable', enablingUserId: action === 'enable' ? actorId : old?.enablingUserId ?? actorId, updatedAt: new Date().toISOString()};
    const content = JSON.stringify(value);
    await tx.sceneSnapshot.upsert({where: {id}, create: {id, projectId, sceneKey: STATE_KEY, title: 'Chrome 图片执行器接单设置', content}, update: {content}});
  });
  return readImageBrowserStatus(projectId, actorId);
}
export async function listEnabledImageProjects(): Promise<Array<{projectId: string; actorId: string}>> {
  const rows = await prisma.sceneSnapshot.findMany({where: {sceneKey: STATE_KEY}, orderBy: {projectId: 'asc'}});
  const projects: Array<{projectId: string; actorId: string}> = [];
  for (const row of rows) {
    let state;
    try {state = parseState(row);} catch {continue;}
    if (state.enabled && await prisma.projectRole.findFirst({where: {projectId: state.projectId, userId: state.enablingUserId}, select: {id: true}})) projects.push({projectId: state.projectId, actorId: state.enablingUserId});
  }
  return projects;
}
