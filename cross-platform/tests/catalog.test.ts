import { describe, expect, it, vi } from 'vitest';
import { formatDuration, loadCatalog, normalizeDuration } from '../src/catalog';

describe('catalog helpers', () => {
  it('formats track durations for the song list', () => {
    expect(formatDuration(214)).toBe('3:34');
    expect(formatDuration(214_000)).toBe('3:34');
    expect(normalizeDuration('90')).toBe(90);
    expect(formatDuration(undefined)).toBe('—');
  });

  it('maps the official albums and songs response', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const result = await loadCatalog(1000, async () => ({
      albums: { data: [{ cid: 7, name: 'Album 7', coverUrl: 'https://example.test/cover.jpg' }] },
      songs: { data: { list: [{ cid: 8, name: 'Track 8', albumCid: 7, duration: 123, artist: 'Artist' }] } }
    }));
    expect(result.preview).toBe(false);
    expect(result.data.albums['7'].name).toBe('Album 7');
    expect(result.data.songs[0]).toMatchObject({ cid: '8', albumCid: '7', albumName: 'Album 7', duration: 123 });
    vi.unstubAllGlobals();
  });
});
