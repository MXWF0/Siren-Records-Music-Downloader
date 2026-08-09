import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class ProxyByteLimitError extends Error {
  constructor() {
    super('proxied response exceeded byte limit');
    this.name = 'ProxyByteLimitError';
  }
}

/** Count bytes as they are forwarded; Content-Length is not trusted. */
export async function pipeLimitedResponse(webBody, response, maxBytes) {
  let forwarded = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      forwarded += chunk.length;
      if (forwarded > maxBytes) callback(new ProxyByteLimitError());
      else callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(webBody), limiter, response);
  return forwarded;
}
