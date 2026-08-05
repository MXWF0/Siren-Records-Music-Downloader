export interface AppSettings {
  schemaVersion: 1;
  separateDirectory: boolean;
  groupByDownload: boolean;
}

export const defaultSettings: AppSettings = {
  schemaVersion: 1,
  separateDirectory: true,
  groupByDownload: true
};

export function normalizeSettings(value: unknown): AppSettings {
  const input = value && typeof value === 'object' ? value as Partial<AppSettings> : {};
  return {
    schemaVersion: 1,
    separateDirectory: input.separateDirectory !== false,
    groupByDownload: input.groupByDownload !== false
  };
}
