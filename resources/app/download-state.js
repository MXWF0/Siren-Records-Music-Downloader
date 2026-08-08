const fs = require('node:fs/promises');
const path = require('node:path');

function normalizeDownloaded(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([cid, downloaded]) => /^\d+$/.test(String(cid)) && downloaded === true)
      .map(([cid]) => [String(cid), true])
  );
}

async function ensureCacheDirectory(cacheDirectory) {
  await fs.mkdir(cacheDirectory, { recursive: true });
}

async function loadDownloaded(cacheDirectory) {
  await ensureCacheDirectory(cacheDirectory);
  try {
    const content = await fs.readFile(path.join(cacheDirectory, 'downloaded.txt'), 'utf8');
    return normalizeDownloaded(JSON.parse(content));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Unable to read downloaded state:', error);
    return {};
  }
}

async function saveDownloaded(cacheDirectory, downloaded) {
  await ensureCacheDirectory(cacheDirectory);
  const target = path.join(cacheDirectory, 'downloaded.txt');
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(normalizeDownloaded(downloaded)), 'utf8');
  await fs.rename(temporary, target);
}

module.exports = { ensureCacheDirectory, loadDownloaded, saveDownloaded, normalizeDownloaded };
