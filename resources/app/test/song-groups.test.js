const assert = require('node:assert/strict');
const test = require('node:test');
const { partitionSongs } = require('../song-groups');

test('songs are partitioned by downloaded record while preserving catalogue order', () => {
  const songs = [{ cid: 1 }, { cid: 2 }, { cid: 3 }];
  const groups = partitionSongs(songs, new Set(['2']));
  assert.deepEqual(groups.pending.map((song) => song.cid), [1, 3]);
  assert.deepEqual(groups.downloaded.map((song) => song.cid), [2]);
});
