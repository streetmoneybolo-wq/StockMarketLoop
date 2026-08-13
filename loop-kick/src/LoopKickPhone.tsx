/**
 * LOOP-KICK phone — faithful React port of `Loop Kick Phone.dc.html`,
 * wired into the message system via src/transport.ts.
 *
 * The original design's DCLogic class maps almost 1:1 onto a React class
 * component; state keys, mode names, and style values are kept verbatim so
 * the rendered device matches the approved design.
 */
import React from 'react';
import { BootstrapData, createTransport, Person, SiteNotification, ThreadSummary, Transport, WireMessage } from './transport';
import { LiveChirpClient } from './liveChirp';
import { CallClient, offerIsCall } from './call';

/* ---------------- static data from the design ---------------- */

const CHIRPS = [
  { user: '@grandmaster', ticker: '$MRAM', time: '2m', text: 'Gamma squeeze setup still intact. Watching the 9:45 candle.' },
  { user: '@loopdesk', ticker: '$SNDK', time: '11m', text: 'AI storage names bid again premarket. Volume leading price here.' },
  { user: '@floatwatch', ticker: '$AKAN', time: '26m', text: 'Low float + catalyst. Size down, this one moves in 20% steps.' },
  { user: '@tapereader', ticker: '$SDOT', time: '1h', text: 'Halted twice. If it holds VWAP after resume, trend day.' },
];
const QUICK = ["Yeah, I'm free!", "What's the plan?", 'On my way', 'Send the ticker', "Can't tonight"];
const ACCENT_OPTS = [
  { c: '#00ff88', d: '#00b565', fg: '#06120c' },
  { c: '#3d8bfd', d: '#1f5fd0', fg: '#ffffff' },
  { c: '#ffb020', d: '#d78b00', fg: '#1a1200' },
  { c: '#ff5c7a', d: '#d42a4c', fg: '#ffffff' },
  { c: '#b98cff', d: '#8a55e0', fg: '#160a2a' },
];
const FONT_OPTS = [
  { key: 'plex', label: 'Plex', stack: "'IBM Plex Sans', sans-serif" },
  { key: 'grotesk', label: 'Grotesk', stack: "'Space Grotesk', sans-serif" },
  { key: 'archivo', label: 'Archivo', stack: "'Archivo', sans-serif" },
];
const BG_OPTS = [
  { key: 'carbon', label: 'Carbon', bg: (_a: string) => '#04090e' },
  { key: 'ocean', label: 'Ocean', bg: (_a: string) => 'linear-gradient(160deg,#03121f 0%,#04090e 100%)' },
  { key: 'ember', label: 'Ember', bg: (_a: string) => 'linear-gradient(160deg,#1a0c12 0%,#070408 100%)' },
  { key: 'glow', label: 'Glow', bg: (a: string) => 'radial-gradient(260px 150px at 50% 0%, ' + a + '24 0%, #04090e 72%)' },
];
const ROOM_POOL = [
  { user: '@floatwatch', color: '#3d8bfd', text: 'volume just doubled on the 1min' },
  { user: '@tapereader', color: '#b98cff', text: 'bid holding 34.80, sellers thinning' },
  { user: '@grandmaster', color: '#00ff88', text: 'this is the setup. patience.' },
  { user: '@loopdesk', color: '#ffb020', text: 'halt candidate if this pace keeps up' },
  { user: '@shortsqz', color: '#ff5c7a', text: 'borrow rate just ticked up again' },
];
const NOTIF_TINTS = [
  'linear-gradient(140deg,#3d8bfd,#1f5fd0)',
  'linear-gradient(140deg,#00e07a,#009c55)',
  'linear-gradient(140deg,#ff5c7a,#d42a4c)',
  'linear-gradient(140deg,#b98cff,#8a55e0)',
];
const PEER_NAME = typeof window !== 'undefined' ? (window.LOOP_KICK_CONFIG?.peerName || 'Loop') : 'Loop';

/* ---------------- types ---------------- */

interface ThreadMsg { id: string; from: 'me' | 'them'; text: string; media?: { id: number; mime: string; url: string }[]; }
interface Notif { id: string; title: string; text: string; time: string; tint: string; unread: boolean; link?: string; category?: string; }
interface RoomMsg { user: string; color: string; text: string; }

interface State {
  open: boolean;
  slid: boolean;
  tab: 'messages' | 'chirp' | 'notifs';
  mode: 'compose' | 'watch' | 'room' | 'video' | 'voice' | 'style';
  accent: string;
  font: string;
  topBgKey: string;
  deckBgKey: string;
  wmOn: boolean;
  wmText: string;
  draft: string;
  playing: boolean;
  watchSec: number;
  viewers: number;
  callSec: number;
  muted: boolean;
  camOff: boolean;
  speaker: boolean;
  roomCount: number;
  roomFeed: RoomMsg[];
  thread: ThreadMsg[];
  notifs: Notif[];
  vh: number;
  sendError: string;
  threads: ThreadSummary[];
  activeThreadId: number;
  people: Person[];
  search: string;
  searchResults: Person[];
  loading: boolean;
  uploading: boolean;
  preferences: Record<string, string | number | boolean>;
  chirpPrefs: Record<string, string | number | boolean>;
  chirpStatus: string;
  callPhase: 'idle' | 'calling' | 'connecting' | 'connected' | 'ended';
  callVideo: boolean;
  callPeerId: number;
  callPeerName: string;
  callError: string;
  incoming: { id: number; peerId: number; peerName: string; video: boolean } | null;
}

const S: Record<string, React.CSSProperties> = {}; // populated in render helpers below

interface Props { initialOpen?: boolean; }

export default class LoopKickPhone extends React.Component<Props, State> {
  state: State = {
    open: !!this.props.initialOpen,
    slid: !!this.props.initialOpen,
    tab: 'messages',
    mode: 'compose',
    accent: '#00ff88',
    font: 'plex',
    topBgKey: 'carbon',
    deckBgKey: 'carbon',
    wmOn: true,
    wmText: 'LOOP',
    draft: '',
    playing: true,
    watchSec: 47,
    viewers: 1284,
    callSec: 0,
    muted: false,
    camOff: false,
    speaker: false,
    roomCount: 212,
    roomFeed: [
      { user: '@grandmaster', color: '#00ff88', text: 'gamma ramp starts above 36' },
      { user: '@floatwatch', color: '#3d8bfd', text: 'float is only 4.1M, remember that' },
      { user: '@tapereader', color: '#b98cff', text: 'watching the 9:45 candle' },
    ],
    thread: [],
    notifs: [
      { id: 'demo-1', title: PEER_NAME, text: 'Are you free tonight?', time: '2m', tint: NOTIF_TINTS[0], unread: true },
      { id: 'demo-2', title: 'Alex', text: 'Check out these pics!', time: '14m', tint: NOTIF_TINTS[1], unread: true },
      { id: 'demo-3', title: 'Mike', text: "Let's meet up later", time: '38m', tint: NOTIF_TINTS[2], unread: true },
      { id: 'demo-4', title: 'Loop Live', text: 'Market open stream starts in 10 minutes', time: '1h', tint: NOTIF_TINTS[3], unread: false },
    ],
    vh: typeof window !== 'undefined' ? window.innerHeight : 900,
    sendError: '',
    threads: [],
    activeThreadId: 0,
    people: [],
    search: '',
    searchResults: [],
    loading: false,
    uploading: false,
    preferences: {},
    chirpPrefs: {},
    chirpStatus: '',
    callPhase: 'idle',
    callVideo: false,
    callPeerId: 0,
    callPeerName: '',
    callError: '',
    incoming: null,
  };

