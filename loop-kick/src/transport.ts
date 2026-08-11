/**
 * LOOP-KICK message system transports.
 *
 * Same wire contract as the earlier vanilla loopkick.js, so this phone UI
 * drops onto the same backend:
 *   GET  /api/messages                     -> { messages: [{ id, from, mine, text, ts }] }
 *   POST /api/messages/send { content }    -> { id, from, mine, text, ts }
 *   WS   /ws                               -> single message objects, same shape
 *
 * Select at runtime, before the bundle loads:
 *   window.LOOP_KICK_CONFIG = {
 *     transport: 'live',
 *     socketUrl: 'wss://host/ws',
 *     endpoints: { messages: '/api/messages', send: '/api/messages/send' }
 *   }
 * Default is the self-contained mock, so the artifact works standalone.
 */

export interface WireMessage {
  id: string;
  from: string;
  mine: boolean;
  text: string;
  ts: number;
}

export interface Transport {
  name: string;
  load(): Promise<WireMessage[]>;
  send(text: string): Promise<WireMessage>;
  connect(onMessage: (m: WireMessage) => void): void;
  disconnect(): void;
}

interface LoopKickConfig {
  transport?: 'mock' | 'live';
  socketUrl?: string;
  endpoints?: { messages?: string; send?: string };
  sessionToken?: string;
  peerId?: string;
  peerName?: string;
}

declare global {
  interface Window {
    LOOP_KICK_CONFIG?: LoopKickConfig;
  }
}

const DEFAULTS = {
  messages: '/api/messages',
  send: '/api/messages/send',
};

/* ------------------------------------------------------------------ */

function mockTransport(): Transport {
  // Seed matches the design's original thread so the phone opens looking
  // exactly like the approved mockup.
  const seed: WireMessage[] = [
    { id: 's1', from: 'Sarah', mine: false, text: 'Are you free tonight?', ts: Date.now() - 300000 },
    { id: 's2', from: 'you', mine: true, text: "Yeah, I'm free. What's the plan?", ts: Date.now() - 240000 },
    { id: 's3', from: 'Sarah', mine: false, text: "Let's grab dinner at 7 PM.", ts: Date.now() - 180000 },
  ];

  let onMsg: ((m: WireMessage) => void) | null = null;
  let replyTimer: ReturnType<typeof setTimeout> | null = null;
  const replies = [
    'Got it — see you at 7.',
    'Perfect. Booking the table now.',
    "I'll send the address in a sec.",
  ];
  let replyIdx = 0;

  return {
    name: 'mock',
    load: () => Promise.resolve(seed.slice()),
    send: (text) => {
      // schedule a canned reply like the original design did
      if (replyTimer) clearTimeout(replyTimer);
      replyTimer = setTimeout(() => {
        onMsg?.({
          id: 'r' + Date.now(),
          from: 'Sarah',
          mine: false,
          text: replies[replyIdx++ % replies.length],
          ts: Date.now(),
        });
      }, 1100);
      return Promise.resolve({
        id: 'm' + Date.now(),
        from: 'you',
        mine: true,
        text,
        ts: Date.now(),
      });
    },
    connect: (cb) => {
      onMsg = cb;
    },
    disconnect: () => {
      if (replyTimer) clearTimeout(replyTimer);
      onMsg = null;
    },
  };
}

/* ------------------------------------------------------------------ */

function liveTransport(cfg: LoopKickConfig): Transport {
  const endpoints = { ...DEFAULTS, ...(cfg.endpoints || {}) };
  let socket: WebSocket | null = null;
  const headers = (): HeadersInit => cfg.sessionToken
    ? { Authorization: `Bearer ${cfg.sessionToken}`, 'X-Loop-Peer-Id': cfg.peerId || 'loop' }
    : { 'X-Loop-Peer-Id': cfg.peerId || 'loop' };

  return {
    name: 'live',
    load: async () => {
      const r = await fetch(endpoints.messages, { headers: headers() });
      if (!r.ok) throw new Error('Messages endpoint returned ' + r.status);
      const d = await r.json();
      return (d && d.messages) || [];
    },
    send: async (text) => {
      const r = await fetch(endpoints.send, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      if (!r.ok) throw new Error('Send failed (' + r.status + ')');
      return r.json();
    },
    connect: (cb) => {
      const rawUrl =
        cfg.socketUrl ||
        (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
      try {
        const url = new URL(rawUrl, location.href);
        if (cfg.sessionToken) url.searchParams.set('session', cfg.sessionToken);
        url.searchParams.set('peer', cfg.peerId || 'loop');
        socket = new WebSocket(url);
        socket.onmessage = (ev) => {
          try {
            cb(JSON.parse(ev.data));
          } catch {
            /* malformed frame — drop */
          }
        };
      } catch {
        console.warn('LOOP-KICK: socket unavailable; live updates disabled.');
      }
    },
    disconnect: () => {
      socket?.close();
      socket = null;
    },
  };
}

/* ------------------------------------------------------------------ */

export function createTransport(): Transport {
  const cfg = (typeof window !== 'undefined' && window.LOOP_KICK_CONFIG) || {};
  return cfg.transport === 'live' ? liveTransport(cfg) : mockTransport();
}
