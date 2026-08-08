const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');

function sanitizeFileName(value, fallback = 'unknown') {
  const sanitized = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return sanitized || fallback;
}

async function writeReadableToFile(readable, filePath, { signal, onProgress } = {}) {
  let received = 0;
  const reportProgress = (chunk) => {
    received += chunk.length;
    if (onProgress) onProgress(received);
  };
  readable.on('data', reportProgress);
  try {
    await pipeline(readable, fs.createWriteStream(filePath), { signal });
    return received;
  } finally {
    readable.off('data', reportProgress);
  }
}

async function removeIfExists(filePath) {
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

module.exports = { sanitizeFileName, writeReadableToFile, removeIfExists };
