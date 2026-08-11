import assert from 'node:assert/strict';
import test from 'node:test';

import WebSocket from 'ws';

import { createLoopKickServer } from './app.mjs';

async function runningService() {
  const service = createLoopKickServer({
    dbPath: ':memory:',
    distDir: '__missing__',
    verifySession: async (token) => token ? { userId: token } : null,
  });
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const { port } = service.server.address();
  return { service, base: `http://127.0.0.1:${port}`, port };
}

test('GET /api/messages starts with the contract shape', async (t) => {
  const { service, base } = await runningService();
  t.after(() => service.close());

  const response = await fetch(`${base}/api/messages`, { headers: { authorization: 'Bearer you', 'x-loop-peer-id': 'Sarah' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { messages: [] });
});

test('POST persists a message and returns it as mine', async (t) => {
  const { service, base } = await runningService();
  t.after(() => service.close());

  const sent = await fetch(`${base}/api/messages/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer you', 'x-loop-peer-id': 'Sarah' },
    body: JSON.stringify({ content: 'Backend contract check' }),
  });
  assert.equal(sent.status, 201);
  const message = await sent.json();
  assert.equal(message.mine, true);
  assert.equal(message.from, 'you');
  assert.equal(message.text, 'Backend contract check');
  assert.equal(typeof message.ts, 'number');

  const history = await fetch(`${base}/api/messages`, { headers: { authorization: 'Bearer you', 'x-loop-peer-id': 'Sarah' } });
  assert.deepEqual((await history.json()).messages, [message]);
});

test('new messages broadcast with viewer-relative mine values', async (t) => {
  const { service, base, port } = await runningService();
  t.after(() => service.close());

  const sender = new WebSocket(`ws://127.0.0.1:${port}/ws?session=you&peer=Sarah`);
  const recipient = new WebSocket(`ws://127.0.0.1:${port}/ws?session=Sarah&peer=you`);
  const otherThread = new WebSocket(`ws://127.0.0.1:${port}/ws?session=you&peer=Jordan`);
  await Promise.all([
    new Promise((resolve) => sender.once('open', resolve)),
    new Promise((resolve) => recipient.once('open', resolve)),
    new Promise((resolve) => otherThread.once('open', resolve)),
  ]);

  const senderFrame = new Promise((resolve) => sender.once('message', (data) => resolve(JSON.parse(data))));
  const recipientFrame = new Promise((resolve) => recipient.once('message', (data) => resolve(JSON.parse(data))));
  let leakedToOtherThread = false;
  otherThread.once('message', () => { leakedToOtherThread = true; });
  const response = await fetch(`${base}/api/messages/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer you', 'x-loop-peer-id': 'Sarah' },
    body: JSON.stringify({ content: 'Broadcast check' }),
  });
  assert.equal(response.status, 201);

  assert.equal((await senderFrame).mine, true);
  const received = await recipientFrame;
  assert.equal(received.mine, false);
  assert.equal(received.from, 'you');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(leakedToOtherThread, false);
});

test('invalid content is rejected without persistence', async (t) => {
  const { service, base } = await runningService();
  t.after(() => service.close());

  const response = await fetch(`${base}/api/messages/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer you', 'x-loop-peer-id': 'Sarah' },
    body: JSON.stringify({ content: '   ' }),
  });
  assert.equal(response.status, 422);
  assert.deepEqual((await (await fetch(`${base}/api/messages`, { headers: { authorization: 'Bearer you', 'x-loop-peer-id': 'Sarah' } })).json()).messages, []);
});

test('message endpoints reject unauthenticated callers', async (t) => {
  const { service, base } = await runningService();
  t.after(() => service.close());

  assert.equal((await fetch(`${base}/api/messages`)).status, 401);
});
