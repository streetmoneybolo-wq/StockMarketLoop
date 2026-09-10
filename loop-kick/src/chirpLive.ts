/**
 * Group Chirp LIVE — listener side for the phone (owner call 2026-09-10).
 *
 * Mirrors GET-IT-DONE js/chirp-live.js: joins the group's live room on this same Render origin
 * (/api/chirp-live/*), long-polls for signals, answers the speaker's WebRTC offers and plays the
 * remote audio. One room per group the member has Chirp on for. No media on the server.
 */
export interface LiveMember { key: string; id: number; name: string; avatar: string; mode: 'speaker' | 'listener'; talking: number; channel: number }
export interface LiveRoomState { gid: number; joined: boolean; speakers: number; connected: number; talking: LiveMember[]; needTap: boolean }

interface Peer { pc: RTCPeerConnection; pending: RTCIceCandidateInit[]; audio: HTMLAudioElement | null }
interface Room {
  gid: number; joined: boolean; self: string; members: LiveMember[]; peers: Map<string, Peer>; polling: boolean; stopped: boolean;
  wants: (c: { by: { id: number }; channelId: number }) => boolean; needTap: Set<string>; abort: AbortController | null;
}

const CLIENT = (() => { try { const k = sessionStorage.getItem('sml_lk_live_client') || Math.random().toString(36).slice(2, 12); sessionStorage.setItem('sml_lk_live_client', k); return k; } catch { return Math.random().toString(36).slice(2, 12); } })();

export class ChirpLiveListener {
  private rooms = new Map<number, Room>();
  private ice: RTCConfiguration | null = null;
  private iceAt = 0;
  constructor(private token: () => string, private onChange: (states: LiveRoomState[]) => void) {}

