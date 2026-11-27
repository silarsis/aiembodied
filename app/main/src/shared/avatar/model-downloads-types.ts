// Types only: shared/ holds what the main process and the renderer both need.

export type DownloadState =
  'queued' | 'downloading' | 'verifying' | 'done' | 'failed' | 'cancelled';

export interface ModelDownload {
  id: string;
  serverId: string;
  serverName: string;
  title: string;
  folder: string;
  filename: string;
  state: DownloadState;
  received: number;
  total: number | null;
  error?: string;
  note?: string;
  startedAt: number;
}
