import { invoke } from '@tauri-apps/api/core';
import { load } from '@tauri-apps/plugin-store';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { defaultSettings, normalizeSettings, type AppSettings } from '../settings';
import type { DownloadEvents, DownloadRequest, PlatformBridge, PlatformInfo } from './types';

let storePromise: ReturnType<typeof load> | undefined;
const fallbackSettingsKey = 'siren-records.tauri-settings.v1';

function getStore() {
  storePromise ??= load('settings.json', { autoSave: 250 });
  return storePromise;
}

function getFallbackSettings(): AppSettings {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(fallbackSettingsKey) || 'null'));
  } catch {
    return { ...defaultSettings };
  }
}

function saveFallbackSettings(settings: AppSettings) {
  try {
    localStorage.setItem(fallbackSettingsKey, JSON.stringify(settings));
  } catch {
    // WebView storage can also be disabled by enterprise policy; defaults remain usable.
  }
}

const windowControls = {
  async minimize() {
    await getCurrentWindow().minimize();
  },
  async toggleMaximize() {
    const window = getCurrentWindow();
    if (await window.isMaximized()) await window.unmaximize();
    else await window.maximize();
    return window.isMaximized();
  },
  async close() {
    await getCurrentWindow().close();
  }
};

export const tauriPlatform: PlatformBridge = {
  kind: 'tauri',
  windowControls,

  async getSettings() {
    try {
      const store = await getStore();
      const settings = normalizeSettings(await store.get<AppSettings>('settings') ?? defaultSettings);
      saveFallbackSettings(settings);
      return settings;
    } catch {
      return getFallbackSettings();
    }
  },

  async saveSettings(settings) {
    const normalized = normalizeSettings(settings);
    saveFallbackSettings(normalized);
    try {
      const store = await getStore();
      await store.set('settings', normalized);
      await store.save();
    } catch {
      // The fallback is intentionally silent: an unwritable app-data directory must not block downloads.
    }
  },

  async selectDirectory() {
    return null;
  },

  async validateDownloadDirectory() {
    // Desktop downloads use the operating system's default Downloads folder.
  },

  async loadOfficialCatalog() {
    return invoke<{ albums: unknown; songs: unknown }>('fetch_catalog');
  },

  async getPlatformInfo() {
    return invoke<PlatformInfo>('platform_info');
  },

  async recoverDownloads() {
    await invoke('recover_downloads', { downloadDirectory: '' });
  },

  async startDownload(request: DownloadRequest) {
    return invoke<{ started: boolean }>('start_download', { request });
  },

  async cancelDownload(id) {
    return invoke<boolean>('cancel_download', { id });
  },

  async listenDownloadEvents(events: DownloadEvents) {
    const unlisten = await Promise.all([
      listen('download-progress', (event) => events.progress(event.payload as Parameters<DownloadEvents['progress']>[0])),
      listen('download-complete', (event) => events.complete(event.payload as Parameters<DownloadEvents['complete']>[0])),
      listen('download-failed', (event) => events.failed(event.payload as Parameters<DownloadEvents['failed']>[0])),
      listen('download-cancelled', (event) => events.cancelled(event.payload as Parameters<DownloadEvents['cancelled']>[0]))
    ]);
    return () => unlisten.forEach((dispose) => dispose());
  }
};
