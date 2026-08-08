export interface Album {
  cid: string;
  name: string;
  coverUrl?: string;
  coverDeUrl?: string;
}

export interface Song {
  cid: string;
  name: string;
  albumCid: string;
  albumName: string;
  artist?: string;
  duration?: number;
  lyricUrl?: string;
  coverUrl?: string;
  coverDeUrl?: string;
}

export interface CatalogData {
  albums: Record<string, Album>;
  songs: Song[];
}

export interface OfficialCatalogPayload {
  albums: unknown;
  songs: unknown;
}

const apiRoot = 'https://monster-siren.hypergryph.com/api';

const previewAlbums: Album[] = [
  { cid: 'preview-manifesto', name: 'Manifesto' },
  { cid: 'preview-every-road', name: 'Every Road is a Yes' },
  { cid: 'preview-pivot', name: '次生预案OST' },
  { cid: 'preview-siren', name: '音律联觉原声EP' }
];

const previewSongs: Song[] = [
  { cid: 'preview-001', name: 'Every Road is a Yes (Instrumental)', albumCid: 'preview-every-road', albumName: 'Every Road is a Yes', artist: '塞壬唱片', duration: 214 },
  { cid: 'preview-002', name: 'Every Road is a Yes', albumCid: 'preview-every-road', albumName: 'Every Road is a Yes', artist: '塞壬唱片', duration: 198 },
  { cid: 'preview-003', name: 'Pivot of the Future', albumCid: 'preview-pivot', albumName: '次生预案OST', artist: '塞壬唱片', duration: 235 },
  { cid: 'preview-004', name: '前路', albumCid: 'preview-siren', albumName: '音律联觉原声EP', artist: '塞壬唱片', duration: 226 },
  { cid: 'preview-005', name: '夜间超速', albumCid: 'preview-siren', albumName: '音律联觉原声EP', artist: '塞壬唱片', duration: 183 },
  { cid: 'preview-006', name: '镜花水月', albumCid: 'preview-siren', albumName: '音律联觉原声EP', artist: '塞壬唱片', duration: 246 },
  { cid: 'preview-007', name: 'Exultation', albumCid: 'preview-siren', albumName: '音律联觉原声EP', artist: '塞壬唱片', duration: 205 }
];

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`目录请求失败（${response.status}）`);
  return response.json() as Promise<T>;
}

export async function loadCatalog(
  timeoutMs = 8000,
  officialLoader?: () => Promise<OfficialCatalogPayload>
): Promise<{ data: CatalogData; preview: boolean; error?: string }> {
  const requestTimeout = officialLoader ? 20000 : timeoutMs;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), requestTimeout);
  try {
    const payload: OfficialCatalogPayload = officialLoader
      ? await Promise.race([
          officialLoader(),
          new Promise<OfficialCatalogPayload>((_, reject) => window.setTimeout(() => reject(new Error('网络请求超时')), requestTimeout))
        ])
      : await Promise.all([
          fetchJson<{ data?: Array<Record<string, unknown>> }>(`${apiRoot}/albums`, controller.signal),
          fetchJson<{ data?: { list?: Array<Record<string, unknown>> } }>(`${apiRoot}/songs`, controller.signal)
        ]).then(([albums, songs]) => ({ albums, songs }));
    const albumRows = Array.isArray((payload.albums as { data?: unknown[] })?.data)
      ? (payload.albums as { data: unknown[] }).data
      : [];
    const songRows = Array.isArray(((payload.songs as { data?: { list?: unknown[] } })?.data)?.list)
      ? ((payload.songs as { data: { list: unknown[] } }).data).list
      : [];
    const albums = Object.fromEntries(albumRows.map((value) => {
      const album = value as Record<string, unknown>;
      const cid = String(album.cid ?? '');
      return [cid, {
        cid,
        name: String(album.name || cid),
        coverUrl: typeof album.coverUrl === 'string' ? album.coverUrl : undefined,
        coverDeUrl: typeof album.coverDeUrl === 'string' ? album.coverDeUrl : undefined
      } satisfies Album];
    }));
    const songs = songRows.map((value) => {
      const listSong = value as Record<string, unknown>;
      const cid = String(listSong.cid ?? '');
      const song = listSong;
      const albumCid = String(song.albumCid ?? '');
      return {
        cid,
        name: String(song.name || '未命名歌曲'),
        albumCid,
        albumName: albums[albumCid]?.name || albumCid || '未分类专辑',
        artist: typeof song.artist === 'string'
          ? song.artist
          : Array.isArray(song.artists)
            ? song.artists.filter((artist): artist is string => typeof artist === 'string').join(' ')
            : undefined,
        duration: typeof song.duration === 'number' ? song.duration : undefined,
        lyricUrl: typeof song.lyricUrl === 'string' ? song.lyricUrl : undefined,
        coverUrl: albums[albumCid]?.coverUrl,
        coverDeUrl: albums[albumCid]?.coverDeUrl
      } satisfies Song;
    }).filter((song) => song.cid);
    if (!songs.length) throw new Error('歌曲目录为空');
    return { data: { albums, songs }, preview: false };
  } catch (error) {
    if (officialLoader) throw error;
    const reason = error instanceof Error ? error.message : '网络请求失败';
    console.warn('Unable to load catalogue in the browser:', error);
    return {
      data: {
        albums: Object.fromEntries(previewAlbums.map((album) => [album.cid, album])),
        songs: previewSongs
      },
      preview: true,
      error: `官网目录请求失败：${reason}；当前显示预览数据`
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

export function formatDuration(value?: number): string {
  if (!value || !Number.isFinite(value)) return '—';
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}
