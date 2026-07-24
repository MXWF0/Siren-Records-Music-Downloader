const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { extensionForMime, findCachedCover, saveCachedCover } = require('../cover-cache');

test('cover mime types map to stable tmp extensions', () => {
  assert.equal(extensionForMime('image/png'), 'png');
  assert.equal(extensionForMime('image/jpeg; charset=binary'), 'jpg');
  assert.equal(extensionForMime('image/webp'), 'webp');
});

test('cover cache writes and refreshes the album CID file', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'monster-siren-cover-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = await saveCachedCover(directory, 99, Buffer.from('first'), 'image/png');
  assert.equal(path.basename(first.path), '99.png');
  const second = await saveCachedCover(directory, 99, Buffer.from('second'), 'image/jpeg');
  assert.equal(path.basename(second.path), '99.jpg');
  assert.equal(await fs.readFile(second.path, 'utf8'), 'second');
  assert.equal(await findCachedCover(directory, 99).then((cover) => cover.buffer.toString()), 'second');
  assert.equal(await fs.access(path.join(directory, '99.png')).then(() => true, () => false), false);
});
