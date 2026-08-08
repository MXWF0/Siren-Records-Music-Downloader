const assert = require('node:assert/strict');
const test = require('node:test');
const { createQueue } = require('../download-queue');

test('download all excludes completed songs while manual queue can force them', () => {
  const completed = new Set(['2']);
  assert.deepEqual(createQueue([1, 2, 3], completed, false), [
    { id: '1', force: false }, { id: '3', force: false }
  ]);
  assert.deepEqual(createQueue([1, 2], completed, true), [
    { id: '1', force: true }, { id: '2', force: true }
  ]);
  assert.deepEqual(createQueue([1, 2, 3], completed, 'downloaded'), [
    { id: '1', force: false }, { id: '2', force: true }, { id: '3', force: false }
  ]);
});
