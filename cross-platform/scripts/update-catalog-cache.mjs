import { readFile, writeFile } from 'node:fs/promises';

const cacheFile = new URL('../src/catalog-cache.json', import.meta.url);
const apiRoot = 'https://monster-siren.hypergryph.com/api';
const timeoutMs = 20_000;

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
    headers: { Accept: 'application/json', 'User-Agent': 'Siren-Records-Web-Build' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function isUsableCache(value) {
  return Array.isArray(value?.albums?.data)
    && Array.isArray(value?.songs?.data?.list)
    && value.songs.data.list.length > 0;
}

async function readExistingCache() {
  try {
    const value = JSON.parse(await readFile(cacheFile, 'utf8'));
    return isUsableCache(value) ? value : null;
  } catch {
    return null;
  }
}

async function writeCatalog(payload) {
  // Signed sourceUrl values are intentionally excluded. Downloads always ask
  // the backend proxy for a fresh official song detail at request time.
  await writeFile(cacheFile, `${JSON.stringify({
    generatedAt: payload.generatedAt ?? null,
    albums: payload.albums,
    songs: payload.songs
  })}\n`, 'utf8');
}

try {
  const [albums, songs] = await Promise.all([fetchOfficial('/albums'), fetchOfficial('/songs')]);
  await writeCatalog({ generatedAt: new Date().toISOString(), albums, songs });
  console.log(`官网目录快照已更新：${songs?.data?.list?.length ?? 0} 首歌曲`);
} catch (error) {
  const existing = await readExistingCache();
  if (existing) {
    await writeCatalog(existing);
    console.warn(`官网目录暂时不可用，保留不含音频签名的目录快照：${error instanceof Error ? error.message : error}`);
  } else {
    await writeCatalog({ generatedAt: null, ...previewCache });
    console.warn(`官网目录暂时不可用，已写入内置预览目录：${error instanceof Error ? error.message : error}`);
  }
}
