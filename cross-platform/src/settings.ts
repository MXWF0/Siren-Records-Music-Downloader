export interface AppSettings {
  schemaVersion: 2;
  separateDirectory: boolean;
  groupByDownload: boolean;
  concurrentDownloads: number;
}

export const defaultSettings: AppSettings = {
  schemaVersion: 2,
  separateDirectory: true,
  groupByDownload: true,
  concurrentDownloads: 2
};

export function normalizeSettings(value: unknown): AppSettings {
  const input = value && typeof value === 'object' ? value as Partial<AppSettings> : {};
  const concurrency = Number(input.concurrentDownloads);
  return {
    schemaVersion: 2,
    separateDirectory: input.separateDirectory !== false,
    groupByDownload: input.groupByDownload !== false,
    concurrentDownloads: Number.isInteger(concurrency)
      ? Math.min(3, Math.max(1, concurrency))
      : defaultSettings.concurrentDownloads
  };
}
