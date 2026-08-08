import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { loadCatalog, type Album, type OfficialCatalogPayload, type Song } from '../catalog';

export type CatalogFilter = 'all' | 'pending' | 'downloaded';

export interface CatalogStore {
  albums: Ref<Record<string, Album>>;
  songs: Ref<Song[]>;
  downloadedIds: Ref<Set<string>>;
  searchQuery: Ref<string>;
  filter: Ref<CatalogFilter>;
  highlightedId: Ref<string>;
  loading: Ref<boolean>;
  previewData: Ref<boolean>;
  errorMessage: Ref<string>;
  visibleSongs: ComputedRef<Song[]>;
  matchCount: ComputedRef<number>;
  pendingSongs: ComputedRef<Song[]>;
  downloadedSongs: ComputedRef<Song[]>;
  load(): Promise<void>;
  nextMatch(): string | null;
  clearSearch(): void;
  markDownloaded(id: string): void;
  replaceDownloaded(ids: string[]): void;
}

const downloadedStorageKey = 'siren-records.downloaded.v1';

function loadDownloadedIds(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(downloadedStorageKey) || '[]');
    return new Set(Array.isArray(value) ? value.map(String) : []);
  } catch {
    return new Set();
  }
}

export function createCatalogStore(officialLoader?: () => Promise<OfficialCatalogPayload>): CatalogStore {
  const albums = ref<Record<string, Album>>({});
  const songs = ref<Song[]>([]);
  const downloadedIds = ref(loadDownloadedIds());
  const searchQuery = ref('');
  const filter = ref<CatalogFilter>('all');
  const highlightedId = ref('');
  const loading = ref(true);
  const previewData = ref(false);
  const errorMessage = ref('');
  let searchIndex = -1;
  let lastSearchQuery = '';

  const matchesSearch = (song: Song) => {
    const query = searchQuery.value.trim().toLowerCase();
    if (!query) return true;
    return `${song.name} ${song.albumName} ${song.artist || ''}`.toLowerCase().includes(query);
  };

  const visibleSongs = computed(() => songs.value.filter((song) => {
    const downloaded = downloadedIds.value.has(song.cid);
    const categoryMatches = filter.value === 'all'
      || (filter.value === 'downloaded' && downloaded)
      || (filter.value === 'pending' && !downloaded);
    return categoryMatches && matchesSearch(song);
  }));
  const matchCount = computed(() => searchQuery.value.trim() ? visibleSongs.value.length : 0);
  const pendingSongs = computed(() => visibleSongs.value.filter((song) => !downloadedIds.value.has(song.cid)));
  const downloadedSongs = computed(() => visibleSongs.value.filter((song) => downloadedIds.value.has(song.cid)));

  async function load() {
    loading.value = true;
    try {
      const result = await loadCatalog(undefined, officialLoader);
      albums.value = result.data.albums;
      songs.value = result.data.songs;
      previewData.value = result.preview;
      errorMessage.value = result.error || '';
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '无法加载歌曲目录';
    } finally {
      loading.value = false;
    }
  }

  function nextMatch(): string | null {
    const query = searchQuery.value.trim().toLowerCase();
    if (!query) return null;
    const matches = visibleSongs.value.filter(matchesSearch);
    if (query !== lastSearchQuery) {
      searchIndex = -1;
      lastSearchQuery = query;
    }
    if (!matches.length) {
      highlightedId.value = '';
      return null;
    }
    searchIndex = (searchIndex + 1) % matches.length;
    highlightedId.value = matches[searchIndex].cid;
    return highlightedId.value;
  }

  function clearSearch() {
    searchIndex = -1;
    lastSearchQuery = '';
    highlightedId.value = '';
  }

  function markDownloaded(id: string) {
    const next = new Set(downloadedIds.value);
    next.add(String(id));
    downloadedIds.value = next;
    try {
      localStorage.setItem(downloadedStorageKey, JSON.stringify([...next]));
    } catch {
      // The current session can still classify a completed track when storage is unavailable.
    }
  }

  function replaceDownloaded(ids: string[]) {
    downloadedIds.value = new Set(ids.map(String));
    try {
      localStorage.setItem(downloadedStorageKey, JSON.stringify([...downloadedIds.value]));
    } catch {
      // Desktop manifest verification remains authoritative if storage is unavailable.
    }
  }

  return {
    albums, songs, downloadedIds, searchQuery, filter, highlightedId, loading, previewData, errorMessage,
    visibleSongs, matchCount, pendingSongs, downloadedSongs, load, nextMatch, clearSearch,
    markDownloaded, replaceDownloaded
  };
}
