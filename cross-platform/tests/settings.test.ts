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
      schemaVersion: 1,
      separateDirectory: false,
      groupByDownload: false
    });
  });

  it('ignores removed download options from legacy settings', () => {
    expect(normalizeSettings({ downloadDirectory: 'D:\\Music', outputFormat: 'flac' })).toEqual(defaultSettings);
  });
});
