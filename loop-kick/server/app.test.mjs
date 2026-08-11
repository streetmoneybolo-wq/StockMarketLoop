import assert from 'node:assert/strict';
import test from 'node:test';

import { createLoopKickServer } from './app.mjs';

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
