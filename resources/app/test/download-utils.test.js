const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const axios = require('axios');
const { sanitizeFileName, writeReadableToFile } = require('../download-utils');

async function makeServer() {
  const server = http.createServer((request, response) => {
    if (request.url === '/broken') {
      response.writeHead(200, { 'Content-Length': '10' });
      response.write('abc');
      return response.destroy();
    }
    if (request.url === '/unknown-length') {
      response.writeHead(200);
      return response.end('streamed without content length');
    }
    if (request.url === '/slow') {
      response.writeHead(200);
      const timer = setInterval(() => response.write(Buffer.alloc(1024)), 10);
      request.on('close', () => clearInterval(timer));
      return;
    }
    response.writeHead(200, { 'Content-Length': '6' });
    response.end('stream');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('file names are safe on Windows', () => {
  assert.equal(sanitizeFileName('a<b>:c?* .'), 'a_b__c__');
  assert.equal(sanitizeFileName('   ', 'song'), 'song');
});

test('streamed HTTP responses are written without requiring content length', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'monster-siren-stream-'));
  const server = await makeServer();
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;
  const response = await axios.get(`http://127.0.0.1:${port}/unknown-length`, { responseType: 'stream' });
  const target = path.join(directory, 'audio.part');
  const progress = [];
  await writeReadableToFile(response.data, target, { onProgress: (received) => progress.push(received) });
  assert.equal(await fs.readFile(target, 'utf8'), 'streamed without content length');
  assert.ok(progress.at(-1) > 0);
});

test('an aborted stream rejects and stops writing', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'monster-siren-cancel-'));
  const server = await makeServer();
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  });
  const controller = new AbortController();
  const response = await axios.get(`http://127.0.0.1:${server.address().port}/slow`, {
    responseType: 'stream',
    signal: controller.signal
  });
  await assert.rejects(
    writeReadableToFile(response.data, path.join(directory, 'audio.part'), {
      signal: controller.signal,
      onProgress: () => controller.abort()
    }),
    /abort|cancel/i
  );
});
