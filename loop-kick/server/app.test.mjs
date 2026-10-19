import assert from 'node:assert/strict';
import test from 'node:test';

import { createLoopKickServer, mediaHostAllowed } from './app.mjs';

async function runningService() {
  const calls = [];
  const gateway = async (token, method, route, params = {}) => {
    calls.push({ token, method, route, params });
    if (route === '/sml-loop/v1/threads') return method === 'GET' ? { threads: [], counts: {} } : { id: 44, type: 'dm' };
    if (route.endsWith('/messages')) return method === 'GET' ? { thread_id: 44, messages: [] } : { id: 8, thread_id: 44, sender_id: 7, body: params.body };
    if (route === '/sml-mhub/v1/people') return { friends: [], live: [] };
    if (route === '/sml-mhub/v1/notifications') return { items: [], counts: {} };
    if (route === '/sml-loop/v1/preferences') return { read_receipts: 1 };
    if (route === '/sml-loop/v1/chirp/settings') return { chirp_enabled: 1 };
    if (route === '/sml-loop/v1/chirp/incoming') return { incoming: [], missed: [] };
    if (route === '/sml-loop/v1/poll') return { now: '2026-08-11 12:00:00', changed: [], counts: {} };
    return { ok: true };
  };
  const service = createLoopKickServer({
    distDir: '__missing__', gateway,
    verifySession: async token => token ? { userId: 'wp-7', wpUserId: 7, profile: { name: 'Tester' } } : null,
  });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const { port } = service.server.address();
  return { service, calls, base: `http://127.0.0.1:${port}` };
}

const auth = { authorization: 'Bearer session-token' };

test('bootstrap combines the existing messenger services', async t => {
  const { service, base, calls } = await runningService();
  t.after(() => service.close());
  const response = await fetch(`${base}/api/bootstrap`, { headers: auth });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.identity.wpUserId, 7);
  assert.deepEqual(body.threads.threads, []);
  assert.deepEqual(new Set(calls.map(call => call.route)), new Set([
    '/sml-loop-kick/v1/bootstrap',
    '/sml-loop/v1/threads', '/sml-mhub/v1/people', '/sml-mhub/v1/notifications',
    '/sml-loop/v1/preferences', '/sml-loop/v1/chirp/settings', '/sml-loop/v1/chirp/incoming',
  ]));
});

test('message send is routed to the WordPress thread without a second database', async t => {
  const { service, base, calls } = await runningService();
  t.after(() => service.close());
  const response = await fetch(`${base}/api/threads/44/messages`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Real messenger check' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).body, 'Real messenger check');
  assert.deepEqual(calls.at(-1), { token: 'session-token', method: 'POST', route: '/sml-loop/v1/threads/44/messages', params: { body: 'Real messenger check' } });
});

test('thread creation and polling preserve their exact contracts', async t => {
  const { service, base, calls } = await runningService();
  t.after(() => service.close());
  await fetch(`${base}/api/threads`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'dm', recipient_id: 12 }) });
  await fetch(`${base}/api/poll?since=2026-08-11%2011%3A59%3A00`, { headers: auth });
  assert.equal(calls[0].route, '/sml-loop/v1/threads');
  assert.equal(calls[0].params.recipient_id, 12);
  assert.equal(calls[1].route, '/sml-loop/v1/poll');
  assert.equal(calls[1].params.since, '2026-08-11 11:59:00');
});

test('messenger endpoints reject unauthenticated callers', async t => {
  const { service, base } = await runningService();
  t.after(() => service.close());
  assert.equal((await fetch(`${base}/api/bootstrap`)).status, 401);
  assert.equal((await fetch(`${base}/api/threads`)).status, 401);
});

test('the media relay only fetches allow-listed hosts and only hands back image, audio and video', async t => {
  assert.equal(mediaHostAllowed('stockmarketloop.com'), true);
  assert.equal(mediaHostAllowed('www.stockmarketloop.com'), true);
  assert.equal(mediaHostAllowed('grandmasterobi.stockmarketloop.com'), true);
  assert.equal(mediaHostAllowed('secure.gravatar.com'), true);
  assert.equal(mediaHostAllowed('i0.wp.com'), true);
  assert.equal(mediaHostAllowed('i.ytimg.com'), true);
  assert.equal(mediaHostAllowed('evil.example'), false);
  assert.equal(mediaHostAllowed('stockmarketloop.com.evil.example'), false);
  assert.equal(mediaHostAllowed('notstockmarketloop.com'), false);

  const fetched = [];
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const mediaFetch = async (url, init) => {
    fetched.push({ url, range: init.headers.range || '' });
    if (url.endsWith('/page.html')) return new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (url.endsWith('/missing.png')) return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
    if (url.endsWith('/clip.mp4')) return new Response(Buffer.alloc(10, 1), { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-9/100', 'accept-ranges': 'bytes', 'content-length': '10' } });
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length), etag: '"abc"' } });
  };
  const service = createLoopKickServer({ distDir: '__missing__', gateway: async () => ({}), verifySession: async () => null, mediaFetch });
  t.after(() => service.close());
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const relay = (u, headers = {}) => fetch(`${base}/api/media?u=${encodeURIComponent(u)}`, { headers });

  assert.equal((await relay('not a url')).status, 400);
  assert.equal((await relay('https://evil.example/x.png')).status, 403);
  assert.equal((await relay('http://stockmarketloop.com/x.png')).status, 403, 'https only');
  assert.equal(fetched.length, 0, 'nothing is fetched for a refused host');

  const image = await relay('https://stockmarketloop.com/wp-content/uploads/2026/10/chart.png');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('etag'), '"abc"');
  assert.equal(image.headers.get('cache-control'), 'public, max-age=3600');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);

  assert.equal((await relay('https://stockmarketloop.com/page.html')).status, 415, 'an html page is not media');
  assert.equal((await relay('https://stockmarketloop.com/missing.png')).status, 404);

  const clip = await relay('https://stockmarketloop.com/wp-content/uploads/clip.mp4', { range: 'bytes=0-9' });
  assert.equal(clip.status, 206);
  assert.equal(clip.headers.get('content-range'), 'bytes 0-9/100');
  assert.equal(fetched.at(-1).range, 'bytes=0-9', 'the Range header reaches the site so video can seek');
  assert.equal((await clip.arrayBuffer()).byteLength, 10);
});

test('the media relay never becomes an open proxy for arbitrary content types or sizes', async t => {
  const mediaFetch = async () => new Response('x', { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(41 * 1024 * 1024) } });
  const service = createLoopKickServer({ distDir: '__missing__', gateway: async () => ({}), verifySession: async () => null, mediaFetch });
  t.after(() => service.close());
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const r = await fetch(`${base}/api/media?u=${encodeURIComponent('https://stockmarketloop.com/huge.mp4')}`);
  assert.equal(r.status, 413);
});
