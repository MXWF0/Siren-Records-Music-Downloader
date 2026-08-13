import { describe, expect, it } from 'vitest';
import { downloadDirectoryInvokeArguments } from '../src/platform/tauri';

describe('Tauri directory commands', () => {
  it('uses the camelCase argument expected by Tauri command deserialization', () => {
    expect(downloadDirectoryInvokeArguments('D:\\Music')).toEqual({ downloadDirectory: 'D:\\Music' });
  });
});
