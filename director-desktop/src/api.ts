import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import type { Media, Request, Workspace } from './types';
import { previewWorkspace } from './preview';

export const desktop = isTauri();
export const preview = !desktop && new URLSearchParams(location.search).get('preview') === '1';

export async function request<T>(input: Request): Promise<T> {
  if (desktop) return invoke<T>('desktop_request', { request: input });
  if (preview) {
    if (input.action === 'projects.list') return [previewWorkspace.project] as T;
    if (input.action === 'workspace.get') return previewWorkspace as T;
    if (input.action === 'assets.get') return previewWorkspace.assets.find(asset => asset.id === input.assetId) as T;
    if (input.action === 'units.get') return previewWorkspace.units.find(unit => unit.id === input.unitId) as T;
    if (input.action === 'jobs.detail') return previewWorkspace.jobs.find(job => job.id === input.jobId) as T;
    throw new Error('浏览器预览使用示例资料；请在桌面客户端执行此操作。');
  }
  throw new Error('浏览器未连接本地核心。请使用桌面客户端打开项目。');
}

export async function choose(kind: 'file' | 'directory', multiple = false): Promise<string[]> {
  return request<string[]>({ action: 'files.choose', kind, multiple });
}

export function mediaUrl(media?: Media, thumbnail = false): string {
  if (!media) return '';
  const path = media.previewUrl || (thumbnail ? media.thumbnailPath || media.path : media.path);
  if (!path) return '';
  if (/^(data:|blob:|https?:|asset:)/.test(path)) return path;
  return desktop ? convertFileSrc(path) : '';
}

export function isWorkspace(value: unknown): value is Workspace {
  return !!value && typeof value === 'object' && 'project' in value && 'assets' in value && 'units' in value;
}
