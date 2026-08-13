import { Transport } from './transport';

/**
 * Group video rooms via LiveKit (SFU). Unlike the 1:1 CallClient (peer-to-peer),
 * rooms scale to many participants: everyone publishes to LiveKit's media server
 * and subscribes to the others. The token comes from the backend /api/livekit-token
 * (signed with the LiveKit API secret). livekit-client is dynamically imported so it
 * only loads when a room is actually opened.
 */

export type RoomPhase = 'idle' | 'connecting' | 'connected' | 'error';
export interface RoomHandlers {
  onPhase: (phase: RoomPhase, meta: { error?: string; count?: number }) => void;
}

type LKMod = typeof import('livekit-client');

export class RoomClient {
  private transport: Transport;
  private h: RoomHandlers;
  private LK: LKMod | null = null;
  private room: any = null;
  private container: HTMLElement | null = null;
  private tiles = new Map<string, HTMLElement>();
  private audioSinks = new Map<string, HTMLAudioElement>();
  private phase: RoomPhase = 'idle';

  constructor(transport: Transport, handlers: RoomHandlers) {
    this.transport = transport;
    this.h = handlers;
  }

  get active() { return this.phase === 'connecting' || this.phase === 'connected'; }

  setContainer(el: HTMLElement | null) { this.container = el; if (el) this.render(); }

  private set(phase: RoomPhase, meta: { error?: string; count?: number } = {}) {
    this.phase = phase;
    this.h.onPhase(phase, meta);
  }

