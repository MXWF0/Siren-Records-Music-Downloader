const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadDownloaded, saveDownloaded } = require('../download-state');

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'monster-siren-state-'));
}

test('download state starts empty and keeps only valid completed song ids', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await loadDownloaded(directory), {});
  await saveDownloaded(directory, { '100': true, bad: true, '200': false, '300': 1 });
  assert.deepEqual(await loadDownloaded(directory), { '100': true });
});

test('download state writes replace the previous record', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveDownloaded(directory, { '100': true });
  await saveDownloaded(directory, { '200': true });
  assert.deepEqual(await loadDownloaded(directory), { '200': true });
});
