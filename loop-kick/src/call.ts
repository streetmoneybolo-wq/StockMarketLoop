import { Transport } from './transport';

/**
 * Full-duplex voice / video calling between friends. Reuses the existing Chirp
 * signaling (WordPress only relays SDP + ICE via transport.chirpStart/Signal/End);
 * audio and video flow peer-to-peer and never pass through either server.
 *
 * Coexists with the push-to-talk LiveChirpClient: a push-to-talk chirp offers
 * SENDONLY audio, whereas a call offers SENDRECV audio (+ a video m-line for
 * video calls) — so incoming sessions can be routed by inspecting the offer SDP.
 */

type SignalView = {
  id: number;
  role?: 'caller' | 'callee';
  peer_id?: number;
  offer?: RTCSessionDescriptionInit | string | null;
  answer?: RTCSessionDescriptionInit | string | null;
  ice?: { c?: RTCIceCandidateInit | string }[];
  expired?: boolean;
};

export type CallPhase = 'idle' | 'calling' | 'connecting' | 'connected' | 'ended';

export interface CallMeta { peerId: number; video: boolean; error?: string }

export interface CallHandlers {
  onPhase: (phase: CallPhase, meta: CallMeta) => void;
  onLocalStream: (stream: MediaStream | null) => void;
  onRemoteStream: (stream: MediaStream | null) => void;
}

const FALLBACK_ICE: RTCConfiguration = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
] };

function parseRtc<T>(value: T | string | null | undefined): T | null {
  if (!value) return null;
  if (typeof value === 'object') return value as T;
  try { return JSON.parse(String(value)) as T; } catch { return null; }
}

/** Does this offer describe a call (sendrecv audio and/or video) vs a push-to-talk chirp (sendonly audio)? */
export function offerIsCall(offer: RTCSessionDescriptionInit | string | null | undefined): { call: boolean; video: boolean } {
  const sdp = String((typeof offer === 'string' ? parseRtc<RTCSessionDescriptionInit>(offer) : offer)?.sdp || (typeof offer === 'string' ? offer : ''));
  const video = /\r?\nm=video[ ]/.test(sdp);
  const sendrecvAudio = /m=audio[\s\S]*?a=sendrecv/.test(sdp) || /m=audio[\s\S]*?a=recvonly/.test(sdp);
  return { call: video || sendrecvAudio, video };
}

export class CallClient {
  private transport: Transport;
  private h: CallHandlers;
  private pc: RTCPeerConnection | null = null;
  private local: MediaStream | null = null;
  private remote: MediaStream | null = null;
  private sessionId = 0;
  private role: 'caller' | 'callee' | '' = '';
  private peerId = 0;
  private video = false;
  private phase: CallPhase = 'idle';
  private signalTimer: ReturnType<typeof setTimeout> | null = null;
  private seenIce = new Set<string>();
  private iceCfg: RTCConfiguration | null = null;

  constructor(transport: Transport, handlers: CallHandlers) {
    this.transport = transport;
    this.h = handlers;
  }

  get busy() { return this.phase === 'calling' || this.phase === 'connecting' || this.phase === 'connected'; }
  get currentPeer() { return this.peerId; }
  get currentSession() { return this.sessionId; }

  private set(phase: CallPhase, error?: string) {
    this.phase = phase;
    this.h.onPhase(phase, { peerId: this.peerId, video: this.video, error });
  }

  private async ice(): Promise<RTCConfiguration> {
    if (this.iceCfg) return this.iceCfg;
    try {
      const cfg = await this.transport.iceConfig();
      if (cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length) { this.iceCfg = cfg; return cfg; }
    } catch { /* fall through to STUN */ }
    this.iceCfg = FALLBACK_ICE;
    return FALLBACK_ICE;
  }