  private headers(json: boolean): Record<string, string> { const h: Record<string, string> = { Authorization: `Bearer ${this.token()}` }; if (json) h['Content-Type'] = 'application/json'; return h; }
  private async post(path: string, body: Record<string, unknown>): Promise<any> {
    const r = await fetch(`/api/chirp-live/${path}`, { method: 'POST', headers: this.headers(true), body: JSON.stringify({ ...body, client: CLIENT }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`) as Error & { status?: number; rejoin?: boolean }; e.status = r.status; e.rejoin = !!j.rejoin; throw e; }
    return j;
  }
  private async iceConfig(): Promise<RTCConfiguration> {
    if (this.ice && Date.now() - this.iceAt < 240000) return this.ice;
    try { const j = await fetch('/api/ice', { cache: 'no-store' }).then(r => r.json()); this.ice = { iceServers: j?.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }] }; }
    catch { this.ice = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }; }
    this.iceAt = Date.now();
    return this.ice;
  }
  states(): LiveRoomState[] {
    return [...this.rooms.values()].map(r => ({
      gid: r.gid, joined: r.joined,
      speakers: r.members.filter(m => m.key !== r.self && m.mode === 'speaker').length,
      connected: [...r.peers.values()].filter(p => p.pc.connectionState === 'connected').length,
      talking: r.members.filter(m => m.key !== r.self && m.talking > 0),
      needTap: r.needTap.size > 0,
    }));
  }
  private emit() { try { this.onChange(this.states()); } catch { /* ui */ } }

  /** keep exactly these groups joined (empty = leave everything) */
  sync(groups: { id: number; wants: Room['wants'] }[]) {
    const keep = new Set(groups.map(g => g.id));
    for (const gid of [...this.rooms.keys()]) if (!keep.has(gid)) this.leave(gid);
    for (const g of groups) {
      const r = this.rooms.get(g.id);
      if (r) { r.wants = g.wants; for (const [key, p] of r.peers) if (p.audio) p.audio.muted = !this.wantsSpeaker(r, key); continue; }
      void this.join(g.id, g.wants);
    }
  }
  private async join(gid: number, wants: Room['wants']) {
    const room: Room = { gid, joined: false, self: '', members: [], peers: new Map(), polling: false, stopped: false, wants, needTap: new Set(), abort: null };
    this.rooms.set(gid, room);
    try {
      const j = await this.post('join', { group: gid, mode: 'listener' });
      if (room.stopped) return;
      room.self = String(j.self || ''); room.joined = true; this.syncMembers(room, j.members || []); void this.poll(room);
    } catch { if (!room.stopped) setTimeout(() => { if (this.rooms.get(gid) === room && !room.joined) void this.join(gid, wants); }, 5000); }
  }
  leave(gid: number) {
    const r = this.rooms.get(gid); if (!r) return;
    r.stopped = true; r.joined = false; this.rooms.delete(gid);
    try { r.abort?.abort(); } catch { /* idle */ }
    for (const key of [...r.peers.keys()]) this.closePeer(r, key);
    void this.post('leave', { group: gid }).catch(() => {});
    this.emit();
  }
  stop() { for (const gid of [...this.rooms.keys()]) this.leave(gid); }
  tapToHear() { for (const r of this.rooms.values()) for (const p of r.peers.values()) if (p.audio) void p.audio.play().then(() => { r.needTap.clear(); this.emit(); }).catch(() => {}); }

  private wantsSpeaker(r: Room, key: string) { const m = r.members.find(x => x.key === key); return r.wants({ by: { id: m ? m.id : 0 }, channelId: m ? m.channel : 0 }); }
  private syncMembers(r: Room, members: LiveMember[]) {
    r.members = members;
    const alive = new Set(members.map(m => m.key));
    for (const key of [...r.peers.keys()]) if (!alive.has(key)) this.closePeer(r, key);
    for (const [key, p] of r.peers) if (p.audio) p.audio.muted = !this.wantsSpeaker(r, key);
    this.emit();
  }
  private closePeer(r: Room, key: string) {
    const p = r.peers.get(key); if (!p) return;
    try { p.pc.close(); } catch { /* closed */ }
    if (p.audio) { try { p.audio.pause(); p.audio.srcObject = null; p.audio.remove(); } catch { /* gone */ } }
    r.peers.delete(key); r.needTap.delete(key);
  }
  private async poll(r: Room) {
    if (!r.joined || r.polling || r.stopped) return;
    r.polling = true;
    try {
      r.abort = new AbortController();
      const res = await fetch(`/api/chirp-live/poll?group=${r.gid}&wait=1&client=${CLIENT}`, { headers: this.headers(false), signal: r.abort.signal });
      const j = await res.json().catch(() => ({}));
      r.polling = false;
      if (r.stopped) return;
      if (!res.ok) { if (j.rejoin || res.status === 409) { r.joined = false; void this.join(r.gid, r.wants); this.rooms.set(r.gid, this.rooms.get(r.gid) || r); return; } setTimeout(() => void this.poll(r), 2500); return; }
      for (const sig of j.signals || []) await this.handle(r, sig);
      this.syncMembers(r, j.members || []);
      void this.poll(r);
    } catch { r.polling = false; if (!r.stopped) setTimeout(() => void this.poll(r), 2500); }
  }
  private async handle(r: Room, sig: { from: string; type: string; payload: any }) {
    const from = String(sig.from); const pl = sig.payload || {};
    if (sig.type === 'offer') {
      this.closePeer(r, from);
      const pc = new RTCPeerConnection(await this.iceConfig());
      const p: Peer = { pc, pending: [], audio: null };
      r.peers.set(from, p);
      pc.onicecandidate = ev => { if (ev.candidate) void this.post('signal', { group: r.gid, to: from, type: 'candidate', payload: ev.candidate.toJSON() }).catch(() => {}); };
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') this.closePeer(r, from); this.emit(); };
      pc.ontrack = ev => {
        const stream = ev.streams[0] || new MediaStream([ev.track]);
        if (!p.audio) { p.audio = document.createElement('audio'); p.audio.autoplay = true; p.audio.setAttribute('playsinline', ''); p.audio.style.display = 'none'; document.body.appendChild(p.audio); }
        p.audio.srcObject = stream; p.audio.muted = !this.wantsSpeaker(r, from);
        p.audio.play().then(() => { r.needTap.delete(from); this.emit(); }).catch(() => { r.needTap.add(from); this.emit(); });
      };
      await pc.setRemoteDescription(new RTCSessionDescription(pl));
      const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
      for (const c of p.pending.splice(0)) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
      await this.post('signal', { group: r.gid, to: from, type: 'answer', payload: { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp } }).catch(() => {});
      return;
    }
    const p = r.peers.get(from);
    if (sig.type === 'candidate') { if (!p) return; if (p.pc.remoteDescription) await p.pc.addIceCandidate(new RTCIceCandidate(pl)).catch(() => {}); else p.pending.push(pl); return; }
    if (sig.type === 'talk') { const m = r.members.find(x => x.key === from); if (m) { m.talking = pl.on ? Date.now() : 0; m.channel = Number(pl.channel) || 0; } if (p?.audio) p.audio.muted = !this.wantsSpeaker(r, from); this.emit(); return; }
    if (sig.type === 'hangup') { this.closePeer(r, from); this.emit(); }
  }
}
