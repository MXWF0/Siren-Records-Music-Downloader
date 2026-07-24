const fs = require('node:fs/promises');
const path = require('node:path');

function extensionForMime(mime = '') {
  const value = String(mime).toLowerCase();
  if (value.includes('png')) return 'png';
  if (value.includes('webp')) return 'webp';
  if (value.includes('jpeg') || value.includes('jpg')) return 'jpg';
  return 'jpg';
}

function mimeForExtension(extension) {
  return extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
}

async function findCachedCover(cacheDirectory, albumCid) {
  try {
    const files = await fs.readdir(cacheDirectory);
    const prefix = `${String(albumCid)}.`;
    const name = files.find((file) => {
      const extension = path.extname(file).slice(1).toLowerCase();
      return file.startsWith(prefix) && ['jpg', 'jpeg', 'png', 'webp'].includes(extension);
    });
    if (!name) return null;
    const extension = path.extname(name).slice(1).toLowerCase();
    return {
      path: path.join(cacheDirectory, name),
      mime: mimeForExtension(extension),
      buffer: await fs.readFile(path.join(cacheDirectory, name))
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Unable to read cached cover: ${error.message}`);
    return null;
  }
}

async function saveCachedCover(cacheDirectory, albumCid, buffer, mime) {
  await fs.mkdir(cacheDirectory, { recursive: true });
  const extension = extensionForMime(mime);
  const target = path.join(cacheDirectory, `${String(albumCid)}.${extension}`);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, buffer);
  await fs.rename(temporary, target);
  const files = await fs.readdir(cacheDirectory);
  await Promise.all(files
    .filter((file) => file.startsWith(`${String(albumCid)}.`) && file !== path.basename(target))
    .filter((file) => ['jpg', 'jpeg', 'png', 'webp'].includes(path.extname(file).slice(1).toLowerCase()))
    .map((file) => fs.rm(path.join(cacheDirectory, file), { force: true })));
  return { path: target, mime: mime || mimeForExtension(extension), buffer: Buffer.from(buffer) };
}

module.exports = { extensionForMime, findCachedCover, saveCachedCover };
