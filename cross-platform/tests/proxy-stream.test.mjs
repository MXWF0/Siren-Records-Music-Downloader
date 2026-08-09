import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { pipeLimitedResponse, ProxyByteLimitError } from '../scripts/proxy-stream.mjs';

function sink() {
  return new Writable({ write(_chunk, _encoding, callback) { callback(); } });
}

describe('proxy streaming limits', () => {
  it('counts streamed bytes even without Content-Length', async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4)); controller.close(); } });
    await expect(pipeLimitedResponse(body, sink(), 8)).resolves.toBe(4);
  });

  it('terminates a response that exceeds the actual byte limit', async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(9)); controller.close(); } });
    await expect(pipeLimitedResponse(body, sink(), 8)).rejects.toBeInstanceOf(ProxyByteLimitError);
  });
});
