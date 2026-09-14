import { describe, expect, it } from 'vitest';
import { defaultSettings, normalizeSettings } from '../src/settings';

describe('normalizeSettings', () => {
  it('returns safe defaults for invalid input', () => {
    expect(normalizeSettings(null)).toEqual(defaultSettings);
  });

  it('preserves supported user choices', () => {
    expect(normalizeSettings({
      separateDirectory: false,
      groupByDownload: false,
      webDownloadMode: 'browser'
    })).toEqual({
      schemaVersion: 4,
      downloadDirectory: '',
      separateDirectory: false,
      groupByDownload: false,
      concurrentDownloads: 1,
      webDownloadMode: 'browser'
    });
  });

  it('clamps concurrent downloads to the supported range', () => {
    expect(normalizeSettings({ concurrentDownloads: 9 }).concurrentDownloads).toBe(3);
    expect(normalizeSettings({ concurrentDownloads: 0 }).concurrentDownloads).toBe(1);
  });

  it('migrates the desktop directory and ignores removed output options', () => {
    expect(normalizeSettings({ downloadDirectory: 'D:\\Music', outputFormat: 'flac' })).toEqual({
      ...defaultSettings,
      downloadDirectory: 'D:\\Music'
    });
  });

  it('migrates unknown Web download modes to automatic selection', () => {
    expect(normalizeSettings({ webDownloadMode: 'invalid' }).webDownloadMode).toBe('auto');
  });
});