  private async media(video: boolean): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error('This device cannot make calls.');
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 }, facingMode: 'user' } : false,
    });
  }

  private async makePeer(role: 'caller' | 'callee', sessionId: number): Promise<RTCPeerConnection> {
    const pc = new RTCPeerConnection(await this.ice());
    this.pc = pc; this.role = role; this.sessionId = sessionId; this.seenIce.clear();
    this.remote = new MediaStream();
    this.h.onRemoteStream(this.remote);
    pc.onicecandidate = event => {
      if (event.candidate && this.sessionId) void this.transport.chirpSignal(this.sessionId, { ice: event.candidate.toJSON() }).catch(() => {});
    };
    pc.ontrack = event => {
      const stream = event.streams[0];
      const tracks = stream ? stream.getTracks() : [event.track];
      for (const t of tracks) { if (this.remote && !this.remote.getTracks().includes(t)) this.remote.addTrack(t); }
      this.h.onRemoteStream(this.remote);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.set('connected');
      // Only give up on a hard ICE failure. 'disconnected' is often transient and
      // recovers on its own; 'closed' only happens when we tear down ourselves.
      if (pc.connectionState === 'failed') void this.hangup(false);
    };
    if (this.local) for (const track of this.local.getTracks()) pc.addTrack(track, this.local);
    return pc;
  }

  private async addIce(view: SignalView) {
    if (!this.pc) return;
    for (const entry of view.ice || []) {
      const candidate = parseRtc<RTCIceCandidateInit>(entry.c || (entry as unknown as RTCIceCandidateInit));
      if (!candidate) continue;
      const key = `${candidate.candidate}|${candidate.sdpMid}|${candidate.sdpMLineIndex}`;
      if (this.seenIce.has(key)) continue;
      this.seenIce.add(key);
      await this.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  private async applySignal(view: SignalView) {
    if (!this.pc || !view || view.expired) return;
    if (this.role === 'caller' && view.answer && !this.pc.remoteDescription) {
      const answer = parseRtc<RTCSessionDescriptionInit>(view.answer);
      if (answer) await this.pc.setRemoteDescription(answer);
    }
    if (this.role === 'callee' && view.offer && !this.pc.remoteDescription) {
      const offer = parseRtc<RTCSessionDescriptionInit>(view.offer);
      if (offer) {
        await this.pc.setRemoteDescription(offer);
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        await this.transport.chirpSignal(this.sessionId, { answer: this.pc.localDescription?.toJSON() });
      }
    }
    await this.addIce(view);
  }

  private pollFails = 0;
  private poll = async () => {
    if (!this.sessionId || !this.pc) return;
    // A single failed signal fetch is usually a transient network/proxy blip — do
    // NOT drop the call for it. Only give up after several consecutive failures.
    try { await this.applySignal(await this.transport.chirpSignal(this.sessionId) as SignalView); this.pollFails = 0; }
    catch { if (++this.pollFails >= 6) { await this.hangup(false); return; } }
    if (this.sessionId && this.pc && this.pc.connectionState !== 'closed') {
      this.signalTimer = setTimeout(this.poll, this.pc.connectionState === 'connected' ? 1500 : 300);
    }
  };

  /** Place an outgoing call. */
  async call(peerId: number, video: boolean) {
    if (this.busy) return;
    this.peerId = peerId; this.video = video;
    this.set('calling');
    try {
      this.local = await this.media(video);
      this.h.onLocalStream(this.local);
      const start = await this.transport.chirpStart(peerId);
      const sessionId = Number(start.session_id || start.id || 0);
      if (!sessionId || start.decision === 'denied') throw new Error(String(start.reason || 'That friend is not available to call.'));
      const pc = await this.makePeer('caller', sessionId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.set('connecting');
      await this.applySignal(await this.transport.chirpSignal(sessionId, { offer: pc.localDescription?.toJSON() }) as SignalView);
      void this.poll();
    } catch (error) {
      const name = (error as Error).name;
      this.set('ended', name === 'NotAllowedError' ? 'Camera / microphone permission was denied.' : (error as Error).message);
      await this.hangup(true);
    }
  }

  /** Answer an incoming call (the caller's offer view). */
  async accept(view: SignalView) {
    if (this.busy && this.sessionId === Number(view.id)) return;
    this.peerId = Number(view.peer_id || 0);
    this.video = offerIsCall(view.offer).video;
    this.set('connecting');
    try {
      this.local = await this.media(this.video);
      this.h.onLocalStream(this.local);
      await this.makePeer('callee', Number(view.id));
      await this.applySignal(view);
      void this.poll();
    } catch (error) {
      this.set('ended', (error as Error).message);
      await this.hangup(true);
    }
  }

  async decline(sessionId: number) { await this.transport.chirpEnd(sessionId).catch(() => {}); }

  setMuted(muted: boolean) { this.local?.getAudioTracks().forEach(t => { t.enabled = !muted; }); }
  setCameraOff(off: boolean) { this.local?.getVideoTracks().forEach(t => { t.enabled = !off; }); }
  hasVideo() { return !!this.local?.getVideoTracks().length; }

  async hangup(notify = true) {
    if (this.signalTimer) { clearTimeout(this.signalTimer); this.signalTimer = null; }
    const id = this.sessionId;
    this.local?.getTracks().forEach(t => t.stop());
    try { this.pc?.close(); } catch { /* already closed */ }
    this.pc = null; this.local = null; this.remote = null;
    this.sessionId = 0; this.role = ''; this.seenIce.clear();
    this.h.onLocalStream(null);
    this.h.onRemoteStream(null);
    this.set('ended');
    this.peerId = 0; this.video = false; this.phase = 'idle';
    if (notify && id) await this.transport.chirpEnd(id).catch(() => {});
  }
}
