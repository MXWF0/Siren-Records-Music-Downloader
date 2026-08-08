import type { AppSettings } from '../settings';

export interface PlatformInfo {
  os: string;
  arch: string;
  appVersion: string;
  runtime: string;
}

export interface WindowControls {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<boolean>;
  close(): Promise<void>;
}

export interface DownloadRequest {
  id: string;
  downloadDirectory: string;
  separateDirectory: boolean;
  fileName?: string;
}

export interface DownloadProgress {
  id: string;
  loaded: number;
  total: number | null;
  rate: number;
  etaSeconds: number | null;
}

export interface DownloadFailure {
  id: string;
  message: string;
}

export interface PersistedQueueTask {
  id: string;
  title: string;
  album: string;
  state: 'pending' | 'downloading' | 'failed';
  force: boolean;
  fileName?: string;
  message?: string;
}

export interface PersistedQueueState {
  version: 1;
  paused: boolean;
  tasks: PersistedQueueTask[];
}

export interface DownloadEvents {
  progress(value: DownloadProgress): void;
  complete(value: { id: string; browserManaged?: boolean }): void;
  failed(value: DownloadFailure): void;
  cancelled(value: { id: string }): void;
}

export interface PlatformBridge {
  readonly kind: 'tauri' | 'web';
  readonly maxConcurrentDownloads?: number;
  readonly windowControls?: WindowControls;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;
  selectDirectory(): Promise<string | null>;
  validateDownloadDirectory(directory: string): Promise<void>;
  loadOfficialCatalog?(): Promise<{ albums: unknown; songs: unknown }>;
  loadSongDetails?(id: string): Promise<unknown>;
  loadDownloadedIds(): Promise<string[]>;
  loadQueueState(): Promise<PersistedQueueState | null>;
  saveQueueState(state: PersistedQueueState): Promise<void>;
  getPlatformInfo(): Promise<PlatformInfo>;
  recoverDownloads(downloadDirectory: string): Promise<void>;
  startDownload(request: DownloadRequest): Promise<{ started: boolean }>;
  cancelDownload(id: string): Promise<boolean>;
  listenDownloadEvents(events: DownloadEvents): Promise<() => void>;
}
