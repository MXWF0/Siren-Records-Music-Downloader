import type { AppSettings, WebDownloadMode } from '../settings';

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
  /** Human-readable song name used by Web download records. */
  title?: string;
  /** Web-only destination strategy; desktop downloads ignore this field. */
  webDownloadMode?: WebDownloadMode;
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
  retryAfterSeconds?: number;
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
  complete(value: {
    id: string;
    /** `completed` means the application confirmed the final file write. */
    outcome?: 'completed' | 'handed_off';
    size?: number;
  }): void;
  failed(value: DownloadFailure): void;
  cancelled(value: { id: string }): void;
  warning(value: { id: string; message: string }): void;
}

export interface PlatformBridge {
  readonly kind: 'tauri' | 'web';
  readonly maxConcurrentDownloads?: number;
  /** Browser-managed downloads must be started directly by a user gesture. */
  readonly requiresUserGestureForDownload?: boolean;
  readonly windowControls?: WindowControls;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;
  selectDirectory(): Promise<string | null>;
  validateDownloadDirectory(directory: string): Promise<void>;
  openDownloadDirectory?(): Promise<void>;
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
