import assert from 'node:assert/strict';
import test from 'node:test';
import { isBlockedIp, parseImageUrl, fetchRemoteImage } from '../src/http/fetch-image.js';
import { isAppError } from '../src/errors.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('isBlockedIp catches loopback, private, link-local, metadata', () => {
  for (const ip of ['127.0.0.1', '0.0.0.0', '10.0.0.1', '192.168.1.1', '172.16.5.5', '169.254.169.254', '100.64.1.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34']) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test('parseImageUrl rejects non-http, credentials, localhost', () => {
  assert.throws(() => parseImageUrl('ftp://a/b'), (e) => isAppError(e) && e.code === 'invalid_image_url');
  assert.throws(() => parseImageUrl('https://user:pass@example.com/a.png'), (e) => isAppError(e) && e.code === 'invalid_image_url');
  assert.throws(() => parseImageUrl('http://localhost/a.png'), (e) => isAppError(e) && e.code === 'ssrf_blocked');
  assert.throws(() => parseImageUrl('http://127.0.0.1/a.png'), (e) => isAppError(e) && e.code === 'ssrf_blocked');
  assert.throws(() => parseImageUrl('http://169.254.169.254/latest/meta-data'), (e) => isAppError(e) && e.code === 'ssrf_blocked');
  assert.throws(() => parseImageUrl('http://metadata.google.internal/'), (e) => isAppError(e) && e.code === 'ssrf_blocked');
  const u = parseImageUrl('https://example.com/x.png');
  assert.equal(u.hostname, 'example.com');
});

function png1x1(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
}

test('fetchRemoteImage accepts a public PNG via injected fetch; blocks private redirect', async () => {
  const png = png1x1();
  const ok = await fetchRemoteImage('https://cdn.example/a.png', {
    lookup: publicLookup,
    fetchImpl: async (url) => {
      assert.match(url, /^https:\/\/cdn\.example\//);
      return new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } });
    },
  });
  assert.equal(ok.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  await assert.rejects(
    () => fetchRemoteImage('https://cdn.example/go', {
      lookup: publicLookup,
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }),
    }),
    (e: unknown) => isAppError(e) && e.code === 'ssrf_blocked',
  );

  await assert.rejects(
    () => fetchRemoteImage('https://cdn.example/go', {
      lookup: publicLookup,
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://192.168.0.1/x' } }),
    }),
    (e: unknown) => isAppError(e) && e.code === 'ssrf_blocked',
  );
});

test('fetchRemoteImage rejects non-image bodies and oversize content-length', async () => {
  await assert.rejects(
    () => fetchRemoteImage('https://cdn.example/a.txt', {
      lookup: publicLookup,
      fetchImpl: async () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }),
    }),
    (e: unknown) => isAppError(e) && e.code === 'invalid_image',
  );
  await assert.rejects(
    () => fetchRemoteImage('https://cdn.example/big', {
      lookup: publicLookup,
      fetchImpl: async () => new Response(null, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(9 * 1024 * 1024) } }),
    }),
    (e: unknown) => isAppError(e) && e.code === 'payload_too_large',
  );
});

test('fetchRemoteImage rejects DNS to private addresses', async () => {
  await assert.rejects(
    () => fetchRemoteImage('https://evil.example/a.png', {
      lookup: async () => [{ address: '169.254.169.254', family: 4 }],
      fetchImpl: async () => new Response(new Uint8Array(png1x1()), { status: 200, headers: { 'content-type': 'image/png' } }),
    }),
    (e: unknown) => isAppError(e) && e.code === 'ssrf_blocked',
  );
});
