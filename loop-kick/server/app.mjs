import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import express from 'express';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function cleanId(value, fallback) {
  const id = String(value || fallback || '').trim();
  return /^[A-Za-z0-9_.@-]{1,100}$/.test(id) ? id : fallback;
}

function bearerToken(req) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(req.get('authorization') || ''));
  return match ? match[1] : '';
}

async function verifyWordPressSession(token) {
  if (!token) return null;
  const endpoint = process.env.LOOP_KICK_SESSION_URL || 'https://stockmarketloop.com/wp-json/sml-loop-kick/v1/session';
  const response = await fetch(`${endpoint}?token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return null;
  const body = await response.json();
  const userId = cleanId(body?.userId, '');
  return userId ? { userId } : null;
}

function wireMessage(row, userId) {
  return {
    id: String(row.id),
    from: row.sender === userId ? 'you' : row.sender,
    mine: row.sender === userId,
    text: row.content,
    ts: Number(row.timestamp),
  };
}

function openDatabase(filename) {
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,
      content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 2000),
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_thread_time
      ON messages(sender, receiver, timestamp);
  `);
  return db;
}

export function createLoopKickServer(options = {}) {
  const dbPath = options.dbPath || process.env.LOOP_KICK_DB_PATH || path.join(ROOT, 'data', 'loop-kick.sqlite');
  const distDir = options.distDir || path.join(ROOT, 'dist');
  const db = openDatabase(dbPath);
  const app = express();
  const server = http.createServer(app);
  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true });
  const verifySession = options.verifySession || verifyWordPressSession;
  const sessionCache = new Map();

  async function authenticate(token, peerValue) {
    if (!token) return null;
    const cached = sessionCache.get(token);
    let identity = cached?.expiresAt > Date.now() ? cached.identity : null;
    if (!identity) {
      identity = await verifySession(token);
      if (!identity?.userId) return null;
      sessionCache.set(token, { identity, expiresAt: Date.now() + 60_000 });
    }
    const userId = cleanId(identity.userId, '');
    const peerId = cleanId(peerValue, 'loop');
    return userId && peerId ? { userId, peerId } : null;
  }

  async function requestIdentity(req) {
    try {
      return await authenticate(bearerToken(req), req.get('x-loop-peer-id'));
    } catch (error) {
      console.error('LOOP-KICK session verification failed:', error.message);
      return null;
    }
  }

  const listMessages = db.prepare(`
    SELECT id, sender, receiver, content, timestamp
      FROM messages
     WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
     ORDER BY timestamp ASC, rowid ASC
     LIMIT 500
  `);
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, sender, receiver, content, timestamp)
    VALUES (@id, @sender, @receiver, @content, @timestamp)
  `);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'loop-kick' });
  });

  app.get('/api/messages', async (req, res) => {
    const auth = await requestIdentity(req);
    if (!auth) return res.status(401).json({ error: 'A valid StockMarketLoop session is required.' });
    const { userId, peerId } = auth;
    const rows = listMessages.all(userId, peerId, peerId, userId);
    res.json({ messages: rows.map((row) => wireMessage(row, userId)) });
  });

  app.post('/api/messages/send', async (req, res) => {
    const auth = await requestIdentity(req);
    if (!auth) return res.status(401).json({ error: 'A valid StockMarketLoop session is required.' });
    const { userId, peerId } = auth;
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content || content.length > 2000) {
      return res.status(422).json({ error: 'content must be between 1 and 2000 characters' });
    }

    const row = {
      id: crypto.randomUUID(),
      sender: userId,
      receiver: peerId,
      content,
      timestamp: Date.now(),
    };
    insertMessage.run(row);

    for (const client of sockets) {
      if (client.readyState !== 1) continue;
      if (client.userId !== row.sender && client.userId !== row.receiver) continue;
      const otherParticipant = client.userId === row.sender ? row.receiver : row.sender;
      if (client.peerId !== otherParticipant) continue;
      client.send(JSON.stringify(wireMessage(row, client.userId)));
    }

    return res.status(201).json(wireMessage(row, userId));
  });

  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method === 'GET' && req.accepts('html')) {
        return res.sendFile(path.join(distDir, 'index.html'));
      }
      return next();
    });
  }

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    let auth = null;
    try {
      auth = await authenticate(url.searchParams.get('session'), url.searchParams.get('peer'));
    } catch {
      auth = null;
    }
    if (!auth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const { userId, peerId } = auth;
    wss.handleUpgrade(req, socket, head, (client) => {
      client.userId = userId;
      client.peerId = peerId;
      wss.emit('connection', client, req);
    });
  });

  wss.on('connection', (client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => sockets.delete(client));
  });

  async function close() {
    for (const client of sockets) client.close(1001, 'server shutdown');
    await new Promise((resolve) => wss.close(resolve));
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    db.close();
  }

  return { app, server, db, close };
}
