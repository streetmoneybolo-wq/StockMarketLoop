export interface Person {
  userId: number;
  name: string;
  handle: string;
  avatar: string;
  profileUrl?: string;
  friend?: boolean;
  chirpEnabled?: boolean;
  chirpReason?: string;
  presence?: { state?: string; stale?: boolean; contextType?: string };
}

export interface ThreadSummary {
  id: number;
  type: string;
  title: string;
  category: string;
  state: string;
  muted: boolean;
  archived: boolean;
  pinned: boolean;
  unread: number;
  last_read_id: number;
  last_message: { id: number; at: string | null; preview: string; sender_id: number };
  participants: { user_id: number; role: string; last_read_message_id?: number }[];
  people?: Person[];
  mode?: string;
  ttl_seconds?: number;
}

export interface WireMessage {
  id: string;
  threadId: number;
  senderId: number;
  from: string;
  mine: boolean;
  text: string;
  ts: number;
  type?: string;
  media?: { id: number; mime: string; url: string }[];
  replyTo?: number;
  expiresAt?: string | null;
}

export interface SiteNotification {
  id: string;
  type: string;
  message: string;
  link: string;
  actorId: number;
  date: string;
  read: boolean;
  category: 'priority' | 'general';
  source: string;
}

export interface BootstrapData {
  identity: { userId: string; wpUserId: number; profile?: Person };
  threads: { threads: ThreadSummary[]; counts: Record<string, { threads: number; unread: number }> };
  people: { friends: Person[]; live: Person[] };
  notifications: { items: SiteNotification[]; counts: Record<string, { total: number; unread: number }> };
  preferences: Record<string, string | number | boolean>;
  chirp: Record<string, string | number | boolean>;
  incoming: { incoming: unknown[]; missed: unknown[] };
}

