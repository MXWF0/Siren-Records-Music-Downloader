import { access, readFile, writeFile } from 'node:fs/promises';

const cacheFile = new URL('../src/catalog-cache.json', import.meta.url);
const apiRoot = 'https://monster-siren.hypergryph.com/api';
const timeoutMs = 20_000;
const refreshSignedUrls = process.env.SIREN_REFRESH_SIGNED_URLS === '1';
const requireFreshCatalog = process.env.SIREN_REQUIRE_FRESH_CATALOG === '1';

const previewCache = {
  albums: {
    data: [
      { cid: 'preview-every-road', name: 'Every Road is a Yes' },
      { cid: 'preview-pivot', name: '次生预案OST' },
      { cid: 'preview-siren', name: '音律联觉原声EP' }
    ]
  },
  songs: {
    data: {
      list: [
        { cid: 'preview-001', name: 'Every Road is a Yes (Instrumental)', albumCid: 'preview-every-road', artist: '塞壬唱片', duration: 214 },
        { cid: 'preview-002', name: 'Every Road is a Yes', albumCid: 'preview-every-road', artist: '塞壬唱片', duration: 198 },
        { cid: 'preview-003', name: 'Pivot of the Future', albumCid: 'preview-pivot', artist: '塞壬唱片', duration: 235 },
        { cid: 'preview-004', name: '前路', albumCid: 'preview-siren', artist: '塞壬唱片', duration: 226 }
      ]
    }
  }
};

async function fetchOfficial(path) {
  const response = await fetch(`${apiRoot}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Siren-Records-Web-Build/1.0' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function hasUsableCache() {
  try {
    const value = JSON.parse(await readFile(cacheFile, 'utf8'));
    return Array.isArray(value?.albums?.data) && Array.isArray(value?.songs?.data?.list) && value.songs.data.list.length > 0;
  } catch {
    return false;
  }
}

async function readCachedDetails() {
  try {
    const value = JSON.parse(await readFile(cacheFile, 'utf8'));
    return value?.details && typeof value.details === 'object' ? value.details : {};
  } catch {
    return {};
  }
}

async function hydrateSongDetails(songs, cachedDetails) {
  const rows = Array.isArray(songs?.data?.list) ? songs.data.list : [];
  const details = { ...cachedDetails };
  const detailIds = rows
    .map((song) => String(song?.cid || ''))
    .filter((id) => id && (refreshSignedUrls || !details[id]?.data?.sourceUrl));
  let cursor = 0;
  let failed = 0;
  const workerCount = Math.min(12, detailIds.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < detailIds.length) {
      const id = detailIds[cursor++];
      try {
        details[id] = await fetchOfficial(`/song/${encodeURIComponent(id)}`);
      } catch {
        failed += 1;
      }
    }
  }));
  if (detailIds.length) {
    console.log(`歌曲下载信息已更新：${detailIds.length - failed}/${detailIds.length}`);
  }
  if (failed) console.warn(`${failed} 首歌曲暂时无法更新下载信息，将在下次构建时重试。`);
  if (failed && requireFreshCatalog) throw new Error(`${failed} 首歌曲签名刷新失败，已取消静态站点部署`);
  return details;
}

try {
  const [albums, songs] = await Promise.all([fetchOfficial('/albums'), fetchOfficial('/songs')]);
  const details = await hydrateSongDetails(songs, await readCachedDetails());
  const payload = { generatedAt: new Date().toISOString(), albums, songs, details };
  await writeFile(cacheFile, `${JSON.stringify(payload)}\n`, 'utf8');
  console.log(`官网目录快照已更新：${songs?.data?.list?.length ?? 0} 首歌曲`);
} catch (error) {
  if (requireFreshCatalog) throw error;
  if (!(await hasUsableCache())) {
    await writeFile(cacheFile, `${JSON.stringify({ generatedAt: null, ...previewCache })}\n`, 'utf8');
    console.warn(`官网目录暂时不可用，已写入内置预览目录：${error instanceof Error ? error.message : error}`);
  } else {
    console.warn(`官网目录暂时不可用，保留已有快照：${error instanceof Error ? error.message : error}`);
  }
}
