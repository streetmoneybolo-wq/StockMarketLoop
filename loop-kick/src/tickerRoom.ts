import { Transport } from './transport';

/**
 * Ticker voice rooms — the SAME per-ticker room the ticker terminal runs
 * (WordPress plugin "StockMarketLoop Ticker Voice Rooms", sml-ticker-voice/v1).
 *
 * Protocol, mirrored 1:1 from the terminal's client so a member on the phone and a
 * member on /tradingfloor/SPY/ meet in one room:
 *   GET  room?symbol=X                 → { symbol, count, members[] }   (public: look before you join)
 *   POST join { symbol, mode }         → room     mode = speaker | listener
 *   POST heartbeat { symbol, mode, speaking, muted } every 12s → room
 *   GET  signals?symbol=X&after=ms     → { signals[], server_time }  polled every ~1.1s while joined
 *   POST signals { symbol, to_user_id, type: offer|answer|candidate, payload }
 *   POST leave { symbol }
 * Media is a WebRTC audio mesh: the LOWER user id makes the offer to each peer; the other
 * answers; ICE candidates are relayed and queued until the remote description lands.
 * Listeners publish nothing (recvonly transceiver). ICE servers come from /api/ice.
 */

export interface RoomMember {
  id: number; name: string; handle: string; profile_url: string; avatar_url: string;
  mode: 'speaker' | 'listener'; speaking: boolean; muted: boolean; last_seen: number;
}
export interface RoomInfo { symbol: string; title: string; count: number; members: RoomMember[]; current_user_id?: number; updated_at?: string }
export type TickerRoomPhase = 'idle' | 'looking' | 'joining' | 'joined' | 'error';
export interface TickerRoomHandlers {
  onUpdate: (state: { phase: TickerRoomPhase; symbol: string; room: RoomInfo | null; error: string; mode: 'speaker' | 'listener'; muted: boolean; speaking: boolean; level: number }) => void;
}

const cleanSymbol = (s: string) => String(s || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '').slice(0, 12);

export class TickerRoomClient {
  private t: Transport;
  private h: TickerRoomHandlers;
  private selfId = 0;
  symbol = '';
  phase: TickerRoomPhase = 'idle';
  room: RoomInfo | null = null;
  error = '';
  mode: 'speaker' | 'listener' = 'listener';
  muted = true;
  speaking = false;
  level = 0;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private meterFrame = 0;
  private peers = new Map<number, RTCPeerConnection>();
  private pending = new Map<number, RTCIceCandidateInit[]>();
  private sinks = new Map<number, HTMLAudioElement>();
  private signalAfter = 0;
  private signalTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private missing = new Map<number, number>();          /* peer id -> consecutive presence lists without them */
  private lastMembers = new Set<number>();
  private grace = new Map<number, ReturnType<typeof setTimeout>>();
  private lookTimer: ReturnType<typeof setTimeout> | null = null;
  private ice: RTCConfiguration | null = null;
  private audioHost: HTMLElement | null = null;

  constructor(transport: Transport, handlers: TickerRoomHandlers, selfId: number) {
    this.t = transport; this.h = handlers; this.selfId = selfId;
  }
  setSelf(id: number) { this.selfId = id; }
  setAudioHost(el: HTMLElement | null) { this.audioHost = el; if (el) this.sinks.forEach(a => { if (!a.parentNode) el.appendChild(a); }); }
  get joined() { return this.phase === 'joined'; }

  private emit() {
    this.h.onUpdate({ phase: this.phase, symbol: this.symbol, room: this.room, error: this.error, mode: this.mode, muted: this.muted, speaking: this.speaking, level: this.level });
  }
  private set(p: Partial<{ phase: TickerRoomPhase; room: RoomInfo | null; error: string }>) {
    if (p.phase !== undefined) this.phase = p.phase;
    if (p.room !== undefined) this.room = p.room;
    if (p.error !== undefined) this.error = p.error;
    this.emit();
  }

  /** Look before joining: who is in $SYMBOL right now. Keeps refreshing every 12s until joined/cleared. */
  async look(symbol: string) {
    const sym = cleanSymbol(symbol);
    if (!sym) return;
    if (this.joined && sym !== this.symbol) await this.leave();
    this.symbol = sym;
    if (!this.joined) this.set({ phase: 'looking', error: '' });
    await this.refresh();
    this.scheduleLook();
  }
  private scheduleLook() {
    if (this.lookTimer) clearTimeout(this.lookTimer);
    this.lookTimer = setTimeout(() => { void this.refresh().then(() => this.scheduleLook()); }, this.joined ? 8000 : 12000);   /* heartbeats already carry the room while joined */
  }
  /* The room payload carries current_user_id: that is how we know which member is us. Without it
     (selfId 0) we treated ourselves as a peer and offered calls to our own id — every signal came
     back 400 and no real peer ever connected (owner report 2026-09-06). */
  private learnSelf(room: RoomInfo | null) {
    const id = Number(room && room.current_user_id || 0);
    if (id > 0 && id !== this.selfId) this.selfId = id;
  }
  private async refresh() {
    if (!this.symbol) return;
    try {
      const room = await this.t.tickerRoom(this.symbol);
      this.learnSelf(room);
      this.set({ room, error: '' , phase: this.joined ? 'joined' : (this.phase === 'joining' ? 'joining' : 'looking') });
      if (this.joined) await this.syncPeers(room.members || []);
    } catch (e) {
      if (!this.joined) this.set({ error: (e as Error).message || 'Room unavailable.', phase: 'error' });
    }
  }
  clear() {
    if (this.lookTimer) clearTimeout(this.lookTimer); this.lookTimer = null;
    if (!this.joined) { this.symbol = ''; this.set({ phase: 'idle', room: null, error: '' }); }
  }

