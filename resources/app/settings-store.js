const fs = require('node:fs/promises');
const path = require('node:path');

function normalizeSettings(value, defaults) {
  const settings = value && typeof value === 'object' ? value : {};
  return {
    downloadDirectory: typeof settings.downloadDirectory === 'string' && settings.downloadDirectory.trim()
      ? settings.downloadDirectory.trim()
      : defaults.downloadDirectory,
    deleteSourceWav: settings.deleteSourceWav !== false,
    separateDirectory: settings.separateDirectory !== false,
    groupByDownload: settings.groupByDownload !== false
  };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Unable to read settings: ${error.message}`);
    return null;
  }
}

async function saveSettings(filePath, settings) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(settings, null, 2), 'utf8');
  await fs.rename(temporary, filePath);
}

async function loadSettings(filePath, defaults, legacyPath) {
  const stored = await readJson(filePath);
  if (stored) return normalizeSettings(stored, defaults);
  let legacyDirectory = '';
  if (legacyPath) {
    try { legacyDirectory = (await fs.readFile(legacyPath, 'utf8')).trim(); } catch { /* no legacy file */ }
  }
  const settings = normalizeSettings({ downloadDirectory: legacyDirectory || defaults.downloadDirectory }, defaults);
  await saveSettings(filePath, settings);
  return settings;
}

module.exports = { normalizeSettings, loadSettings, saveSettings };