  async join(roomName: string) {
    if (this.active) return;
    this.set('connecting');
    let tok: any = null;
    try { tok = await this.transport.livekitToken(roomName); } catch { tok = null; }
    if (!tok || !tok.ok || !tok.token || !tok.url) {
      this.set('error', { error: tok && tok.reason === 'no-livekit' ? 'Group rooms aren’t set up yet.' : 'Could not join the room.' });
      return;
    }
    try {
      this.LK = await import('livekit-client');
      const LK = this.LK;
      const room = new LK.Room({ adaptiveStream: true, dynacast: true });
      this.room = room;
      const upd = () => this.render();
      room.on(LK.RoomEvent.TrackSubscribed, upd);
      room.on(LK.RoomEvent.TrackUnsubscribed, upd);
      room.on(LK.RoomEvent.LocalTrackPublished, upd);
      room.on(LK.RoomEvent.LocalTrackUnpublished, upd);
      room.on(LK.RoomEvent.ParticipantConnected, upd);
      room.on(LK.RoomEvent.TrackMuted, upd);
      room.on(LK.RoomEvent.TrackUnmuted, upd);
      room.on(LK.RoomEvent.ParticipantDisconnected, (p: any) => { this.dropTile(p.identity); this.render(); this.set('connected', { count: room.remoteParticipants.size + 1 }); });
      room.on(LK.RoomEvent.Disconnected, () => { this.cleanup(); this.set('idle'); });
      room.on(LK.RoomEvent.ConnectionStateChanged, (st: any) => {
        if (st === LK.ConnectionState.Connected) this.set('connected', { count: room.remoteParticipants.size + 1 });
      });
      await room.connect(tok.url, tok.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      await room.localParticipant.setCameraEnabled(true);
      this.set('connected', { count: room.remoteParticipants.size + 1 });
      this.render();
    } catch (error) {
      this.set('error', { error: (error as Error).message || 'Room connection failed.' });
      this.cleanup();
    }
  }

  private dropTile(identity: string) {
    const t = this.tiles.get(identity); if (t) { t.remove(); this.tiles.delete(identity); }
    const a = this.audioSinks.get(identity); if (a) { a.remove(); this.audioSinks.delete(identity); }
  }

  private tileFor(identity: string, name: string): HTMLElement {
    let tile = this.tiles.get(identity);
    if (!tile) {
      tile = document.createElement('div');
      tile.style.cssText = 'position:relative;border-radius:10px;overflow:hidden;background:#0b1218;aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;';
      const ph = document.createElement('div');
      ph.className = 'lk-ph';
      ph.style.cssText = 'font-size:22px;font-weight:700;color:#00ff88;';
      ph.textContent = (name || 'G').slice(0, 1).toUpperCase();
      const label = document.createElement('div');
      label.className = 'lk-name';
      label.style.cssText = 'position:absolute;left:6px;bottom:5px;padding:2px 7px;border-radius:6px;background:rgba(5,9,13,.6);color:#e8edf2;font-size:9px;font-weight:600;z-index:2;max-width:calc(100% - 12px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      label.textContent = name || 'Guest';
      tile.appendChild(ph); tile.appendChild(label);
      this.tiles.set(identity, tile);
    } else {
      const label = tile.querySelector('.lk-name'); if (label) label.textContent = name || 'Guest';
    }
    return tile;
  }

  private attachVideo(tile: HTMLElement, track: any, local: boolean) {
    if ((tile as any).__sid === track.sid && tile.querySelector('video')) return;
    (tile as any).__sid = track.sid;
    const old = tile.querySelector('video'); if (old) old.remove();
    const ph = tile.querySelector('.lk-ph') as HTMLElement | null; if (ph) ph.style.display = 'none';
    const el = track.attach() as HTMLVideoElement;
    el.style.cssText = 'width:100%;height:100%;object-fit:cover;' + (local ? 'transform:scaleX(-1);' : '');
    el.setAttribute('playsinline', ''); el.muted = local;
    tile.insertBefore(el, tile.firstChild);
  }

  private placeholder(tile: HTMLElement) {
    const v = tile.querySelector('video'); if (v) { v.remove(); (tile as any).__sid = null; }
    const ph = tile.querySelector('.lk-ph') as HTMLElement | null; if (ph) ph.style.display = '';
  }

  private render() {
    if (!this.container || !this.room || !this.LK) return;
    const LK = this.LK;
    const seen = new Set<string>();
    const lp = this.room.localParticipant;
    const order: Array<{ id: string; name: string; p: any; local: boolean }> = [
      { id: lp.identity, name: (lp.name || 'You') + ' (you)', p: lp, local: true },
    ];
    this.room.remoteParticipants.forEach((p: any) => order.push({ id: p.identity, name: p.name || 'Guest', p, local: false }));

    order.forEach(({ id, name, p, local }) => {
      seen.add(id);
      const tile = this.tileFor(id, name);
      if (tile.parentElement !== this.container) this.container!.appendChild(tile);
      let camPub: any = null;
      p.trackPublications.forEach((pub: any) => {
        if (pub.kind === LK.Track.Kind.Video && pub.source === LK.Track.Source.Camera) camPub = pub;
        if (!local && pub.kind === LK.Track.Kind.Audio && pub.track && !this.audioSinks.has(id)) {
          const a = pub.track.attach() as HTMLAudioElement; a.style.display = 'none'; document.body.appendChild(a); this.audioSinks.set(id, a);
        }
      });
      if (camPub && camPub.track && !camPub.isMuted) this.attachVideo(tile, camPub.track, local); else this.placeholder(tile);
    });

    this.tiles.forEach((tile, id) => { if (!seen.has(id)) { tile.remove(); this.tiles.delete(id); } });
    this.container.style.gridTemplateColumns = order.length <= 1 ? '1fr' : 'repeat(2, 1fr)';
  }

  setMuted(muted: boolean) { if (this.room) void this.room.localParticipant.setMicrophoneEnabled(!muted); }
  setCameraOff(off: boolean) { if (this.room) void this.room.localParticipant.setCameraEnabled(!off); }

  private cleanup() {
    this.tiles.forEach(t => t.remove()); this.tiles.clear();
    this.audioSinks.forEach(a => a.remove()); this.audioSinks.clear();
    this.room = null;
  }

  async leave() {
    try { if (this.room) await this.room.disconnect(); } catch { /* already gone */ }
    this.cleanup();
    this.set('idle');
  }
}
