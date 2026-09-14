export type WebDownloadMode = 'auto' | 'stream' | 'browser';

export interface AppSettings {
  schemaVersion: 4;
  downloadDirectory: string;
  separateDirectory: boolean;
  groupByDownload: boolean;
  concurrentDownloads: number;
  webDownloadMode: WebDownloadMode;
}

export const defaultSettings: AppSettings = {
  schemaVersion: 4,
  downloadDirectory: '',
  separateDirectory: true,
  groupByDownload: true,
  concurrentDownloads: 1,
  webDownloadMode: 'auto'
};

export function normalizeSettings(value: unknown): AppSettings {
  const input = value && typeof value === 'object' ? value as Partial<AppSettings> : {};
  const concurrency = Number(input.concurrentDownloads);
  const webDownloadMode = ['auto', 'stream', 'browser'].includes(String(input.webDownloadMode))
    ? input.webDownloadMode as WebDownloadMode
    : defaultSettings.webDownloadMode;
  return {
    schemaVersion: 4,
    downloadDirectory: typeof input.downloadDirectory === 'string'
      ? input.downloadDirectory.trim()
      : defaultSettings.downloadDirectory,
    separateDirectory: input.separateDirectory !== false,
    groupByDownload: input.groupByDownload !== false,
    concurrentDownloads: Number.isInteger(concurrency)
      ? Math.min(3, Math.max(1, concurrency))
      : defaultSettings.concurrentDownloads,
    webDownloadMode
  };
}
