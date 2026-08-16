export interface AppSettings {
  schemaVersion: 3;
  downloadDirectory: string;
  separateDirectory: boolean;
  groupByDownload: boolean;
  concurrentDownloads: number;
}

export const defaultSettings: AppSettings = {
  schemaVersion: 3,
  downloadDirectory: '',
  separateDirectory: true,
  groupByDownload: true,
  concurrentDownloads: 1
};

export function normalizeSettings(value: unknown): AppSettings {
  const input = value && typeof value === 'object' ? value as Partial<AppSettings> : {};
  const concurrency = Number(input.concurrentDownloads);
  return {
    schemaVersion: 3,
    downloadDirectory: typeof input.downloadDirectory === 'string'
      ? input.downloadDirectory.trim()
      : defaultSettings.downloadDirectory,
    separateDirectory: input.separateDirectory !== false,
    groupByDownload: input.groupByDownload !== false,
    concurrentDownloads: Number.isInteger(concurrency)
      ? Math.min(3, Math.max(1, concurrency))
      : defaultSettings.concurrentDownloads
  };
}
