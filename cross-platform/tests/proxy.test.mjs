import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  audioExtension,
  audioFileName,
  consumeRateLimit,
  corsHeaders,
  fetchOfficialAudio,
  fetchOfficialSong,
  isOriginAllowed,
  resetRateLimitsForTests,
  validRangeHeader,
  validSongId
} from '../scripts/official-proxy.mjs';

function request(origin, host = 'api.example') {
  return {
    headers: {
      origin,
      host,
      'x-forwarded-proto': 'https'
    },
    socket: { remoteAddress: '127.0.0.1' }
  };
}

describe('proxy request policy', () => {
  beforeEach(() => resetRateLimitsForTests());
  afterEach(() => vi.unstubAllGlobals());

  it('allows the project Pages origin and same-origin deployments', () => {
    expect(isOriginAllowed(request('https://mxwf0.github.io'))).toBe(true);
    expect(isOriginAllowed(request('https://api.example'))).toBe(true);
    expect(corsHeaders(request('https://mxwf0.github.io'))['Access-Control-Allow-Origin']).toBe('https://mxwf0.github.io');
  });

  it('rejects unrelated websites and null origins by default', () => {
    expect(isOriginAllowed(request('https://third-party.example'))).toBe(false);
    expect(isOriginAllowed(request('null'))).toBe(false);
    expect(corsHeaders(request('https://third-party.example'))['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('limits repeated requests within one window', () => {
    expect(consumeRateLimit('audio:test', 2, 1000, 100).allowed).toBe(true);
    expect(consumeRateLimit('audio:test', 2, 1000, 200).allowed).toBe(true);
    expect(consumeRateLimit('audio:test', 2, 1000, 300).allowed).toBe(false);
    expect(consumeRateLimit('audio:test', 2, 1000, 1200).allowed).toBe(true);
  });

  it('accepts only bounded song identifiers', () => {
    expect(validSongId('779442')).toBe(true);
    expect(validSongId('../secret')).toBe(false);
    expect(validSongId('x'.repeat(65))).toBe(false);
  });

  it('accepts one bounded byte range and rejects complex ranges', () => {
    expect(validRangeHeader('bytes=0-1048575')).toBe('bytes=0-1048575');
    expect(validRangeHeader('bytes=-4096')).toBe('bytes=-4096');
    expect(validRangeHeader('bytes=0-1,4-5')).toBe('');
  });

  it('resolves a fresh official song URL for every audio request', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).includes('/api/song/779442')) {
        return new Response(JSON.stringify({ data: {
          cid: '779442',
          name: 'Test',
          sourceUrl: 'https://res01.hycdn.cn/fresh/audio.wav'
        } }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        headers: { 'Content-Type': 'audio/wav', 'Content-Length': '4' }
      });
    }));

    const result = await fetchOfficialAudio('779442');
    expect(result.song.sourceUrl).toContain('/fresh/audio.wav');
    expect(calls).toEqual([
      'https://monster-siren.hypergryph.com/api/song/779442',
      'https://res01.hycdn.cn/fresh/audio.wav'
    ]);
  });

  it('rejects audio hosts outside the configured CDN allowlist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: {
      cid: '779442',
      sourceUrl: 'https://untrusted.example/audio.wav'
    } }), { headers: { 'Content-Type': 'application/json' } })));
    await expect(fetchOfficialAudio('779442')).rejects.toThrow('不受信任');
  });

  it('keeps the official format in download filenames', () => {
    expect(audioExtension('audio/flac', 'https://res01.hycdn.cn/audio.wav')).toBe('flac');
    expect(audioExtension('application/octet-stream', 'https://res01.hycdn.cn/audio.mp3?sign=1')).toBe('mp3');
    expect(audioFileName({ name: 'Track' }, 'Album', '1', 'mp3')).toBe('[Album] Track.mp3');
  });

  it('does not expose the signed source URL in song details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: {
      cid: '779442',
      name: 'Test',
      sourceUrl: 'https://res01.hycdn.cn/private/audio.wav'
    } }), { headers: { 'Content-Type': 'application/json' } })));
    await expect(fetchOfficialSong('779442')).resolves.toEqual({ cid: '779442', name: 'Test' });
  });
});