  private transport: Transport = createTransport();
  private chirp = new LiveChirpClient(this.transport, chirpStatus => this.setState({ chirpStatus }));
  private call = new CallClient(this.transport, {
    onPhase: (callPhase, meta) => {
      if (callPhase === 'connected' && this.state.callPhase !== 'connected') this.setState({ callSec: 0 });
      this.setState({ callPhase, callVideo: meta.video, callError: meta.error || '' });
      if (callPhase === 'ended') { const err = meta.error; this._callEndTimer = setTimeout(() => this.setState(p => (p.callPhase === 'ended' ? { callPhase: 'idle', mode: p.mode === 'video' || p.mode === 'voice' ? 'compose' : p.mode } : null)), err ? 2600 : 400); }
    },
    onLocalStream: (s) => { this._localStream = s; this.attachStream(this._localEl, s, true); },
    onRemoteStream: (s) => { this._remoteStream = s; this.attachStream(this._remoteEl, s, false); },
  });
  private _localStream: MediaStream | null = null;
  private _remoteStream: MediaStream | null = null;
  private _localEl: HTMLVideoElement | null = null;
  private _remoteEl: HTMLVideoElement | null = null;
  private _callEndTimer: ReturnType<typeof setTimeout> | null = null;
  private _handledIncoming = new Set<number>();
  private _wantScroll = false;
  private _interval: ReturnType<typeof setInterval> | null = null;
  private _roomTick = 0;
  private _searchTimer: ReturnType<typeof setTimeout> | null = null;
  private _chirpTimer: ReturnType<typeof setInterval> | null = null;
  private _fileInput = React.createRef<HTMLInputElement>();
  private _dockSurface = React.createRef<HTMLDivElement>();
  private _topSurface = React.createRef<HTMLDivElement>();
  private _bottomSurface = React.createRef<HTMLDivElement>();
  private _surfaceTimers: Array<ReturnType<typeof setTimeout>> = [];
  private _key = (e: KeyboardEvent) => {
    if (!this.state.open) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Enter') { e.preventDefault(); this.send(); }
    else if (e.key === 'Backspace') { e.preventDefault(); this.setState(p => ({ draft: p.draft.slice(0, -1) })); }
    else if (e.key === 'Escape') this.setState({ open: false, slid: false });
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      this.setState(p => ({ draft: (p.draft + e.key).slice(0, 120) }));
    }
  };
  private _resize = () => this.setState({ vh: window.innerHeight });

  private publishEmbedSurface = () => {
    if (window.parent === window) return;

    const surface = !this.state.open ? 'closed' : this.state.slid ? 'expanded' : 'folded';
    const nodes = !this.state.open
      ? [{ node: this._dockSurface.current, radius: 16 }]
      : this.state.slid
        ? [
            { node: this._topSurface.current, radius: 30 },
            { node: this._bottomSurface.current, radius: 26 },
          ]
        : [{ node: this._bottomSurface.current, radius: 26 }];
    const surfaces = nodes.flatMap(({ node, radius }) => {
      if (!node) return [];
      const rect = node.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return [];
      return [{
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        radius,
      }];
    });

    let targetOrigin = '*';
    try {
      if (document.referrer) targetOrigin = new URL(document.referrer).origin;
    } catch {
      targetOrigin = '*';
    }

    window.parent.postMessage({
      type: 'sml-loop-kick:surface',
      version: 1,
      surface,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      surfaces,
    }, targetOrigin);
  };

  private scheduleEmbedSurface = () => {
    this._surfaceTimers.forEach(timer => clearTimeout(timer));
    this._surfaceTimers = [0, 60, 140, 260, 430, 520].map(delay => (
      setTimeout(this.publishEmbedSurface, delay)
    ));
  };

  scrollBottom() { this._wantScroll = true; }

  componentDidUpdate(_previousProps: Props, previousState: State) {
    if (
      previousState.open !== this.state.open
      || previousState.slid !== this.state.slid
      || previousState.vh !== this.state.vh
    ) {
      this.scheduleEmbedSurface();
    }
    if (!this._wantScroll) return;
    this._wantScroll = false;
    const pin = () => {
      document.querySelectorAll<HTMLElement>('div').forEach(el => {
        if (el.style && el.style.overflowY === 'auto' && el.scrollHeight > el.clientHeight) {
          el.scrollTop = el.scrollHeight;
        }
      });
    };
    setTimeout(pin, 30);
    setTimeout(pin, 480);
  }

  componentDidMount() {
    window.addEventListener('resize', this._resize);
    window.addEventListener('keydown', this._key);
    this.scheduleEmbedSurface();

    /* ---- the existing StockMarketLoop messenger is the source of truth ---- */
    void this.hydrate().finally(() => this.transport.connect(this.onIncoming, () => void this.refreshSummary()));
    this._chirpTimer = setInterval(() => {
      this.transport.chirpIncoming().then(data => {
        const incoming = (data.incoming || [])[0] as { id?: number; peer_id?: number; peer_name?: string; offer?: unknown } | undefined;
        if (!incoming?.id) return;
        const id = Number(incoming.id);
        if (this._handledIncoming.has(id) || this.call.currentSession === id) return;
        if (!incoming.offer) return; // wait until the offer arrives so we can classify it
        const kind = offerIsCall(incoming.offer as never);
        if (kind.call) {
          // A real voice/video call -> show the accept/decline banner.
          if (this.call.busy || this.state.incoming) return;
          this._handledIncoming.add(id);
          const peerId = Number(incoming.peer_id || 0);
          this.setState({ incoming: { id, peerId, peerName: incoming.peer_name || this.peerName(peerId), video: kind.video } });
        } else {
          void this.chirp.acceptIncoming(incoming); // sendonly audio -> push-to-talk chirp (unchanged)
        }
      }).catch(() => {});
    }, 2800);

    /* ---- design's ambient simulations (watch/call/room) ---- */
    this._interval = setInterval(() => {
      const s = this.state;
      if (!s.open || !s.slid) return;
      if (s.mode === 'watch' && s.playing) {
        this.setState(p => ({ watchSec: p.watchSec + 1, viewers: p.viewers + (Math.random() < 0.3 ? 1 : 0) }));
      }
      if ((s.mode === 'video' || s.mode === 'voice') && s.callPhase === 'connected') {
        this.setState(p => ({ callSec: p.callSec + 1 }));
      }
      if (s.mode === 'room') {
        this._roomTick++;
        if (this._roomTick % 4 === 0) {
          const msg = ROOM_POOL[Math.floor(Math.random() * ROOM_POOL.length)];
          this.scrollBottom();
          this.setState(p => ({
            roomFeed: [...p.roomFeed.slice(-14), msg],
            roomCount: p.roomCount + (Math.random() < 0.5 ? 1 : -1),
          }));
        }
      }
    }, 1000);
  }

  componentWillUnmount() {
    window.removeEventListener('keydown', this._key);
    window.removeEventListener('resize', this._resize);
    if (this._interval) clearInterval(this._interval);
    if (this._searchTimer) clearTimeout(this._searchTimer);
    if (this._chirpTimer) clearInterval(this._chirpTimer);
    this._surfaceTimers.forEach(timer => clearTimeout(timer));
    this._surfaceTimers = [];
    if (this._callEndTimer) clearTimeout(this._callEndTimer);
    void this.chirp.close(true);
    void this.call.hangup(true);
    this.transport.disconnect();
  }

  /* ---------------- voice / video calls ---------------- */

  private attachStream(el: HTMLVideoElement | null, stream: MediaStream | null, muted: boolean) {
    if (!el) return;
    el.srcObject = stream;
    el.muted = muted;
    if (stream) void el.play().catch(() => {});
  }

  private peerName(userId: number): string {
    const p = this.state.people.find(person => person.userId === userId);
    if (p?.name) return p.name;
    const active = this.state.threads.find(t => t.id === this.state.activeThreadId);
    return active?.people?.[0]?.name || active?.title || PEER_NAME;
  }

  // The friend to call = the active conversation's peer (falls back to first friend).
  private callTarget(): { id: number; name: string } | null {
    const active = this.state.threads.find(t => t.id === this.state.activeThreadId);
    const peer = active?.people?.[0] || this.state.people.find(pp => pp.friend) || this.state.people[0];
    if (!peer?.userId) return null;
    return { id: peer.userId, name: peer.name || PEER_NAME };
  }

  private startCall = (video: boolean) => {
    if (this.call.busy) return;
    const target = this.callTarget();
    if (!target) { this.setState({ mode: video ? 'video' : 'voice', callPhase: 'ended', callError: 'Open a chat with a friend first, then call.' }); return; }
    this.setState({ mode: video ? 'video' : 'voice', callPeerId: target.id, callPeerName: target.name, callVideo: video, muted: false, camOff: false, callSec: 0, callError: '' });
    void this.call.call(target.id, video);
  };

  private acceptIncomingCall = () => {
    const inc = this.state.incoming; if (!inc) return;
    this.setState({ incoming: null, open: true, slid: true, tab: 'messages', mode: inc.video ? 'video' : 'voice', callPeerId: inc.peerId, callPeerName: inc.peerName, callVideo: inc.video, muted: false, camOff: false, callSec: 0, callError: '' });
    // Fetch the caller's full offer, then answer it.
    this.transport.chirpSignal(inc.id)
      .then(view => void this.call.accept({ ...(view as object), id: inc.id, peer_id: inc.peerId } as never))
      .catch(() => this.setState({ callPhase: 'ended', callError: 'Could not connect the call.' }));
  };

  private declineIncoming = () => {
    const inc = this.state.incoming; if (!inc) return;
    void this.call.decline(inc.id);
    this.setState({ incoming: null });
  };

  private endCall = () => {
    void this.call.hangup(true);
    this.setState(p => ({ callPhase: 'idle', mode: p.mode === 'video' || p.mode === 'voice' ? 'compose' : p.mode, callSec: 0 }));
  };

  private toggleMute = () => { const m = !this.state.muted; this.call.setMuted(m); this.setState({ muted: m }); };
  private toggleCam = () => { const off = !this.state.camOff; this.call.setCameraOff(off); this.setState({ camOff: off }); };

  /* ---------------- message system wiring ---------------- */

  private wireToThread = (m: WireMessage): ThreadMsg => ({
    id: m.id,
    from: m.mine ? 'me' : 'them',
    text: m.text,
    media: m.media,
  });

  private notification = (item: SiteNotification, index: number): Notif => ({
    id: item.id,
    title: item.category === 'priority' ? 'Priority alert' : (item.source === 'loop_bucks' ? 'Loop Bucks' : 'StockMarketLoop'),
    text: item.message,
    time: item.date ? new Date(item.date).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '',
    tint: item.category === 'priority' ? NOTIF_TINTS[2] : NOTIF_TINTS[index % NOTIF_TINTS.length],
    unread: !item.read,
    link: item.link,
    category: item.category,
  });

  private applyBootstrap = (data: BootstrapData, preserveThread = true) => {
    const threads = data.threads?.threads || [];
    const active = preserveThread && threads.some(t => t.id === this.state.activeThreadId) ? this.state.activeThreadId : 0;
    this.setState({
      threads,
      activeThreadId: active,
      people: data.people?.friends || [],
      notifs: (data.notifications?.items || []).map(this.notification),
      preferences: data.preferences || {},
      chirpPrefs: data.chirp || {},
      loading: false,
    });
    const incoming = (data.incoming?.incoming || [])[0];
    if (incoming) void this.chirp.acceptIncoming(incoming);
  };

  private hydrate = async () => {
    this.setState({ loading: true, sendError: '' });
    try { this.applyBootstrap(await this.transport.bootstrap(), false); }
    catch (error) { this.setState({ loading: false, sendError: (error as Error).message }); }
  };

  private refreshSummary = async () => {
    try { this.applyBootstrap(await this.transport.bootstrap()); } catch { /* next poll retries */ }
  };

  private openThread = async (thread: ThreadSummary) => {
    this.transport.setActiveThread(thread.id);
    this.setState({ activeThreadId: thread.id, thread: [], loading: true, sendError: '', tab: 'messages' });
    try {
      const messages = await this.transport.load(thread.id);
      this.setState({ thread: messages.map(this.wireToThread), loading: false });
      const last = messages.length ? Number(messages[messages.length - 1].id) : undefined;
      await this.transport.markRead(thread.id, last);
      void this.refreshSummary();
      this.scrollBottom();
    } catch (error) { this.setState({ loading: false, sendError: (error as Error).message }); }
  };

  private openPerson = async (person: Person) => {
    this.setState({ loading: true, sendError: '' });
    try { await this.openThread(await this.transport.openThread(person.userId)); }
    catch (error) { this.setState({ loading: false, sendError: (error as Error).message }); }
  };

  private searchPeople = (value: string) => {
    this.setState({ search: value });
    if (this._searchTimer) clearTimeout(this._searchTimer);
    if (value.trim().length < 2) { this.setState({ searchResults: [] }); return; }
    this._searchTimer = setTimeout(() => {
      this.transport.search(value.trim()).then(searchResults => this.setState({ searchResults })).catch(() => this.setState({ searchResults: [] }));
    }, 240);
  };

  private chooseFile = () => this._fileInput.current?.click();

  private uploadFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !this.state.activeThreadId) return;
    this.setState({ uploading: true, sendError: '' });
    try {
      const uploaded = await this.transport.upload(file, file.type.startsWith('image/') ? 'image' : 'voice');
      const message = await this.transport.send(file.name, { media: [uploaded.id], message_type: file.type.startsWith('image/') ? 'image' : 'voice' });
      this.scrollBottom();
      this.setState(p => ({ thread: [...p.thread, this.wireToThread(message)], uploading: false }));
    } catch (error) { this.setState({ uploading: false, sendError: (error as Error).message }); }
  };

  private markNotification = async (item: Notif) => {
    this.setState(p => ({ notifs: p.notifs.map(n => n.id === item.id ? { ...n, unread: false } : n) }));
    if (!item.id.startsWith('demo-')) {
      try { await this.transport.updateNotification({ action: 'read', id: item.id }); } catch { /* optimistic read can retry later */ }
    }
    if (item.link) window.open(item.link, '_top');
  };

  private toggleFlag = async (flag: 'muted' | 'archived' | 'pinned') => {
    const thread = this.state.threads.find(t => t.id === this.state.activeThreadId);
    if (!thread) return;
    try { await this.transport.setFlags(thread.id, { [flag]: !thread[flag] }); await this.refreshSummary(); }
    catch (error) { this.setState({ sendError: (error as Error).message }); }
  };

  private togglePreference = async (key: string) => {
    const value = this.state.preferences[key] ? 0 : 1;
    this.setState(p => ({ preferences: { ...p.preferences, [key]: value } }));
    try { this.setState({ preferences: await this.transport.savePreferences({ [key]: value }) as Record<string, string | number | boolean> }); }
    catch (error) { this.setState({ sendError: (error as Error).message }); }
  };

  private toggleChirpPreference = async (key: string) => {
    const value = this.state.chirpPrefs[key] ? 0 : 1;
    this.setState(p => ({ chirpPrefs: { ...p.chirpPrefs, [key]: value } }));
    try { this.setState({ chirpPrefs: await this.transport.saveChirpSettings({ [key]: value }) as Record<string, string | number | boolean> }); }
    catch (error) { this.setState({ chirpStatus: (error as Error).message }); }
  };

  private clearActiveHistory = async () => {
    const id = this.state.activeThreadId;
    if (!id || !window.confirm('Delete this private conversation history for both people? This cannot be undone.')) return;
    try { await this.transport.clearHistory(id); this.setState({ thread: [] }); await this.refreshSummary(); }
    catch (error) { this.setState({ sendError: (error as Error).message }); }
  };

  private startChirp = async (person: Person) => {
    this.setState({ chirpStatus: `Connecting live Chirp with ${person.name}…` });
    try {
      const session = await this.transport.chirpStart(person.userId);
      this.setState({ chirpStatus: String(session.decision || '') === 'live' ? `Live Chirp ready with ${person.name}. Hold-to-talk audio is connecting.` : String(session.reason || 'Chirp is unavailable right now.') });
    } catch (error) { this.setState({ chirpStatus: (error as Error).message }); }
  };

  /** Incoming message (WebSocket in live mode, canned reply in mock). */
  private onIncoming = (m: WireMessage) => {
    if (!m || !m.text) return;
    const s = this.state;
    const seen = s.open && s.slid && s.tab === 'messages';
    this.scrollBottom();
    this.setState(p => ({
      thread: m.threadId === p.activeThreadId ? [...p.thread, this.wireToThread(m)] : p.thread,
      notifs: seen
        ? p.notifs
        : [
            {
              id: `message-${m.id}`,
              title: m.from || 'Message',
              text: m.text,
              time: 'now',
              tint: NOTIF_TINTS[0],
              unread: true,
            },
            ...p.notifs,
          ].slice(0, 12),
    }));
  };

  send() {
    const text = this.state.draft.trim();
    if (!text || !this.state.activeThreadId) return;
    if (this.state.mode === 'room') {
      this.scrollBottom();
      this.setState(p => ({
        draft: '',
        roomFeed: [...p.roomFeed.slice(-14), { user: '@you', color: '#e8edf2', text }],
      }));
      return;
    }
    // optimistic append, then confirm through the transport
    this.scrollBottom();
    this.setState(p => ({
      draft: '',
      sendError: '',
      tab: 'messages',
      thread: [...p.thread, { id: `optimistic-${Date.now()}`, from: 'me', text }],
    }));
    this.transport.send(text).catch(err => {
      // roll back the optimistic message, restore the draft for retry
      this.setState(p => ({
        thread: p.thread.slice(0, -1),
        draft: text,
        sendError: err.message + ' — press send to retry.',
      }));
    });
  }

  /* ---------------- render ---------------- */

  render() {
    const s = this.state;
    const unread = s.notifs.filter(n => n.unread).length;
    const messageUnread = s.threads.reduce((sum, thread) => sum + (thread.muted ? 0 : thread.unread), 0);
    const activeThread = s.threads.find(thread => thread.id === s.activeThreadId);
    const activePerson = activeThread?.people?.[0];
    const vh = s.vh || 900;
    const screen = Math.max(110, Math.min(s.slid ? 200 : 250, vh - (s.slid ? 460 : 200)));
    const acc = ACCENT_OPTS.find(a => a.c === s.accent) || ACCENT_OPTS[0];
    const accentGrad = `linear-gradient(140deg,${acc.c},${acc.d})`;
    const bgOf = (key: string) => (BG_OPTS.find(b => b.key === key) || BG_OPTS[0]).bg(acc.c);
    const deviceFont = (FONT_OPTS.find(f => f.key === s.font) || FONT_OPTS[0]).stack;
    const openTo = (tab: State['tab']) => () => { this.scrollBottom(); this.setState({ open: true, slid: true, tab }); };
    const showComposer = (s.mode === 'compose' && s.slid && !!activeThread) || s.mode === 'room';
    const coverVisible = s.mode === 'compose' && !s.slid;
    const callTime = Math.floor(s.callSec / 60) + ':' + String(s.callSec % 60).padStart(2, '0');
    const mono = 'ui-monospace,Menlo,monospace';

    const wm = (size: number, ls: number) => (
      <div style={{ position: 'absolute', inset: 0, display: s.wmOn && s.wmText ? 'flex' : 'none', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', zIndex: 5 }}>
        <span style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: size, letterSpacing: ls, color: 'rgba(255,255,255,.05)', transform: 'rotate(-16deg)', whiteSpace: 'nowrap' }}>{s.wmText}</span>
      </div>
    );

    const callBtn = (label: string, bg: string, fg: string, onClick: () => void, bold = false) => (
      <div onClick={onClick} style={{ width: 34, height: 34, borderRadius: '50%', background: bg, color: fg, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: bold ? 11 : 12, fontWeight: bold ? 700 : undefined, boxShadow: 'inset 0 1px 0 rgba(255,255,255,' + (bold ? '.25' : '.12') + ')' }}>{label}</div>
    );

    return (
      <>
        {/* ---- incoming call banner ---- */}
        {s.incoming && (
          <div style={{ position: 'fixed', top: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 95, width: 320, maxWidth: 'calc(100vw - 24px)', display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', borderRadius: 18, background: 'linear-gradient(160deg,#141c22 0%,#0a0d10 100%)', border: '1px solid #2a333c', boxShadow: '0 22px 50px -12px rgba(0,0,0,.8)', fontFamily: deviceFont, animation: 'msgIn .3s ease' }}>
            <div style={{ width: 42, height: 42, borderRadius: '50%', flex: 'none', background: 'linear-gradient(140deg,#20303c,#101820)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: acc.c, boxShadow: `0 0 0 2px ${acc.c}55` }}>{(s.incoming.peerName || 'L').slice(0, 1).toUpperCase()}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: '#e8edf2', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.incoming.peerName || 'Loop member'}</div>
              <div style={{ fontSize: 10.5, color: acc.c }}>Incoming {s.incoming.video ? 'video' : 'voice'} call…</div>
            </div>
            <button onClick={this.declineIncoming} aria-label="Decline" style={{ width: 34, height: 34, borderRadius: '50%', flex: 'none', border: 'none', cursor: 'pointer', background: 'linear-gradient(140deg,#ff5c7a,#d42a4c)', color: '#fff', fontSize: 15, fontWeight: 700 }}>✕</button>
            <button onClick={this.acceptIncomingCall} aria-label="Accept" style={{ width: 34, height: 34, borderRadius: '50%', flex: 'none', border: 'none', cursor: 'pointer', background: 'linear-gradient(140deg,#00e07a,#009c55)', color: '#06120c', fontSize: 15, fontWeight: 700 }}>{s.incoming.video ? '📹' : '📞'}</button>
          </div>
        )}

        {/* ---- dock ---- */}
        <div ref={this._dockSurface} onClick={() => { this.scrollBottom(); this.setState(p => ({ open: !p.open })); }}
          style={{ position: 'fixed', right: 26, bottom: 26, zIndex: 70, display: s.open ? 'none' : 'flex', alignItems: 'center', gap: 11, padding: '12px 18px 12px 14px', borderRadius: 16, cursor: 'pointer', background: 'linear-gradient(155deg,#161c22 0%,#0a0d10 100%)', border: '1px solid #2a333c', boxShadow: '0 14px 34px rgba(0,0,0,.6)', animation: 'kickPulse 2.6s ease-in-out infinite' }}>
          <div style={{ width: 34, height: 24, borderRadius: 5, background: '#05080a', border: '1px solid #00ff8866', boxShadow: 'inset 0 0 10px #00ff8830', position: 'relative', flex: 'none' }}>
            <span style={{ position: 'absolute', left: 4, right: 4, top: 5, height: 2, borderRadius: 2, background: '#00ff88' }} />
            <span style={{ position: 'absolute', left: 4, right: 12, top: 11, height: 2, borderRadius: 2, background: '#00ff8880' }} />
            <span style={{ position: 'absolute', left: 4, right: 16, top: 17, height: 2, borderRadius: 2, background: '#00ff8850' }} />
          </div>
          <div>
            <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 700, fontSize: 12, letterSpacing: 1.2, color: '#e8edf2' }}>LOOP-KICK</div>
            <div style={{ fontSize: 10.5, color: '#7e8a96' }}>{unread ? unread + ' new' : 'All caught up'}</div>
          </div>
          {unread > 0 && (
            <span style={{ minWidth: 20, height: 20, padding: '0 6px', borderRadius: 999, background: '#ff3b5c', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{unread}</span>
          )}
        </div>

        {/* ---- device ---- */}
        <div style={{ position: 'fixed', right: 30, bottom: 30, zIndex: 80, display: s.open ? 'block' : 'none', maxHeight: 'calc(100vh - 44px)', perspective: 1050, perspectiveOrigin: '72% 40%', ['--acc' as string]: acc.c }}>
          <div className="lk-device3d" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', transform: 'rotateX(7deg) rotateY(-12deg) rotateZ(-0.6deg)', transformStyle: 'preserve-3d', fontFamily: deviceFont, filter: `drop-shadow(0 58px 64px rgba(0,0,0,.72)) drop-shadow(0 16px 22px rgba(0,0,0,.55)) drop-shadow(0 0 46px ${acc.c}26)`, willChange: 'transform' }}>

            {/* ---- top fold ---- */}
            <div style={{ height: s.slid ? screen + 148 : 0, overflow: 'visible', transition: 'height .42s cubic-bezier(.2,.8,.25,1)', display: 'flex', alignItems: 'flex-end' }}>
              <div ref={this._topSurface} style={{ width: 352, position: 'relative', isolation: 'isolate', borderRadius: 34, padding: 3, background: 'linear-gradient(145deg,#aab6c2 0%,#4a545f 16%,#14181d 46%,#0a0d10 58%,#39434e 82%,#7d8a97 100%)', boxShadow: `inset 0 1px 1.5px rgba(255,255,255,.7), inset 0 -1px 2px rgba(0,0,0,.6), 0 0 0 1px rgba(0,0,0,.5), 0 0 34px -6px ${acc.c}3a, 0 46px 90px -34px ${acc.c}30`, zIndex: 2, transformOrigin: 'center bottom', transform: s.slid ? 'rotateX(0deg)' : 'rotateX(-89deg)', opacity: s.slid ? 1 : 0, pointerEvents: s.slid ? 'auto' : 'none', transition: 'transform .42s cubic-bezier(.2,.8,.25,1), opacity .32s ease' }}>
                <div style={{ position: 'absolute', inset: 0, borderRadius: 34, background: 'radial-gradient(130px 95px at 16% 10%, rgba(255,255,255,.5) 0%, rgba(255,255,255,.13) 32%, transparent 60%)', pointerEvents: 'none', zIndex: 3 }} />
                <div style={{ position: 'absolute', right: -3, top: 70, width: 4, height: 52, borderRadius: '0 3px 3px 0', background: acc.c, boxShadow: `1px 0 3px ${acc.c}66` }} />
                <div style={{ position: 'absolute', right: -3, top: 134, width: 4, height: 70, borderRadius: '0 3px 3px 0', background: 'linear-gradient(#39424c,#12161b)' }} />
                <div style={{ position: 'absolute', left: -3, top: 92, width: 4, height: 40, borderRadius: '3px 0 0 3px', background: 'linear-gradient(#39424c,#12161b)' }} />

                <div style={{ borderRadius: 31, background: '#010304', padding: '10px 10px 12px', position: 'relative', overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', inset: 0, borderRadius: 31, background: 'linear-gradient(122deg, rgba(255,255,255,.19) 0%, rgba(255,255,255,.07) 11%, rgba(255,255,255,.015) 20%, transparent 30%, transparent 68%, rgba(255,255,255,.03) 84%, rgba(255,255,255,.12) 100%)', pointerEvents: 'none', zIndex: 6 }} />
                  <div className="lk-sheen" style={{ position: 'absolute', top: -24, bottom: -24, left: 0, width: '34%', pointerEvents: 'none', zIndex: 7, background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,.05) 38%, rgba(255,255,255,.17) 50%, rgba(255,255,255,.05) 62%, transparent 100%)' }} />

                  {/* notch row */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '2px 0 8px', position: 'relative' }}>
                    <span style={{ width: 34, height: 4, borderRadius: 3, background: 'linear-gradient(#1c2229,#0d1116)', boxShadow: 'inset 0 1px 2px rgba(0,0,0,.8)' }} />
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'radial-gradient(circle at 34% 30%, #2c4a63 0%, #0a1017 55%, #000 100%)', boxShadow: 'inset 0 0 2px #000, 0 0 3px rgba(66,135,245,.28)' }} />
                    <div className="lk-x" onClick={() => this.setState({ open: false, slid: false })} style={{ position: 'absolute', right: 2, top: 0, width: 19, height: 19, borderRadius: '50%', color: '#5c6771', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>×</div>
                  </div>

                  {/* top screen */}
                  <div style={{ borderRadius: 18, overflow: 'hidden', background: bgOf(s.topBgKey), position: 'relative', boxShadow: `inset 0 1.5px 0 rgba(255,255,255,.14), inset 0 -1px 1px rgba(0,0,0,.5), inset 0 0 0 1px rgba(255,255,255,.06), inset 0 0 26px -8px ${acc.c}30` }}>
                    {/* screen-on bloom (emissive) + faint environment reflection on the glass */}
                    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4, background: `radial-gradient(135% 78% at 50% 22%, ${acc.c}14 0%, transparent 54%)` }} />
                    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 8, background: 'linear-gradient(178deg, rgba(196,216,238,.08) 0%, rgba(196,216,238,.02) 16%, transparent 40%, transparent 74%, rgba(30,48,74,.06) 100%)' }} />
                    {wm(44, 4)}
                    {/* status bar */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 14px 4px', fontFamily: mono, fontSize: 9, letterSpacing: 0.6, color: '#7e8a96' }}>
                      <span style={{ color: '#e8edf2', fontWeight: 600 }}>7:04</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: '#00ff88' }}>5G</span>
                        <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 1 }}>
                          <span style={{ width: 2, height: 3, background: '#00ff88' }} /><span style={{ width: 2, height: 5, background: '#00ff88' }} /><span style={{ width: 2, height: 7, background: '#00ff88' }} /><span style={{ width: 2, height: 9, background: '#2a333c' }} />
                        </span>
                        <span style={{ width: 17, height: 9, border: '1px solid #3a444e', borderRadius: 3, position: 'relative', display: 'inline-block' }}>
                          <span style={{ position: 'absolute', inset: 1.5, right: 4, background: '#00ff88', borderRadius: 1 }} />
                        </span>
                      </span>
                    </div>

                    {/* tabs */}
                    <div style={{ display: 'flex', gap: 4, margin: '8px 12px 10px', padding: 3, borderRadius: 12, background: 'rgba(14,20,28,.92)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.07), inset 0 0 0 1px rgba(255,255,255,.04)' }}>
                      {([
                        { key: 'messages', label: 'Messages', badge: messageUnread },
                        { key: 'chirp', label: 'Chirp', badge: 0 },
                        { key: 'notifs', label: 'Alerts', badge: unread },
                      ] as { key: State['tab']; label: string; badge: number }[]).map(t => (
                        <div key={t.key} onClick={() => { this.scrollBottom(); this.setState({ tab: t.key }); }}
                          style={{ flex: 1, textAlign: 'center', padding: '7px 0', fontSize: 11, fontWeight: 600, borderRadius: 9, cursor: 'pointer', color: s.tab === t.key ? acc.fg : '#7e8a96', background: s.tab === t.key ? acc.c : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, transition: 'background .18s, color .18s' }}>
                          <span>{t.label}</span>
                          {t.badge > 0 && (
                            <span style={{ minWidth: 15, height: 15, padding: '0 4px', borderRadius: 999, background: '#ff3b5c', color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{t.badge}</span>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* screen content */}
                    <div style={{ height: screen, overflowY: 'auto', padding: '2px 12px 12px', transition: 'height .3s ease' }}>
                      {s.tab === 'messages' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {activeThread ? (
                            <>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 2px 8px', position: 'sticky', top: 0, zIndex: 4, background: '#04090e' }}>
                                <button onClick={() => { this.transport.setActiveThread(0); this.setState({ activeThreadId: 0, thread: [] }); }} aria-label="Back to conversations" style={{ border: 0, background: '#111a23', color: acc.c, width: 25, height: 25, borderRadius: 8, cursor: 'pointer' }}>‹</button>
                                {activePerson?.avatar ? <img src={activePerson.avatar} alt="" style={{ width: 30, height: 30, borderRadius: '50%', objectFit: 'cover' }} /> : <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'linear-gradient(140deg,#20303c,#101820)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: acc.c }}>{(activePerson?.name || activeThread.title || 'M').slice(0, 1)}</div>}
                                <div style={{ minWidth: 0, flex: 1 }}>
                                  <div style={{ fontSize: 12.5, fontWeight: 600, color: '#e8edf2', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{activePerson?.name || activeThread.title || `${activeThread.type} thread`}</div>
                                  <div style={{ fontSize: 9.5, color: activePerson?.presence?.stale ? '#5c6771' : acc.c }}>{activePerson?.presence?.stale ? 'offline' : (activePerson?.presence?.state || activeThread.category)}</div>
                                </div>
                                {(['pinned', 'muted', 'archived'] as const).map(flag => <button key={flag} onClick={() => void this.toggleFlag(flag)} title={`${activeThread[flag] ? 'Remove' : 'Set'} ${flag}`} style={{ border: 0, padding: '4px 5px', borderRadius: 6, cursor: 'pointer', background: activeThread[flag] ? acc.c : '#111a23', color: activeThread[flag] ? acc.fg : '#7e8a96', fontSize: 8 }}>{flag[0].toUpperCase()}</button>)}
                                {activeThread.type === 'dm' && <button onClick={() => void this.clearActiveHistory()} title="Delete private conversation history" style={{ border: 0, padding: '4px 5px', borderRadius: 6, cursor: 'pointer', background: '#241018', color: '#ff5c7a', fontSize: 8 }}>D</button>}
                              </div>
                              {activeThread.state === 'request' && (
                                <div style={{ display: 'flex', gap: 7, padding: '7px', borderRadius: 10, background: '#101820' }}>
                                  <span style={{ flex: 1, color: '#98a3ad', fontSize: 10 }}>Message request</span>
                                  <button onClick={() => void this.transport.respondRequest(activeThread.id, 'accept').then(() => this.refreshSummary())} style={{ border: 0, borderRadius: 6, background: acc.c, color: acc.fg, fontSize: 9, cursor: 'pointer' }}>Accept</button>
                                  <button onClick={() => void this.transport.respondRequest(activeThread.id, 'decline').then(() => { this.setState({ activeThreadId: 0, thread: [] }); void this.refreshSummary(); })} style={{ border: '1px solid #ff5c7a', borderRadius: 6, background: 'transparent', color: '#ff5c7a', fontSize: 9, cursor: 'pointer' }}>Decline</button>
                                </div>
                              )}
                              {s.loading && <div style={{ color: '#7e8a96', fontSize: 10, textAlign: 'center' }}>Loading conversation…</div>}
                              {s.thread.map((m, i) => m.from === 'me' ? (
                                <div key={m.id || i} style={{ display: 'flex', justifyContent: 'flex-end', animation: 'msgIn .2s ease' }}>
                                  <div style={{ maxWidth: '80%', padding: '9px 13px', borderRadius: '17px 17px 5px 17px', fontSize: 12, lineHeight: 1.5, background: accentGrad, color: acc.fg, boxShadow: `0 6px 18px ${acc.c}3d, inset 0 1px 0 rgba(255,255,255,.35)` }}>
                                    {m.media?.map(media => media.mime.startsWith('image/') ? <img key={media.id} src={media.url} alt="Message attachment" style={{ display: 'block', width: '100%', maxHeight: 140, objectFit: 'cover', borderRadius: 8, marginBottom: m.text ? 5 : 0 }} /> : <audio key={media.id} controls src={media.url} style={{ width: 190, maxWidth: '100%' }} />)}
                                    {m.text}
                                  </div>
                                </div>
                              ) : (
                                <div key={m.id || i} style={{ display: 'flex', justifyContent: 'flex-start', animation: 'msgIn .2s ease' }}>
                                  <div style={{ maxWidth: '80%', padding: '9px 13px', borderRadius: '17px 17px 17px 5px', fontSize: 12, lineHeight: 1.5, background: 'rgba(22,30,41,.94)', color: '#dbe4ec', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.07), inset 0 0 0 1px rgba(255,255,255,.04), 0 4px 12px rgba(0,0,0,.4)' }}>
                                    {m.media?.map(media => media.mime.startsWith('image/') ? <img key={media.id} src={media.url} alt="Message attachment" style={{ display: 'block', width: '100%', maxHeight: 140, objectFit: 'cover', borderRadius: 8, marginBottom: m.text ? 5 : 0 }} /> : <audio key={media.id} controls src={media.url} style={{ width: 190, maxWidth: '100%' }} />)}
                                    {m.text}
                                  </div>
                                </div>
                              ))}
                            </>
                          ) : (
                            <>
                              <input value={s.search} onChange={event => this.searchPeople(event.target.value)} placeholder="Search members…" aria-label="Search members" style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #1e2831', borderRadius: 9, padding: '8px 10px', background: '#0a1117', color: '#e8edf2', outline: 'none', fontSize: 11 }} />
                              {(s.searchResults.length ? s.searchResults : s.people.filter(person => !person.presence?.stale).slice(0, 4)).map(person => (
                                <button key={`person-${person.userId}`} onClick={() => void this.openPerson(person)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 0, borderRadius: 10, background: '#0a1117', color: '#e8edf2', padding: '7px 9px', cursor: 'pointer', textAlign: 'left' }}>
                                  {person.avatar ? <img src={person.avatar} alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }} /> : <span style={{ width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center', background: '#17242a', color: acc.c }}>{person.name.slice(0, 1)}</span>}
                                  <span style={{ minWidth: 0, flex: 1 }}><strong style={{ display: 'block', fontSize: 11 }}>{person.name}</strong><small style={{ color: '#7e8a96' }}>@{person.handle}</small></span>
                                  <span style={{ color: person.presence?.stale ? '#4a545e' : acc.c, fontSize: 9 }}>{person.presence?.stale ? '' : '● live'}</span>
                                </button>
                              ))}
                              <div style={{ fontFamily: mono, fontSize: 8, color: '#5c6771', letterSpacing: 1, paddingTop: 3 }}>CONVERSATIONS</div>
                              {s.loading && <div style={{ color: '#7e8a96', fontSize: 10, textAlign: 'center' }}>Loading your inbox…</div>}
                              {s.threads.map(thread => {
                                const person = thread.people?.[0];
                                return <button key={thread.id} onClick={() => void this.openThread(thread)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 0, borderRadius: 11, background: thread.unread ? 'linear-gradient(160deg,#0b1620,#081018)' : '#070d13', color: '#e8edf2', padding: '8px 9px', cursor: 'pointer', textAlign: 'left' }}>
                                  {person?.avatar ? <img src={person.avatar} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }} /> : <span style={{ width: 32, height: 32, borderRadius: '50%', display: 'grid', placeItems: 'center', background: '#17242a', color: acc.c }}>{(person?.name || thread.title || thread.type).slice(0, 1).toUpperCase()}</span>}
                                  <span style={{ minWidth: 0, flex: 1 }}><strong style={{ display: 'block', fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{person?.name || thread.title || `${thread.type} thread`}</strong><small style={{ display: 'block', color: '#7e8a96', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{thread.last_message.preview || thread.category}</small></span>
                                  {thread.unread > 0 && <span style={{ minWidth: 17, height: 17, borderRadius: 10, display: 'grid', placeItems: 'center', background: '#ff3b5c', color: '#fff', fontSize: 8 }}>{thread.unread}</span>}
                                </button>;
                              })}
                              {!s.loading && !s.threads.length && <div style={{ color: '#7e8a96', fontSize: 10, textAlign: 'center', padding: 12 }}>No conversations yet. Choose a friend or search for a member.</div>}
                            </>
                          )}
                          {s.sendError && (
                            <div style={{ fontSize: 10, color: '#ff5c7a', textAlign: 'center', padding: '2px 0' }}>{s.sendError}</div>
                          )}
                        </div>
                      )}

                      {s.tab === 'chirp' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                          <div style={{ color: '#98a3ad', fontSize: 10.5, lineHeight: 1.45 }}>Live push-to-talk with friends. Chirps are not stored as recordings.</div>
                          {s.chirpStatus && <div style={{ padding: 8, borderRadius: 9, color: acc.c, background: '#0a1117', fontSize: 10 }}>{s.chirpStatus}</div>}
                          {s.people.map(person => (
                            <div key={person.userId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px', borderRadius: 11, background: '#0a1117' }}>
                              {person.avatar ? <img src={person.avatar} alt="" style={{ width: 30, height: 30, borderRadius: '50%', objectFit: 'cover' }} /> : <span style={{ width: 30, height: 30, borderRadius: '50%', display: 'grid', placeItems: 'center', background: '#17242a', color: acc.c }}>{person.name.slice(0, 1)}</span>}
                              <span style={{ flex: 1, minWidth: 0 }}><strong style={{ display: 'block', color: '#e8edf2', fontSize: 11 }}>{person.name}</strong><small style={{ color: person.presence?.stale ? '#5c6771' : acc.c }}>{person.presence?.stale ? 'offline' : (person.presence?.state || 'online')}</small></span>
                              <button disabled={!person.chirpEnabled}
                                onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId); void this.chirp.begin(person.userId); }}
                                onPointerUp={event => { event.preventDefault(); this.chirp.end(); }}
                                onPointerCancel={() => this.chirp.end()}
                                onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); event.stopPropagation(); void this.chirp.begin(person.userId); } }}
                                onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); this.chirp.end(); } }}
                                onClick={event => event.preventDefault()} title={person.chirpReason || 'Hold to talk live'} aria-label={`Hold to Chirp ${person.name}`}
                                style={{ border: 0, borderRadius: 8, padding: '7px 9px', background: person.chirpEnabled ? '#3d8bfd' : '#17242a', color: person.chirpEnabled ? '#fff' : '#66787f', cursor: person.chirpEnabled ? 'pointer' : 'not-allowed', fontSize: 9, touchAction: 'none' }}>Hold Chirp</button>
                            </div>
                          ))}
                          {!s.people.length && CHIRPS.slice(0, 1).map(c => <div key={c.user} style={{ color: '#7e8a96', fontSize: 10 }}>Your mutual friends will appear here when Chirp is enabled.</div>)}
                        </div>
                      )}

                      {s.tab === 'notifs' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {s.notifs.map((n, i) => (
                            <div key={n.id || i} onClick={() => void this.markNotification(n)}
                              style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 13, cursor: 'pointer', background: n.unread ? 'linear-gradient(160deg,#0b1620 0%,#081018 100%)' : '#070d13', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.04)' }}>
                              <div style={{ width: 26, height: 26, borderRadius: 8, flex: 'none', background: n.tint, boxShadow: 'inset 0 1px 0 rgba(255,255,255,.25)' }} />
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 11.5, fontWeight: 600, color: '#e8edf2', marginBottom: 2 }}>{n.title}</div>
                                <div style={{ fontSize: 11, color: '#7e8a96', lineHeight: 1.45 }}>{n.text}</div>
                              </div>
                              <div style={{ fontFamily: mono, fontSize: 8.5, color: '#4a545e', marginLeft: 'auto', flex: 'none' }}>{n.time}</div>
                            </div>
                          ))}
                          {!s.notifs.length && <div style={{ color: '#7e8a96', fontSize: 10, textAlign: 'center', padding: 14 }}>No site alerts. You’re all caught up.</div>}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ---- hinge ---- */}
            <div style={{ width: 314, height: s.slid ? 10 : 0, overflow: 'visible', position: 'relative', zIndex: 1, transition: 'height .3s ease' }}>
              <div style={{ position: 'absolute', left: '50%', top: -2, transform: 'translateX(-50%)', width: 120, height: 8, borderRadius: '0 0 6px 6px', background: 'linear-gradient(#252c34,#0c0f13)', boxShadow: 'inset 0 -1px 0 rgba(255,255,255,.07)' }} />
            </div>

            {/* ---- deck ---- */}
            <div ref={this._bottomSurface} style={{ width: 330, transformOrigin: 'top center', transform: 'rotateX(0deg)', opacity: 1, transition: 'transform .42s cubic-bezier(.2,.8,.25,1), opacity .3s ease', borderRadius: 26, padding: 3, background: 'linear-gradient(210deg,#4c555f 0%,#1b2127 25%,#0b0e12 55%,#2c343d 100%)', boxShadow: 'inset 0 1px 1px rgba(255,255,255,.28)', pointerEvents: 'auto' }}>
              <div style={{ borderRadius: 23, background: '#010304', padding: 10, position: 'relative', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', inset: 0, borderRadius: 23, background: 'linear-gradient(295deg, rgba(255,255,255,.07) 0%, transparent 30%, transparent 72%, rgba(255,255,255,.04) 100%)', pointerEvents: 'none', zIndex: 6 }} />

                <div style={{ borderRadius: 15, background: bgOf(s.deckBgKey), position: 'relative', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.045)', padding: 12, display: 'flex', flexDirection: 'column', gap: 11 }}>
                  {wm(34, 3)}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

                    {/* modes + fold toggle */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ flex: 1, display: 'flex', gap: 4, padding: 3, borderRadius: 11, background: '#0a1117' }}>
                        {([
                          { key: 'compose', label: 'Reply' },
                          { key: 'watch', label: 'Watch' },
                          { key: 'room', label: 'Room' },
                          { key: 'video', label: 'Video' },
                          { key: 'voice', label: 'Voice' },
                          { key: 'style', label: 'Style' },
                        ] as { key: State['mode']; label: string }[]).map(mo => (
                          <button key={mo.key}
                            onClick={() => {
                              this.scrollBottom();
                              if (mo.key === 'video' || mo.key === 'voice') {
                                if (!this.call.busy) this.startCall(mo.key === 'video');
                                else this.setState({ mode: mo.key });
                                return;
                              }
                              this.setState({ mode: mo.key } as Pick<State, 'mode'>);
                            }}
                            style={{ flex: 1, padding: '6px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 9.5, fontWeight: 600, letterSpacing: 0.3, background: s.mode === mo.key ? acc.c : 'transparent', color: s.mode === mo.key ? acc.fg : '#7e8a96', whiteSpace: 'nowrap', transition: 'background .18s, color .18s' }}>{mo.label}</button>
                        ))}
                      </div>
                      <button onClick={() => { this.scrollBottom(); this.setState(p => ({ slid: !p.slid })); }} title="Fold / unfold top screen"
                        style={{ width: 30, height: 30, borderRadius: 9, border: 'none', cursor: 'pointer', background: '#0a1117', color: acc.c, fontSize: 11, flex: 'none' }}>{s.slid ? '▾' : '▴'}</button>
                    </div>

                    {/* composer */}
                    {showComposer && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        {s.mode === 'compose' && <>
                          <input ref={this._fileInput} type="file" accept="image/jpeg,image/png,image/gif,image/webp,audio/mpeg,audio/mp4,audio/ogg,audio/webm" onChange={event => void this.uploadFile(event)} style={{ display: 'none' }} />
                          <button onClick={this.chooseFile} disabled={s.uploading} title="Attach an image or audio file" style={{ width: 32, height: 32, borderRadius: 10, border: '1px solid #1e2831', background: '#0a1117', color: s.uploading ? '#5c6771' : acc.c, cursor: s.uploading ? 'wait' : 'pointer', flex: 'none' }}>{s.uploading ? '…' : '+'}</button>
                        </>}
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 2, padding: '10px 13px', borderRadius: 13, background: '#0a1117', boxShadow: 'inset 0 1px 3px rgba(0,0,0,.6)' }}>
                          <span style={{ fontSize: 12, color: s.draft ? '#e8edf2' : '#4a545e', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {s.draft ? s.draft : (s.mode === 'room' ? 'Say something in the room…' : 'Type a message…')}
                          </span>
                          <span style={{ width: 1.5, height: 14, background: acc.c, flex: 'none', animation: 'caretBlink 1.1s infinite' }} />
                        </div>
                        <div className="lk-send" onClick={() => this.send()} style={{ width: 40, height: 40, borderRadius: '50%', flex: 'none', cursor: 'pointer', background: accentGrad, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 4px 12px ${acc.c}44, inset 0 1px 0 rgba(255,255,255,.4)` }}>
                          <span style={{ width: 0, height: 0, borderLeft: `11px solid ${acc.fg}`, borderTop: '6.5px solid transparent', borderBottom: '6.5px solid transparent', marginLeft: 3 }} />
                        </div>
                      </div>
                    )}

                    {/* room */}
                    {s.mode === 'room' && (
                      <div style={{ borderRadius: 13, background: '#0a1117', boxShadow: 'inset 0 1px 3px rgba(0,0,0,.5)', overflow: 'hidden' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 11px', borderBottom: '1px solid #0f1720' }}>
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: acc.c, boxShadow: `0 0 6px ${acc.c}` }} />
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#e8edf2' }}>$MRAM Squeeze Room</span>
                          <span style={{ fontFamily: mono, fontSize: 9, color: '#5c6771', marginLeft: 'auto' }}>{s.roomCount} in room</span>
                        </div>
                        <div style={{ height: 104, overflowY: 'auto', padding: '8px 11px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {s.roomFeed.map((r, i) => (
                            <div key={i} style={{ fontSize: 10.5, lineHeight: 1.45, animation: 'msgIn .2s ease' }}>
                              <span style={{ color: r.color, fontWeight: 600 }}>{r.user}</span> <span style={{ color: '#98a3ad' }}>{r.text}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* watch */}
                    {s.mode === 'watch' && (
                      <div style={{ borderRadius: 13, overflow: 'hidden', background: '#0a1117', boxShadow: 'inset 0 1px 3px rgba(0,0,0,.5)' }}>
                        <div style={{ height: 118, position: 'relative', background: 'repeating-linear-gradient(135deg,#0d141b 0 12px,#090f15 12px 24px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <div className="lk-play" onClick={() => this.setState(p => ({ playing: !p.playing }))} style={{ width: 42, height: 42, borderRadius: '50%', background: 'rgba(0,0,0,.55)', border: `1px solid ${acc.c}88`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                            {s.playing ? (
                              <span style={{ display: 'flex', gap: 3 }}><span style={{ width: 4, height: 14, background: acc.c }} /><span style={{ width: 4, height: 14, background: acc.c }} /></span>
                            ) : (
                              <span style={{ width: 0, height: 0, borderLeft: `13px solid ${acc.c}`, borderTop: '8px solid transparent', borderBottom: '8px solid transparent', marginLeft: 3 }} />
                            )}
                          </div>
                          <span style={{ position: 'absolute', top: 7, left: 8, display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 6, background: 'rgba(0,0,0,.6)', fontFamily: mono, fontSize: 8.5, letterSpacing: 1, color: '#ff5c7a' }}>
                            <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#ff3b5c' }} />LIVE
                          </span>
                          <span style={{ position: 'absolute', top: 7, right: 8, padding: '3px 8px', borderRadius: 6, background: 'rgba(0,0,0,.6)', fontFamily: mono, fontSize: 8.5, color: '#98a3ad' }}>{s.viewers.toLocaleString()} watching</span>
                          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, background: '#0f1720' }}>
                            <div style={{ height: '100%', width: Math.min(100, (s.watchSec % 180) / 1.8) + '%', background: acc.c, transition: 'width 1s linear' }} />
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px' }}>
                          <div style={{ width: 22, height: 22, borderRadius: 7, flex: 'none', background: 'linear-gradient(140deg,#b98cff,#8a55e0)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.25)' }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#e8edf2', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Market Open — Loop Live Desk</div>
                            <div style={{ fontSize: 9.5, color: '#5c6771' }}>Streaming from Loop Hub</div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* video call — real getUserMedia + WebRTC */}
                    {s.mode === 'video' && (
                      <div style={{ borderRadius: 13, overflow: 'hidden', position: 'relative', background: '#05090d', boxShadow: 'inset 0 1px 3px rgba(0,0,0,.5)' }}>
                        <div style={{ position: 'relative', height: 168, background: 'radial-gradient(320px 160px at 50% 32%, #14222e 0%, #05090d 78%)' }}>
                          <video ref={el => { this._remoteEl = el; this.attachStream(el, this._remoteStream, false); }} autoPlay playsInline
                            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: s.callPhase === 'connected' ? 1 : 0, transition: 'opacity .3s' }} />
                          {s.callPhase !== 'connected' && (
                            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7, padding: 12, textAlign: 'center' }}>
                              <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'linear-gradient(140deg,#20303c,#101820)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 700, color: acc.c, boxShadow: `0 0 0 2px ${acc.c}40` }}>{(s.callPeerName || PEER_NAME).slice(0, 1).toUpperCase()}</div>
                              <div style={{ fontSize: 11.5, fontWeight: 600, color: '#e8edf2' }}>{s.callPeerName || PEER_NAME}</div>
                              <div style={{ fontFamily: mono, fontSize: 9.5, color: s.callError ? '#ff5c7a' : acc.c }}>{s.callError || (s.callPhase === 'calling' ? 'Calling…' : s.callPhase === 'connecting' ? 'Connecting…' : s.callPhase === 'ended' ? 'Call ended' : 'Starting…')}</div>
                            </div>
                          )}
                          {s.callPhase === 'connected' && (
                            <div style={{ position: 'absolute', left: 10, top: 8, display: 'flex', alignItems: 'center', gap: 6, padding: '3px 9px', borderRadius: 999, background: 'rgba(5,9,13,.6)' }}>
                              <span style={{ fontSize: 10.5, fontWeight: 600, color: '#e8edf2' }}>{s.callPeerName || PEER_NAME}</span>
                              <span style={{ fontFamily: mono, fontSize: 9, color: acc.c }}>{callTime}</span>
                            </div>
                          )}
                          <video ref={el => { this._localEl = el; this.attachStream(el, this._localStream, true); }} autoPlay playsInline muted
                            style={{ position: 'absolute', right: 8, bottom: 8, width: 58, height: 82, borderRadius: 9, objectFit: 'cover', background: '#0b1218', border: '1px solid #1e2831', transform: 'scaleX(-1)', display: s.camOff ? 'none' : 'block' }} />
                          {s.camOff && <div style={{ position: 'absolute', right: 8, bottom: 8, width: 58, height: 82, borderRadius: 9, background: '#0b1218', border: '1px solid #1e2831', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: mono, fontSize: 7, color: '#4a545e' }}>CAM OFF</div>}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, padding: '9px 0 10px' }}>
                          {callBtn('M', s.muted ? '#ff5c7a' : '#131d26', s.muted ? '#fff' : '#98a3ad', this.toggleMute)}
                          {callBtn('V', s.camOff ? '#ff5c7a' : '#131d26', s.camOff ? '#fff' : '#98a3ad', this.toggleCam)}
                          {callBtn('✕', 'linear-gradient(140deg,#ff5c7a,#d42a4c)', '#fff', this.endCall, true)}
                        </div>
                      </div>
                    )}

                    {/* voice call — real getUserMedia + WebRTC (audio) */}
                    {s.mode === 'voice' && (
                      <div style={{ borderRadius: 13, overflow: 'hidden', background: '#0a1117', boxShadow: 'inset 0 1px 3px rgba(0,0,0,.5)', padding: '14px 12px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9 }}>
                        <video ref={el => { this._remoteEl = el; this.attachStream(el, this._remoteStream, false); }} autoPlay playsInline style={{ display: 'none' }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%' }}>
                          <div style={{ width: 40, height: 40, borderRadius: '50%', flex: 'none', background: 'linear-gradient(140deg,#20303c,#101820)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, color: acc.c, boxShadow: `0 0 0 2px ${acc.c}40` }}>{(s.callPeerName || PEER_NAME).slice(0, 1).toUpperCase()}</div>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: '#e8edf2' }}>{s.callPeerName || PEER_NAME}</div>
                            <div style={{ fontFamily: mono, fontSize: 9.5, color: s.callError ? '#ff5c7a' : acc.c }}>{s.callError || (s.callPhase === 'connected' ? `Voice · ${callTime}` : s.callPhase === 'calling' ? 'Calling…' : s.callPhase === 'connecting' ? 'Connecting…' : s.callPhase === 'ended' ? 'Call ended' : 'Voice')}</div>
                          </div>
                          {s.callPhase === 'connected' && (
                            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'flex-end', gap: 2.5, height: 22 }}>
                              {[8, 16, 11, 19, 9].map((h, i) => (
                                <span key={i} style={{ width: 3, height: h, borderRadius: 2, background: acc.c, animation: `wave .9s ease-in-out ${i * 0.15}s infinite` }} />
                              ))}
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, paddingTop: 2 }}>
                          {callBtn('M', s.muted ? '#ff5c7a' : '#131d26', s.muted ? '#fff' : '#98a3ad', this.toggleMute)}
                          {callBtn('S', s.speaker ? acc.c : '#131d26', s.speaker ? acc.fg : '#98a3ad', () => this.setState(p => ({ speaker: !p.speaker })))}
                          {callBtn('✕', 'linear-gradient(140deg,#ff5c7a,#d42a4c)', '#fff', this.endCall, true)}
                        </div>
                      </div>
                    )}

                    {/* compose extras: quick replies + apps */}
                    {s.mode === 'compose' && s.slid && (
                      <>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                          {QUICK.map((text, i) => (
                            <button key={i} className="lk-quick" onClick={() => this.setState({ draft: text })}
                              style={{ padding: '8px 13px', borderRadius: 999, border: 'none', cursor: 'pointer', background: '#0e161d', color: '#c3ccd4', fontSize: 11, whiteSpace: 'nowrap', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)' }}>{text}</button>
                          ))}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 6px 0' }}>
                          {([
                            { key: 'messages', label: 'Messages', glyph: 'M', bg: 'linear-gradient(140deg,#00e07a,#009c55)', fg: '#06120c' },
                            { key: 'chirp', label: 'Chirp', glyph: 'C', bg: 'linear-gradient(140deg,#3d8bfd,#1f5fd0)', fg: '#fff' },
                            { key: 'notifs', label: 'Alerts', glyph: 'A', bg: 'linear-gradient(140deg,#ff5c7a,#d42a4c)', fg: '#fff' },
                            { key: 'live', label: 'Live', glyph: 'L', bg: 'linear-gradient(140deg,#b98cff,#8a55e0)', fg: '#fff' },
                          ]).map(a => (
                            <div key={a.key} onClick={() => this.setState({ tab: (a.key === 'live' ? 'chirp' : a.key) as State['tab'] })}
                              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, cursor: 'pointer', width: 56 }}>
                              <div style={{ width: 40, height: 40, borderRadius: 13, background: a.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.22), 0 3px 8px rgba(0,0,0,.4)', fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 15, color: a.fg }}>{a.glyph}</div>
                              <span style={{ fontSize: 9, color: s.tab === a.key ? '#00ff88' : '#5c6771' }}>{a.label}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    {/* style panel */}
                    {s.mode === 'style' && (
                      <div style={{ borderRadius: 13, background: '#0a1117', boxShadow: 'inset 0 1px 3px rgba(0,0,0,.5)', padding: 12, display: 'flex', flexDirection: 'column', gap: 11, maxHeight: 196, overflowY: 'auto' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ width: 76, flex: 'none', fontFamily: mono, fontSize: 8, letterSpacing: 1.2, color: '#5c6771' }}>ACCENT</span>
                          {ACCENT_OPTS.map(o => (
                            <button key={o.c} onClick={() => this.setState({ accent: o.c })}
                              style={{ width: 22, height: 22, borderRadius: '50%', cursor: 'pointer', background: o.c, border: `2px solid ${o.c === acc.c ? '#ffffff' : 'transparent'}` }} />
                          ))}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ width: 76, flex: 'none', fontFamily: mono, fontSize: 8, letterSpacing: 1.2, color: '#5c6771' }}>FONT</span>
                          {FONT_OPTS.map(f => (
                            <button key={f.key} onClick={() => this.setState({ font: f.key })}
                              style={{ flex: 1, padding: '6px 0', borderRadius: 8, cursor: 'pointer', background: f.key === s.font ? '#131d26' : '#04090e', border: `1px solid ${f.key === s.font ? acc.c : '#1e2831'}`, color: f.key === s.font ? '#e8edf2' : '#7e8a96', fontFamily: f.stack, fontSize: 10.5, whiteSpace: 'nowrap' }}>{f.label}</button>
                          ))}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ width: 76, flex: 'none', fontFamily: mono, fontSize: 8, letterSpacing: 1.2, color: '#5c6771' }}>TOP SCREEN</span>
                          {BG_OPTS.map(b => (
                            <button key={b.key} onClick={() => this.setState({ topBgKey: b.key })} title={b.label}
                              style={{ flex: 1, height: 24, borderRadius: 7, cursor: 'pointer', background: b.bg(acc.c), border: `1.5px solid ${b.key === s.topBgKey ? acc.c : '#1e2831'}` }} />
                          ))}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ width: 76, flex: 'none', fontFamily: mono, fontSize: 8, letterSpacing: 1.2, color: '#5c6771' }}>LOWER SCREEN</span>
                          {BG_OPTS.map(b => (
                            <button key={b.key} onClick={() => this.setState({ deckBgKey: b.key })} title={b.label}
                              style={{ flex: 1, height: 24, borderRadius: 7, cursor: 'pointer', background: b.bg(acc.c), border: `1.5px solid ${b.key === s.deckBgKey ? acc.c : '#1e2831'}` }} />
                          ))}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ width: 76, flex: 'none', fontFamily: mono, fontSize: 8, letterSpacing: 1.2, color: '#5c6771' }}>WATERMARK</span>
                          <input value={s.wmText} onChange={e => this.setState({ wmText: e.target.value })} maxLength={12}
                            style={{ flex: 1, minWidth: 0, background: '#04090e', border: '1px solid #1e2831', borderRadius: 7, padding: '6px 9px', color: '#e8edf2', fontSize: 11, outline: 'none' }} />
                          <span onClick={() => this.setState(p => ({ wmOn: !p.wmOn }))}
                            style={{ width: 32, height: 18, borderRadius: 999, position: 'relative', cursor: 'pointer', background: s.wmOn ? acc.c : '#242c34', flex: 'none', transition: 'background .18s' }}>
                            <span style={{ position: 'absolute', top: 2, left: s.wmOn ? 16 : 2, width: 14, height: 14, borderRadius: '50%', background: '#fff', transition: 'left .18s' }} />
                          </span>
                        </div>
                        <div style={{ height: 1, background: '#17212a' }} />
                        {([
                          ['read_receipts', 'READ RECEIPTS'],
                          ['typing_indicator', 'TYPING STATUS'],
                          ['allow_requests', 'MESSAGE REQUESTS'],
                        ] as const).map(([key, label]) => (
                          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ flex: 1, fontFamily: mono, fontSize: 8, letterSpacing: 1.1, color: '#7e8a96' }}>{label}</span>
                            <button onClick={() => void this.togglePreference(key)} style={{ width: 34, height: 19, padding: 2, border: 0, borderRadius: 10, cursor: 'pointer', background: s.preferences[key] ? acc.c : '#242c34' }}><span style={{ display: 'block', width: 15, height: 15, borderRadius: '50%', background: '#fff', transform: `translateX(${s.preferences[key] ? 15 : 0}px)`, transition: 'transform .18s' }} /></button>
                          </div>
                        ))}
                        {([
                          ['chirp_enabled', 'CHIRP ENABLED'],
                          ['dnd', 'CHIRP DO NOT DISTURB'],
                        ] as const).map(([key, label]) => (
                          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ flex: 1, fontFamily: mono, fontSize: 8, letterSpacing: 1.1, color: '#7e8a96' }}>{label}</span>
                            <button onClick={() => void this.toggleChirpPreference(key)} style={{ width: 34, height: 19, padding: 2, border: 0, borderRadius: 10, cursor: 'pointer', background: s.chirpPrefs[key] ? acc.c : '#242c34' }}><span style={{ display: 'block', width: 15, height: 15, borderRadius: '50%', background: '#fff', transform: `translateX(${s.chirpPrefs[key] ? 15 : 0}px)`, transition: 'transform .18s' }} /></button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* folded cover */}
                    {coverVisible && (
                      <div onClick={() => { this.scrollBottom(); this.setState(p => ({ slid: !p.slid })); }} style={{ display: 'flex', flexDirection: 'column', gap: 8, cursor: 'pointer' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1px 2px' }}>
                          <span style={{ fontFamily: "'Archivo',sans-serif", fontSize: 9, letterSpacing: 2, color: '#4a545e' }}>LOOP-KICK</span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontFamily: mono, fontSize: 10, color: '#e8edf2', fontWeight: 600 }}>7:04</span>
                            <span className="lk-x" onClick={e => { e.stopPropagation(); this.setState({ open: false, slid: false }); }}
                              style={{ width: 17, height: 17, borderRadius: '50%', color: '#5c6771', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>×</span>
                          </span>
                        </div>
                        {s.notifs.slice(0, 3).map((n, i) => (
                          <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'center', padding: '8px 10px', borderRadius: 11, background: 'linear-gradient(160deg,#0b1620 0%,#081018 100%)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.05)' }}>
                            <div style={{ width: 22, height: 22, borderRadius: 7, flex: 'none', background: n.tint, boxShadow: 'inset 0 1px 0 rgba(255,255,255,.25)' }} />
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontSize: 11, fontWeight: 600, color: '#e8edf2', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.title}</div>
                              <div style={{ fontSize: 10, color: '#7e8a96', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.text}</div>
                            </div>
                            <div style={{ fontFamily: mono, fontSize: 8.5, color: '#4a545e', flex: 'none' }}>{n.time}</div>
                          </div>
                        ))}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, paddingTop: 2, fontFamily: mono, fontSize: 8, letterSpacing: 1.5, color: acc.c }}>TAP TO UNFOLD ▴</div>
                      </div>
                    )}
                  </div>
                </div>

                {/* grab bar */}
                <div style={{ display: 'flex', justifyContent: 'center', padding: '9px 0 2px' }}>
                  <div className="lk-grab" onClick={() => { this.scrollBottom(); this.setState(p => ({ slid: !p.slid })); }}
                    style={{ width: 96, height: 4, borderRadius: 3, background: '#2a333c', cursor: 'pointer' }} />
                </div>
              </div>
            </div>

          </div>
        </div>
      </>
    );
  }

  /** For the hero page buttons. */
  openTo(tab: State['tab']) {
    this.scrollBottom();
    this.setState({ open: true, slid: true, tab });
  }
}