  async join(mode: 'speaker' | 'listener') {
    if (this.joined || !this.symbol) return;
    if (typeof RTCPeerConnection === 'undefined') { this.set({ phase: 'error', error: 'This browser cannot do live voice.' }); return; }
    this.set({ phase: 'joining', error: '' });
    try {
      if (!this.ice) { try { this.ice = await this.t.iceConfig(); } catch { this.ice = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }; } }
      if (mode === 'speaker') {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        this.muted = false; this.startMeter();
      } else { this.stream = null; this.muted = true; }
      this.mode = mode;
      const room = await this.t.tickerRoomJoin(this.symbol, mode);
      this.learnSelf(room);
      this.set({ phase: 'joined', room });
      await this.syncPeers(room.members || []);
      this.pollSignals();
      this.heartbeat();
      this.scheduleLook();
    } catch (e) {
      this.stopLocal();
      const err = e as Error & { name?: string };
      this.set({ phase: 'error', error: err?.name === 'NotAllowedError' ? 'Microphone blocked — you can still Listen.' : (err?.message || 'Could not join the room.') });
    }
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.stream) this.stream.getAudioTracks().forEach(tr => { tr.enabled = !m; });
    this.emit();
  }

  async leave(notify = true) {
    const wasJoined = this.joined;
    if (notify && wasJoined && this.symbol) { try { await this.t.tickerRoomLeave(this.symbol); } catch { /* best effort */ } }
    if (this.signalTimer) clearTimeout(this.signalTimer); this.signalTimer = null;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null;
    this.peers.forEach((_, id) => this.dropPeer(id));
    this.stopLocal();
    this.mode = 'listener'; this.muted = true; this.speaking = false; this.signalAfter = 0;
    this.set({ phase: this.symbol ? 'looking' : 'idle' });
    if (this.symbol) { await this.refresh(); this.scheduleLook(); }
  }

  /* ---------- media ---------- */
  private startMeter() {
    if (!this.stream || !this.stream.getAudioTracks().length) return;
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext; if (!AC) return;
    this.audioCtx = this.audioCtx || new AC();
    const src = this.audioCtx!.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx!.createAnalyser(); this.analyser.fftSize = 256; this.analyser.smoothingTimeConstant = 0.72;
    src.connect(this.analyser);
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    let last = 0;
    const draw = () => {
      if (!this.analyser) return;
      this.analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / Math.max(1, data.length);
      const level = this.muted ? 0 : Math.max(0, Math.min(100, Math.round((avg / 88) * 100)));
      const speaking = level > 12;
      if (speaking !== this.speaking || Math.abs(level - last) > 6) { this.speaking = speaking; this.level = level; last = level; this.emit(); }
      this.meterFrame = requestAnimationFrame(draw);
    };
    draw();
  }
  private stopLocal() {
    if (this.meterFrame) cancelAnimationFrame(this.meterFrame); this.meterFrame = 0;
    this.analyser = null;
    if (this.audioCtx) { this.audioCtx.close().catch(() => {}); this.audioCtx = null; }
    if (this.stream) this.stream.getTracks().forEach(tr => tr.stop());
    this.stream = null; this.speaking = false; this.level = 0;
  }

  /* ---------- mesh ---------- */
  private peer(id: number) {
    const existing = this.peers.get(id); if (existing) return existing;
    const pc = new RTCPeerConnection({ ...(this.ice || {}), bundlePolicy: 'max-bundle' });
    this.peers.set(id, pc);
    if (this.stream && this.stream.getAudioTracks().length) this.stream.getAudioTracks().forEach(tr => pc.addTrack(tr, this.stream!));
    else pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.onicecandidate = ev => { if (ev.candidate) void this.t.tickerRoomSignal(this.symbol, id, 'candidate', ev.candidate.toJSON ? ev.candidate.toJSON() : (ev.candidate as any)).catch(() => {}); };
    pc.ontrack = ev => this.attach(id, ev.streams[0] || new MediaStream([ev.track]));
    /* 'disconnected' is usually a blip that heals in seconds; only a connection down for 10s is torn down,
       and the lower id re-offers while the peer is still in the room. */
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') { const g = this.grace.get(id); if (g) clearTimeout(g); this.grace.delete(id); this.missing.delete(id); return; }
      if (st === 'closed') { this.dropPeer(id); return; }
      if (st === 'failed') { try { pc.restartIce(); } catch { /* older engines */ } }
      if ((st === 'failed' || st === 'disconnected') && !this.grace.has(id)) {
        this.grace.set(id, setTimeout(() => {
          this.grace.delete(id);
          if (this.peers.get(id) !== pc || !['failed', 'disconnected', 'closed'].includes(pc.connectionState)) return;
          this.dropPeer(id);
          if (this.joined && this.lastMembers.has(id) && this.selfId < id) void this.offer(id).catch(() => {});
        }, 10000));
      }
    };
    return pc;
  }
  private async offer(id: number) {
    const pc = this.peer(id); if (pc.signalingState !== 'stable') return;
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    await this.t.tickerRoomSignal(this.symbol, id, 'offer', { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp });
  }
  private async handle(sig: any) {
    const from = Number(sig.from_user_id || 0); if (!from || from === this.selfId) return;
    const pc = this.peer(from); const payload = sig.payload || {};
    if (sig.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(payload)); await this.flush(from);
      const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
      await this.t.tickerRoomSignal(this.symbol, from, 'answer', { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp });
    } else if (sig.type === 'answer') {
      if (pc.signalingState === 'have-local-offer') { await pc.setRemoteDescription(new RTCSessionDescription(payload)); await this.flush(from); }
    } else if (sig.type === 'candidate') {
      if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(payload));
      else { const q = this.pending.get(from) || []; q.push(payload); this.pending.set(from, q); }
    }
  }
  private async flush(id: number) {
    const pc = this.peers.get(id); const q = this.pending.get(id) || [];
    if (!pc || !pc.remoteDescription) return;
    this.pending.delete(id);
    for (const c of q) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
  }
  private async syncPeers(members: RoomMember[]) {
    if (!this.joined || !this.selfId) return;   /* never mesh until we know who we are */
    const ids = (members || []).map(m => Number(m.id || 0)).filter(id => id && id !== this.selfId).slice(0, 8);
    const active = new Set(ids);
    this.lastMembers = active;
    Array.from(this.peers.keys()).forEach(id => {
      if (active.has(id)) { this.missing.delete(id); return; }
      /* the presence list lags (throttled heartbeats): a connection that is still up is the truth */
      const miss = (this.missing.get(id) || 0) + 1; this.missing.set(id, miss);
      const pc = this.peers.get(id);
      if (pc && pc.connectionState === 'connected' && miss < 6) return;
      if (miss >= 3) { this.dropPeer(id); this.missing.delete(id); }
    });
    for (const id of ids) { if (!this.peers.has(id) && this.selfId < id) await this.offer(id).catch(() => {}); }
  }
  private attach(id: number, stream: MediaStream) {
    let a = this.sinks.get(id);
    if (!a) { a = document.createElement('audio'); a.autoplay = true; (a as any).playsInline = true; this.sinks.set(id, a); (this.audioHost || document.body).appendChild(a); }
    a.srcObject = stream; a.play().catch(() => {});
  }
  private dropPeer(id: number) {
    const g = this.grace.get(id); if (g) clearTimeout(g); this.grace.delete(id);
    const pc = this.peers.get(id); if (pc) pc.close();
    this.peers.delete(id); this.pending.delete(id);
    const a = this.sinks.get(id); if (a) { a.srcObject = null; a.remove(); this.sinks.delete(id); }
  }

  /* ---------- signaling + presence ---------- */
  private pollSignals() {
    if (this.signalTimer) clearTimeout(this.signalTimer);
    const poll = async () => {
      if (!this.joined) return;
      try {
        const data = await this.t.tickerRoomSignals(this.symbol, this.signalAfter);
        for (const sig of (data.signals || [])) { this.signalAfter = Math.max(this.signalAfter, Number(sig.created_at || 0)); await this.handle(sig).catch(() => {}); }
        this.signalAfter = Math.max(this.signalAfter, Number(data.server_time || 0) - 1);
      } catch (e) {
        const st = Number((e as any)?.status || 0);
        if (st === 409 || st === 401) { await this.leave(false); return; }
      }
      /* fast while a peer is still connecting, relaxed once the mesh is up (each poll is a full request) */
      const pcs = Array.from(this.peers.values());
      const settled = pcs.length > 0 && pcs.every(pc => pc.connectionState === 'connected');
      this.signalTimer = setTimeout(poll, pcs.length === 0 ? 2000 : (settled ? 3000 : 1100));
    };
    void poll();
  }
  private heartbeat() {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    const beat = async () => {
      if (!this.joined) return;
      try {
        const room = await this.t.tickerRoomHeartbeat(this.symbol, this.mode, this.speaking, this.muted);
        this.learnSelf(room);
        this.set({ room }); await this.syncPeers(room.members || []);
      } catch { /* the next beat retries */ }
      this.heartbeatTimer = setTimeout(beat, 12000);
    };
    this.heartbeatTimer = setTimeout(beat, 12000);
  }
}