export interface Transport {
  name: string;
  bootstrap(): Promise<BootstrapData>;
  setActiveThread(id: number): void;
  load(threadId?: number, after?: number): Promise<WireMessage[]>;
  send(text: string, options?: Record<string, unknown>): Promise<WireMessage>;
  openThread(recipientId: number): Promise<ThreadSummary>;
  markRead(threadId: number, messageId?: number): Promise<ThreadSummary>;
  setFlags(threadId: number, flags: Record<string, boolean>): Promise<ThreadSummary>;
  respondRequest(threadId: number, action: 'accept' | 'decline'): Promise<ThreadSummary>;
  clearHistory(threadId: number): Promise<Record<string, unknown>>;
  search(query: string): Promise<Person[]>;
  updateNotification(input: { action: string; id?: string; category?: string }): Promise<{ items: SiteNotification[] }>;
  savePreferences(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  saveChirpSettings(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  upload(file: File, purpose?: 'image' | 'voice'): Promise<{ id: number; url: string; mime: string }>;
  chirpStart(receiverId: number): Promise<Record<string, unknown>>;
  chirpSignal(sessionId: number, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
  chirpEnd(sessionId: number): Promise<Record<string, unknown>>;
  chirpIncoming(): Promise<{ incoming: unknown[]; missed: unknown[] }>;
  iceConfig(): Promise<RTCConfiguration>;
  livekitToken(room: string): Promise<{ ok: boolean; token?: string; url?: string; room?: string; name?: string; reason?: string }>;
  connect(onMessage: (m: WireMessage) => void, onRefresh?: () => void): void;
  disconnect(): void;
}

interface LoopKickConfig {
  transport?: 'mock' | 'live';
  sessionToken?: string;
  peerId?: string;
  peerName?: string;
}

declare global {
  interface Window { LOOP_KICK_CONFIG?: LoopKickConfig; }
}

function agoIso(ms: number) { return new Date(ms).toISOString(); }

function mockTransport(): Transport {
  const now = Date.now();
  const person: Person = { userId: 2, name: 'Sarah', handle: 'sarah', avatar: '', friend: true, chirpEnabled: true, presence: { state: 'available', stale: false } };
  const messages: WireMessage[] = [
    { id: '1', threadId: 1, senderId: 2, from: 'Sarah', mine: false, text: 'Are you free tonight?', ts: now - 300000 },
    { id: '2', threadId: 1, senderId: 1, from: 'you', mine: true, text: "Yeah, I'm free. What's the plan?", ts: now - 240000 },
  ];
  const thread: ThreadSummary = { id: 1, type: 'dm', title: 'Sarah', category: 'priority', state: 'active', muted: false, archived: false, pinned: false, unread: 1, last_read_id: 1, last_message: { id: 2, at: agoIso(now - 240000), preview: messages[1].text, sender_id: 1 }, participants: [{ user_id: 2, role: 'member' }], people: [person] };
  let active = 1;
  let callback: ((message: WireMessage) => void) | null = null;
  const bootstrap = (): BootstrapData => ({
    identity: { userId: 'mock-1', wpUserId: 1, profile: { userId: 1, name: 'You', handle: 'you', avatar: '' } },
    threads: { threads: [thread], counts: { priority: { threads: 1, unread: 1 } } },
    people: { friends: [person], live: [person] },
    notifications: { items: [], counts: {} }, preferences: {}, chirp: { chirp_enabled: 1 }, incoming: { incoming: [], missed: [] },
  });
  return {
    name: 'mock', bootstrap: async () => bootstrap(), setActiveThread: id => { active = id; },
    load: async () => messages.filter(m => m.threadId === active),
    send: async text => { const m = { id: String(Date.now()), threadId: active, senderId: 1, from: 'you', mine: true, text, ts: Date.now() }; messages.push(m); return m; },
    openThread: async () => thread, markRead: async () => thread, setFlags: async () => thread, respondRequest: async () => thread,
    clearHistory: async () => ({ deleted: 0 }),
    search: async q => person.name.toLowerCase().includes(q.toLowerCase()) ? [person] : [],
    updateNotification: async () => ({ items: [] }), savePreferences: async input => input, saveChirpSettings: async input => input,
    upload: async file => ({ id: 1, url: URL.createObjectURL(file), mime: file.type }),
    chirpStart: async () => ({ id: 1, decision: 'live' }), chirpSignal: async () => ({}), chirpEnd: async () => ({}), chirpIncoming: async () => ({ incoming: [], missed: [] }),
    iceConfig: async () => ({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }),
    livekitToken: async () => ({ ok: false, reason: 'no-livekit' }),
    connect: cb => { callback = cb; void callback; }, disconnect: () => { callback = null; },
  };
}

function liveTransport(cfg: LoopKickConfig): Transport {
  let activeThread = 0;
  let after = 0;
  let pollAt = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let onMessage: ((m: WireMessage) => void) | null = null;
  let onRefresh: (() => void) | null = null;

  const headers = (json = false): HeadersInit => ({
    ...(cfg.sessionToken ? { Authorization: `Bearer ${cfg.sessionToken}` } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  });

  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(path, { ...options, headers: { ...headers(!!options.body && !(options.body instanceof FormData)), ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.error) throw new Error(body?.error || body?.message || `Messenger returned ${response.status}`);
    return body as T;
  }

  const shape = (raw: Record<string, any>): WireMessage => ({
    id: String(raw.id), threadId: Number(raw.thread_id), senderId: Number(raw.sender_id),
    from: raw.sender_name || String(raw.sender_id), mine: false, text: String(raw.body || ''),
    ts: Date.parse(String(raw.created_at || '')) || Date.now(), type: raw.type, media: raw.media || [],
    replyTo: Number(raw.reply_to || 0), expiresAt: raw.expires_at || null,
  });

  async function load(threadId = activeThread, cursor?: number) {
    if (!threadId) return [];
    const query = cursor !== undefined ? `?per_page=100&after=${cursor}` : '?per_page=100';
    const data = await request<{ messages: Record<string, any>[] }>(`/api/threads/${threadId}/messages${query}`);
    const userId = Number((await identity()).wpUserId);
    const list = (data.messages || []).map(shape).map(m => ({ ...m, mine: m.senderId === userId, from: m.senderId === userId ? 'you' : m.from }));
    if (list.length) after = Math.max(after, ...list.map(m => Number(m.id) || 0));
    return list;
  }

  let identityPromise: Promise<{ wpUserId: number }> | null = null;
  function identity() {
    if (!identityPromise) identityPromise = request<BootstrapData>('/api/bootstrap').then(data => data.identity);
    return identityPromise;
  }

  async function poll() {
    if (stopped) return;
    try {
      const query = pollAt ? `?since=${encodeURIComponent(pollAt)}` : '';
      const data = await request<{ now: string; changed: { id: number }[] }>(`/api/poll${query}`);
      pollAt = data.now;
      if (activeThread && (data.changed || []).some(item => Number(item.id) === activeThread)) {
        for (const message of await load(activeThread, after)) onMessage?.(message);
      }
      if ((data.changed || []).length) onRefresh?.();
    } catch { /* transient polls retry silently */ }
    if (!stopped) timer = setTimeout(poll, 2600);
  }

  return {
    name: 'live',
    bootstrap: async () => {
      const data = await request<BootstrapData>('/api/bootstrap');
      identityPromise = Promise.resolve(data.identity);
      return data;
    },
    setActiveThread: id => { activeThread = id; after = 0; },
    load,
    send: async (text, options = {}) => {
      if (!activeThread) throw new Error('Choose a conversation first.');
      const raw = await request<Record<string, any>>(`/api/threads/${activeThread}/messages`, { method: 'POST', body: JSON.stringify({ body: text, ...options }) });
      const message = shape(raw); after = Math.max(after, Number(message.id) || 0); return { ...message, mine: true, from: 'you' };
    },
    openThread: recipientId => request('/api/threads', { method: 'POST', body: JSON.stringify({ type: 'dm', recipient_id: recipientId }) }),
    markRead: (id, messageId) => request(`/api/threads/${id}/read`, { method: 'POST', body: JSON.stringify(messageId ? { message_id: messageId } : {}) }),
    setFlags: (id, flags) => request(`/api/threads/${id}/flags`, { method: 'POST', body: JSON.stringify(flags) }),
    respondRequest: (id, action) => request(`/api/threads/${id}/request`, { method: 'POST', body: JSON.stringify({ action }) }),
    clearHistory: id => request(`/api/threads/${id}/messages`, { method: 'DELETE' }),
    search: async query => (await request<{ results: Person[] }>(`/api/search?query=${encodeURIComponent(query)}`)).results || [],
    updateNotification: input => request('/api/notifications', { method: 'POST', body: JSON.stringify(input) }),
    savePreferences: input => request('/api/preferences', { method: 'POST', body: JSON.stringify(input) }),
    saveChirpSettings: input => request('/api/chirp/settings', { method: 'POST', body: JSON.stringify(input) }),
    upload: async (file, purpose = 'image') => { const form = new FormData(); form.append('file', file); form.append('purpose', purpose); return request('/api/upload', { method: 'POST', body: form }); },
    chirpStart: receiverId => request('/api/chirp/start', { method: 'POST', body: JSON.stringify({ receiver_id: receiverId }) }),
    chirpSignal: (id, payload = {}) => request(`/api/chirp/sessions/${id}/signal`, { method: Object.keys(payload).length ? 'POST' : 'GET', ...(Object.keys(payload).length ? { body: JSON.stringify(payload) } : {}) }),
    chirpEnd: id => request(`/api/chirp/sessions/${id}/end`, { method: 'POST', body: '{}' }),
    chirpIncoming: () => request('/api/chirp/incoming'),
    iceConfig: () => request('/api/ice'),
    livekitToken: (room) => request('/api/livekit-token', { method: 'POST', body: JSON.stringify({ room }) }),
    connect: (messageCb, refreshCb) => { onMessage = messageCb; onRefresh = refreshCb || null; stopped = false; void poll(); },
    disconnect: () => { stopped = true; if (timer) clearTimeout(timer); timer = null; onMessage = null; onRefresh = null; },
  };
}

export function createTransport(): Transport {
  const cfg = (typeof window !== 'undefined' && window.LOOP_KICK_CONFIG) || {};
  return cfg.transport === 'live' ? liveTransport(cfg) : mockTransport();
}
