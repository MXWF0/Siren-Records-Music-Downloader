const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadSettings, saveSettings } = require('../settings-store');

async function tempDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'monster-siren-settings-'));
}

test('legacy path settings migrate once and are persisted independently', async (t) => {
  const directory = await tempDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settingsFile = path.join(directory, 'user-data', 'settings.json');
  const legacyPath = path.join(directory, 'downloads', 'tmp', 'path.txt');
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, 'D:\\Music\\Arknights', 'utf8');
  const defaults = { downloadDirectory: 'C:\\Music\\monster-siren', deleteSourceWav: true, separateDirectory: true };
  const migrated = await loadSettings(settingsFile, defaults, legacyPath);
  assert.equal(migrated.downloadDirectory, 'D:\\Music\\Arknights');
  await fs.rm(legacyPath);
  assert.deepEqual(await loadSettings(settingsFile, defaults, legacyPath), migrated);
});

test('settings writes keep user choices', async (t) => {
  const directory = await tempDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settingsFile = path.join(directory, 'settings.json');
  const expected = { downloadDirectory: 'D:\\Music', deleteSourceWav: false, separateDirectory: false, groupByDownload: false };
  await saveSettings(settingsFile, expected);
  assert.deepEqual(await loadSettings(settingsFile, { downloadDirectory: 'C:\\Music', deleteSourceWav: true, separateDirectory: true }), expected);
});
