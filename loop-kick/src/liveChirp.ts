import { Transport } from './transport';

type SignalView = {
  id: number;
  role?: 'caller' | 'callee';
  peer_id?: number;
  offer?: RTCSessionDescriptionInit | string | null;
  answer?: RTCSessionDescriptionInit | string | null;
  ice?: { c?: RTCIceCandidateInit | string }[];
  expired?: boolean;
};

const RTC_CONFIG: RTCConfiguration = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
] };

function parseRtc<T>(value: T | string | null | undefined): T | null {
  if (!value) return null;
  if (typeof value === 'object') return value as T;
  try { return JSON.parse(String(value)) as T; } catch { return null; }
}

/** Browser-to-browser Chirp audio. WordPress only relays SDP/ICE; audio never passes through either server. */
export class LiveChirpClient {
  private transport: Transport;
  private status: (message: string) => void;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private sender: RTCRtpSender | null = null;
  private stream: MediaStream | null = null;
  private outboundTrack: MediaStreamTrack | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private sessionId = 0;
  private role: 'caller' | 'callee' | '' = '';
  private held = false;
  private signalTimer: ReturnType<typeof setTimeout> | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private seenIce = new Set<string>();

  constructor(transport: Transport, status: (message: string) => void) {
    this.transport = transport;
    this.status = status;
  }

  private async microphone() {
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error('This browser cannot open live Chirp audio.');
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  }

  private wireChannel(channel: RTCDataChannel) {
    this.channel = channel;
    channel.onmessage = event => {
      const command = String(event.data || '');
      if (!this.remoteAudio) return;
      if (command === 'start') {
        this.remoteAudio.muted = false;
        void this.remoteAudio.play().catch(() => this.status('Tap LOOP-KICK once to allow incoming Chirp audio.'));
        this.status('Receiving live Chirp…');
      } else if (command === 'stop' || command === 'prepare') {
        this.remoteAudio.muted = true;
        if (command === 'stop') this.status('Chirp finished.');
      }
    };
    channel.onopen = () => { if (this.role === 'caller' && this.held) this.announceTalk(); };
  }

  private makePeer(role: 'caller' | 'callee', view: SignalView) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;
    this.role = role;
    this.sessionId = Number(view.id);
    this.seenIce.clear();
    pc.onicecandidate = event => {
      if (event.candidate && this.sessionId) void this.transport.chirpSignal(this.sessionId, { ice: event.candidate.toJSON() }).catch(() => {});
    };
    pc.ontrack = event => {
      this.remoteAudio?.remove();
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.muted = true;
      audio.setAttribute('playsinline', '');
      audio.srcObject = event.streams[0] || new MediaStream([event.track]);
      audio.style.display = 'none';
      document.body.appendChild(audio);
      this.remoteAudio = audio;
    };
    pc.ondatachannel = event => this.wireChannel(event.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.status(this.role === 'caller' ? 'Chirp connected — keep holding to talk.' : 'Incoming Chirp connected.');
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') void this.close(false);
    };
    return pc;
  }

  private async addIce(view: SignalView) {
    if (!this.pc) return;
    for (const entry of view.ice || []) {
      const candidate = parseRtc<RTCIceCandidateInit>(entry.c || entry as unknown as RTCIceCandidateInit);
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

  private pollSignal = async () => {
    if (!this.sessionId || !this.pc) return;
    try { await this.applySignal(await this.transport.chirpSignal(this.sessionId) as SignalView); }
    catch { await this.close(false); return; }
    if (this.sessionId && this.pc && this.pc.connectionState !== 'closed') this.signalTimer = setTimeout(this.pollSignal, this.pc.connectionState === 'connected' ? 1000 : 240);
  };

  private announceTalk() {
    if (!this.held || this.channel?.readyState !== 'open') return;
    this.outboundTrack && (this.outboundTrack.enabled = true);
    this.channel.send('start');
    this.status('Talking live — release to stop.');
  }

  async begin(receiverId: number) {
    if (this.held) return;
    this.held = true;
    this.status('Opening microphone and live Chirp…');
    try {
      await this.close(false, true);
      this.held = true;
      const [stream, start] = await Promise.all([this.microphone(), this.transport.chirpStart(receiverId)]);
      const sessionId = Number(start.session_id || 0);
      if (!sessionId || start.decision === 'denied') {
        stream.getTracks().forEach(track => track.stop());
        throw new Error(String(start.reason || 'That friend is not available for a live Chirp.'));
      }
      if (!this.held) { stream.getTracks().forEach(track => track.stop()); await this.transport.chirpEnd(sessionId); return; }
      this.stream = stream;
      const pc = this.makePeer('caller', { id: sessionId });
      this.sender = pc.addTransceiver('audio', { direction: 'sendonly' }).sender;
      this.wireChannel(pc.createDataChannel('chirp-control', { ordered: true }));
      this.outboundTrack = stream.getAudioTracks()[0].clone();
      this.outboundTrack.enabled = false;
      await this.sender.replaceTrack(this.outboundTrack);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.applySignal(await this.transport.chirpSignal(sessionId, { offer: pc.localDescription?.toJSON() }) as SignalView);
      void this.pollSignal();
      if (this.channel?.readyState === 'open') this.announceTalk();
    } catch (error) {
      this.status((error as Error).name === 'NotAllowedError' ? 'Microphone permission was denied.' : (error as Error).message);
      await this.close(true);
    }
  }

  end() {
    this.held = false;
    if (this.channel?.readyState === 'open') this.channel.send('stop');
    if (this.outboundTrack) this.outboundTrack.enabled = false;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.outboundTrack?.stop();
    this.outboundTrack = null;
    this.status('Chirp sent live.');
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => void this.close(true), 800);
  }

  async acceptIncoming(raw: unknown) {
    const view = raw as SignalView;
    if (!view?.id || (this.sessionId === Number(view.id) && this.pc)) return;
    await this.close(false);
    this.status(`Incoming live Chirp from member #${view.peer_id || ''}…`);
    this.makePeer('callee', view);
    try { await this.applySignal(view); void this.pollSignal(); }
    catch { await this.close(false); }
  }

  async close(notify = true, preserveHeld = false) {
    if (this.signalTimer) clearTimeout(this.signalTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
    const id = this.sessionId;
    this.stream?.getTracks().forEach(track => track.stop());
    this.outboundTrack?.stop();
    try { this.channel?.close(); } catch { /* already closed */ }
    try { this.pc?.close(); } catch { /* already closed */ }
    this.remoteAudio?.remove();
    this.pc = null; this.channel = null; this.sender = null; this.stream = null; this.outboundTrack = null; this.remoteAudio = null;
    this.sessionId = 0; this.role = ''; this.seenIce.clear();
    if (!preserveHeld) this.held = false;
    if (notify && id) await this.transport.chirpEnd(id).catch(() => {});
  }
}
