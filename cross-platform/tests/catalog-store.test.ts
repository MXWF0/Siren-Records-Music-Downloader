import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalogStore } from '../src/stores/catalog';

describe('catalog store search', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('filters in real time and reports the number of matches', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify(['2']),
      setItem: vi.fn()
    });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const store = createCatalogStore(async () => ({
      albums: { data: [{ cid: 'a', name: 'Album A' }] },
      songs: { data: { list: [
        { cid: '1', name: 'Blue Track', albumCid: 'a', artist: 'Singer' },
        { cid: '2', name: 'Red Track', albumCid: 'a', artist: 'Other' }
      ] } }
    }));
    await store.load();
    store.searchQuery.value = 'singer';
    expect(store.visibleSongs.value.map((song) => song.cid)).toEqual(['1']);
    expect(store.matchCount.value).toBe(1);
    store.filter.value = 'downloaded';
    expect(store.visibleSongs.value).toHaveLength(0);
  });
});
