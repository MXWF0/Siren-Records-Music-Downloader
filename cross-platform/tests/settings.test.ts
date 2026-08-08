import { describe, expect, it } from 'vitest';
import { defaultSettings, normalizeSettings } from '../src/settings';

describe('normalizeSettings', () => {
  it('returns safe defaults for invalid input', () => {
    expect(normalizeSettings(null)).toEqual(defaultSettings);
  });

  it('preserves supported user choices', () => {
    expect(normalizeSettings({
      separateDirectory: false,
      groupByDownload: false
    })).toEqual({
      schemaVersion: 2,
      separateDirectory: false,
      groupByDownload: false,
      concurrentDownloads: 2
    });
  });

  it('clamps concurrent downloads to the supported range', () => {
    expect(normalizeSettings({ concurrentDownloads: 9 }).concurrentDownloads).toBe(3);
    expect(normalizeSettings({ concurrentDownloads: 0 }).concurrentDownloads).toBe(1);
  });

  it('ignores removed download options from legacy settings', () => {
    expect(normalizeSettings({ downloadDirectory: 'D:\\Music', outputFormat: 'flac' })).toEqual(defaultSettings);
  });
});
