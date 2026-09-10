/**
 * LOOP-KICK phone — faithful React port of `Loop Kick Phone.dc.html`,
 * wired into the message system via src/transport.ts.
 *
 * The original design's DCLogic class maps almost 1:1 onto a React class
 * component; state keys, mode names, and style values are kept verbatim so
 * the rendered device matches the approved design.
 */
import React from 'react';
import { BootstrapData, createTransport, fetchWatch, FeedPost, GroupChirp, KickGroup, Person, SiteNotification, ThreadSummary, Transport, WatchData, WatchItem, WireMessage } from './transport';
import { LiveChirpClient } from './liveChirp';
import { CallClient, offerIsCall } from './call';
import { TickerRoomClient, RoomInfo, TickerRoomPhase } from './tickerRoom';
import { ChirpLiveListener, LiveRoomState } from './chirpLive';

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
/* the stored sentence starts with the member's name OR the handle it was written
   with — either way the row's title already says who, so drop that lead */
function stripLead(message: string, leads: Array<string | undefined>): string {
  const m = String(message || '');
  for (const lead of leads) {
    if (lead && m.toLowerCase().startsWith(String(lead).toLowerCase())) return m.slice(String(lead).length).replace(/^[\s:,-]+/, '');
  }
  return m;
}
const WM_LOGO = '/loop-mark.png';
/* Fast open (owner call 2026-09-06). The bridge warms this frame with ?prewarm=1 before the
   member clicks: we load the shell and paint the last bootstrap snapshot, but touch WordPress
   only once the parent says the popup opened; closing it pauses polling. */
const PREWARM = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('prewarm') === '1';
function snapKey() {
  const tok = String((typeof window !== 'undefined' && window.LOOP_KICK_CONFIG?.sessionToken) || '');
  let h = 5381; for (let i = 0; i < tok.length; i++) h = ((h << 5) + h + tok.charCodeAt(i)) | 0;
  return 'lk:boot:' + (h >>> 0).toString(36);
}
function readSnapshot(): BootstrapData | null {
  try {
    const raw = localStorage.getItem(snapKey()); if (!raw) return null;
    const snap = JSON.parse(raw); if (!snap || !snap.at || Date.now() - snap.at > 86400000 || !snap.data) return null;
    return { identity: { userId: '', wpUserId: 0 }, incoming: { incoming: [], missed: [] }, ...snap.data } as BootstrapData;
  } catch { return null; }
}
function writeSnapshot(data: BootstrapData) {
  try {
    const { threads, people, notifications, preferences, chirp } = data;
    localStorage.setItem(snapKey(), JSON.stringify({ at: Date.now(), data: { threads, people, notifications, preferences, chirp } }));
  } catch { /* storage unavailable: nothing to cache */ }
}   // the Stock Market Loop mark — the screens' watermark (owner call 2026-09-06)
const PEER_NAME = typeof window !== 'undefined' ? (window.LOOP_KICK_CONFIG?.peerName || 'Loop') : 'Loop';

const CUSTOM_EMOJIS: Record<string, string> = {
  free_green: '/emojis/free-green.png',
  free_red: '/emojis/free-red.png',
};

function customEmojiText(text: string): React.ReactNode[] {
  return String(text || '').split(/(:(?:free_green|free_red):)/g).map((part, index) => {
    const match = /^:(free_green|free_red):$/.exec(part);
    if (!match) return <React.Fragment key={`text-${index}`}>{part}</React.Fragment>;
    return <img key={`emoji-${index}`} src={CUSTOM_EMOJIS[match[1]]} alt={part} title={part}
      loading="lazy" decoding="async"
      style={{ display: 'inline-block', width: '2em', height: '2em', margin: '-.35em .12em', objectFit: 'contain', verticalAlign: 'middle' }} />;
  });
}

/* hls.js on demand: live streams are HLS and only Safari plays .m3u8 natively. Same CDN the watch page uses. */
let hlsPromise: Promise<any> | null = null;
function loadHls(): Promise<any> {
  const w = window as any;
  if (w.Hls) return Promise.resolve(w.Hls);
  if (!hlsPromise) hlsPromise = new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
    sc.onload = () => resolve(w.Hls || null);
    sc.onerror = () => { hlsPromise = null; reject(new Error('hls.js failed to load')); };
    document.head.appendChild(sc);
  });
  return hlsPromise;
}

/* ---------------- types ---------------- */

interface ThreadMsg { id: string; from: 'me' | 'them'; text: string; media?: { id: number; mime: string; url: string }[]; ts?: number; }

/* when a message was sent: time today, 'Yesterday 3:42 PM', else 'Sep 6 3:42 PM' (owner call 2026-09-07) */
function fmtTs(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts); if (isNaN(d.getTime())) return '';
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday ' + time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
}
interface Notif { id: string; title: string; text: string; time: string; tint: string; unread: boolean; link?: string; category?: string; type?: string; actor?: SiteNotification['actor']; canFollowBack?: boolean; following?: boolean; }
interface RoomMsg { user: string; color: string; text: string; }

interface State {
  open: boolean;
  slid: boolean;
  tab: 'messages' | 'chirp' | 'notifs' | 'friends' | 'groups';
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
  tr: { phase: TickerRoomPhase; symbol: string; room: RoomInfo | null; error: string; mode: 'speaker' | 'listener'; muted: boolean; speaking: boolean; level: number };
  trInput: string;
  watchData: WatchData | null;
  watchItem: WatchItem | null;   /* what the deck is playing (a Loop Channel video or a live stream) */
  watchQ: string;                /* the search box */
  watchStart: number;            /* resume offset handed over by a watch page */
  watchNeedTap: boolean;         /* autoplay had to stay muted: show 'tap for sound' */
  deckH: number;                 /* measured height of the bottom deck: the top screen yields so the phone never leaves the frame */
  fit: number;                   /* last resort: the whole device scales down (bottom-right anchored) when its measured height exceeds the frame */
  typingNames: string[];         /* who is typing in the open conversation right now */
  callMenu: boolean;             /* the Call button's Voice / Video / Chirp choices */
  post: FeedPost | null;         /* a feed post opened from an alert, shown inside the phone */
  postItem: string;              /* which item is loading / open */
  postBusy: string;              /* 'load' | 'like' | 'comment' | 'share' | '' */
  postReply: string;             /* the reply being written */
  postNote: string;              /* short feedback line (e.g. 'Link copied') */
  /* Groups tab (owner call 2026-09-10): per-channel group alerts into this phone + group Chirp */
  groups: KickGroup[];
  groupsLoaded: boolean;
  groupsBusy: string;            /* '<gid>:<cid>:<field>' while a toggle saves, 'rec:<gid>' recording, 'send:<gid>' uploading, 'perm:<gid>' saving who may Chirp */
  groupsNote: string;
  groupsErr: string;
  gkRecSec: number;
  gkPlaying: GroupChirp | null;  /* the group chirp playing now (or waiting for a tap when autoplay was refused) */
  gkNeedTap: boolean;
  gkLive: LiveRoomState[];        /* live rooms this phone listens in (one per group with Chirp on) */
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
    wmText: '',
    draft: '',
    playing: true,
    watchSec: 47,
    viewers: 1284,
    watchData: null,
    watchItem: null,
    watchQ: '',
    watchStart: 0,
    watchNeedTap: false,
    deckH: 0,
    fit: 1,
    typingNames: [],
    callMenu: false,
    post: null,
    postItem: '',
    postBusy: '',
    postReply: '',
    postNote: '',
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
    groups: [], groupsLoaded: false, groupsBusy: '', groupsNote: '', groupsErr: '', gkRecSec: 0, gkPlaying: null, gkNeedTap: false, gkLive: [],
    preferences: {},
    chirpPrefs: {},
    chirpStatus: '',
    callPhase: 'idle',
    callVideo: false,
    callPeerId: 0,
    callPeerName: '',
    callError: '',
    incoming: null,
    tr: { phase: 'idle', symbol: '', room: null, error: '', mode: 'listener', muted: true, speaking: false, level: 0 },
    trInput: '',
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
  private tickerRoom = new TickerRoomClient(this.transport, { onUpdate: tr => this.setState({ tr }) }, 0);
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
      this.setState(p => ({ draft: (p.draft + e.key).slice(0, 4000) }));
    }
  };
  private _resize = () => { this.setState({ vh: window.innerHeight }); this.measureDeck(); };

  /** Owner call 2026-09-09: the page's LOOP-KICK button must react the instant alerts change (Clear all → 0), not on its
   *  next poll. Post the Alerts-tab unread count to the host page whenever the list changes. */
  private publishNotifCount = () => {
    if (window.parent === window) return;
    let targetOrigin = '*';
    try { if (document.referrer) targetOrigin = new URL(document.referrer).origin; } catch { targetOrigin = '*'; }
    const unread = this.state.notifs.filter(n => n.unread).length;
    try { window.parent.postMessage({ type: 'sml-loop-kick:notifications', version: 1, unread, total: this.state.notifs.length }, targetOrigin); } catch { /* host not listening */ }
  };

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
    if (previousState.draft !== this.state.draft && this._composer) this.growComposer(this._composer);
    if (previousState.notifs !== this.state.notifs) this.publishNotifCount();
    if (previousState.draft !== this.state.draft) this.noteTyping();
    this.measureDeck();
    this.fitDevice();
    if (
      previousState.open !== this.state.open
      || previousState.slid !== this.state.slid
      || previousState.vh !== this.state.vh
      // Mode/call/room changes resize the device (e.g. Video call grows it tall) —
      // re-report the surface so the bridge resizes the iframe and nothing clips.
      || previousState.mode !== this.state.mode
      || previousState.callPhase !== this.state.callPhase
      || previousState.tr.phase !== this.state.tr.phase
      || (previousState.tr.room ? previousState.tr.room.count : -1) !== (this.state.tr.room ? this.state.tr.room.count : -1)
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
    window.addEventListener('message', this._onParentMessage);
    window.addEventListener('pointerdown', this.gkUnlock, true);
    /* any content change inside the device (a growing composer, an image finishing its load, a longer thread) re-checks the fit */
    if (typeof ResizeObserver !== 'undefined' && this._device.current) { this._deviceObserver = new ResizeObserver(() => this.fitDevice()); this._deviceObserver.observe(this._device.current); }
    const snap = readSnapshot();
    if (snap) { this._hasSnapshot = true; this.applyBootstrap(snap, false); }
    if (!PREWARM) this.goLive();
    this._chirpTick = () => {
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
    };

    /* ---- design's ambient simulations (watch/call/room) ---- */
    this._interval = setInterval(() => {
      const s = this.state;
      if (!s.open || !s.slid) return;
      if (s.mode === 'watch') this.loadWatch();
      if (s.mode === 'watch' && s.playing && s.watchItem) {
        // real viewer count arrives with watchData — only simulate before it loads
        this.setState(p => ({ watchSec: p.watchSec + 1, viewers: p.watchData ? p.viewers : p.viewers + (Math.random() < 0.3 ? 1 : 0) }));
      }
      if ((s.mode === 'video' || s.mode === 'voice') && s.callPhase === 'connected') {
        this.setState(p => ({ callSec: p.callSec + 1 }));
      }
    }, 1000);
  }

  componentWillUnmount() {
    window.removeEventListener('keydown', this._key);
    window.removeEventListener('resize', this._resize);
    window.removeEventListener('message', this._onParentMessage);
    window.removeEventListener('pointerdown', this.gkUnlock, true);
    if (this._deviceObserver) { this._deviceObserver.disconnect(); this._deviceObserver = null; }
    this.detachHls();
    if (this._watchTimer) clearTimeout(this._watchTimer);
    if (this._interval) clearInterval(this._interval);
    this.stopNotifPolling();
    this.gkRecStop();
    this.live.stop();
    if (this._gkNoteTimer) clearTimeout(this._gkNoteTimer);
    if (this._searchTimer) clearTimeout(this._searchTimer);
    if (this._chirpTimer) clearInterval(this._chirpTimer);
    this._surfaceTimers.forEach(timer => clearTimeout(timer));
    this._surfaceTimers = [];
    if (this._callEndTimer) clearTimeout(this._callEndTimer);
    void this.chirp.close(true);
    void this.call.hangup(true);
    void this.tickerRoom.leave();
    this.transport.disconnect();
  }

  /* ---------------- watch deck: Loop Channel videos + live streams ---------------- */

  private _watchAt = 0;
  private _watchQ = '';
  private _watchTimer: ReturnType<typeof setTimeout> | null = null;
  private _watchEl: HTMLVideoElement | null = null;
  private _hls: { destroy: () => void } | null = null;
  private loadWatch(force = false) {
    const q = this.state.watchQ.trim();
    if (!force && q === this._watchQ && Date.now() - this._watchAt < 30000) return;
    this._watchAt = Date.now(); this._watchQ = q;
    void fetchWatch(q).then(data => {
      if (!data || this._watchQ !== q) return;
      this.setState(prev => {
        const next: Partial<State> = { watchData: data, viewers: data.viewers > 0 ? data.viewers : prev.viewers };
        /* nothing chosen yet and the desk is on air: the deck opens on the live stream */
        if (!prev.watchItem && !q && data.live.length && (data.live[0].src || data.live[0].ytId)) { next.watchItem = data.live[0]; next.playing = true; next.watchStart = 0; }
        return next as Pick<State, 'watchData'>;
      });
    });
  }
  private searchWatch = (q: string) => {
    this.setState({ watchQ: q });
    if (this._watchTimer) clearTimeout(this._watchTimer);
    this._watchTimer = setTimeout(() => this.loadWatch(true), 220);
  };
  /** Play one item in the deck (from the results list or a watch page hand-off). */
  private playWatch = (item: WatchItem, start = 0) => {
    if (!item.src && !item.ytId) { if (item.url) window.open(item.url, '_blank', 'noopener'); return; }
    this.setState({ mode: 'watch', watchItem: item, watchStart: start, playing: true, watchNeedTap: false, watchSec: 0 });
  };
  private detachHls() { if (this._hls) { try { this._hls.destroy(); } catch { /* already gone */ } this._hls = null; } }
  /** Wire a freshly mounted <video> to the current item: mp4 direct, HLS through hls.js (loaded on demand). */
  private mountWatch = (el: HTMLVideoElement | null) => {
    if (this._watchEl && this._watchEl !== el) this.detachHls();
    this._watchEl = el;
    const item = this.state.watchItem;
    if (!el || !item || !item.src) return;
    const src = item.src; const start = this.state.watchStart;
    const ready = () => {
      if (start > 0 && item.kind !== 'live') { try { el.currentTime = start; } catch { /* not seekable yet */ } }
      void this.tryPlay(el);
    };
    if (/\.m3u8(\?|$)/i.test(src) && !el.canPlayType('application/vnd.apple.mpegurl')) {
      loadHls().then(Hls => {
        if (this._watchEl !== el) return;
        if (Hls && Hls.isSupported()) {
          const h = new Hls({ lowLatencyMode: true, backBufferLength: 30 });
          h.loadSource(src); h.attachMedia(el); h.on(Hls.Events.MANIFEST_PARSED, ready); this._hls = h;
        } else { el.src = src; el.addEventListener('loadedmetadata', ready, { once: true }); }
      }).catch(() => { el.src = src; el.addEventListener('loadedmetadata', ready, { once: true }); });
    } else {
      el.src = src; el.addEventListener('loadedmetadata', ready, { once: true });
    }
  };
  /** Sound on when the browser allows it (the page click that handed the video over usually does), muted otherwise. */
  private async tryPlay(el: HTMLVideoElement) {
    el.muted = false;
    try { await el.play(); this.setState({ watchNeedTap: false }); return; } catch { /* autoplay with sound refused */ }
    el.muted = true;
    try { await el.play(); this.setState({ watchNeedTap: true }); } catch { this.setState({ watchNeedTap: true }); }
  }
  private unmuteWatch = () => { const el = this._watchEl; if (!el) return; el.muted = false; void el.play().catch(() => {}); this.setState({ watchNeedTap: false }); };

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

  /* ---------------- ticker voice rooms — the terminal's live voice chart rooms, from the phone ---------------- */

  private enterRoom = () => { this.setState({ mode: 'room' }); };
  private roomLook = (sym?: string) => {
    const s = String(sym ?? this.state.trInput).toUpperCase().replace(/[^A-Z0-9.-]/g, '').slice(0, 12);
    if (!s) return;
    this.setState({ trInput: s });
    void this.tickerRoom.look(s);
  };
  private roomJoin = (mode: 'speaker' | 'listener') => { void this.tickerRoom.join(mode); };
  private leaveRoom = () => { void this.tickerRoom.leave(); };
  private roomMute = () => { this.tickerRoom.setMuted(!this.state.tr.muted); };
  private roomOpenTerminal = () => { const s = this.state.tr.symbol; if (s) window.open(`https://stockmarketloop.com/tradingfloor/${encodeURIComponent(s.toLowerCase())}/`, '_blank', 'noopener'); };

  /* ---------------- message system wiring ---------------- */

  private wireToThread = (m: WireMessage): ThreadMsg => ({
    id: m.id,
    from: m.mine ? 'me' : 'them',
    text: m.text,
    media: m.media,
    ts: m.ts,
  });

  /* Alerts = site alerts only; message items (type dm) belong to the Messages tab (owner call 2026-09-07) */
  private toNotifs = (items: SiteNotification[]): Notif[] => (items || []).filter(item => item && item.type !== 'dm' && item.type !== 'message').map(this.notification);

  private notification = (item: SiteNotification, index: number): Notif => ({
    id: item.id,
    /* the OTHER member leads the alert: their name is the title, their avatar the tile */
    title: item.category === 'priority' ? 'Priority alert' : (item.actor?.name || (item.source === 'loop_bucks' ? 'Loop Bucks' : 'StockMarketLoop')),
    text: stripLead(item.message, [item.actor?.name, item.actor?.handle]),
    type: item.type,
    actor: item.actor || null,
    canFollowBack: item.canFollowBack,
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
      notifs: this.toNotifs(data.notifications?.items || []),
      preferences: data.preferences || {},
      chirpPrefs: data.chirp || {},
      loading: false,
    });
    const incoming = (data.incoming?.incoming || [])[0];
    if (incoming) void this.chirp.acceptIncoming(incoming);
    if (data.identity && data.identity.wpUserId) writeSnapshot(data);
  };

  private _live = false;
  private _hasSnapshot = false;
  private _chirpTick: (() => void) | null = null;
  private goLive = () => {
    if (this._live) return;
    this._live = true;
    const first = this.state.threads.length ? this.refreshSummary() : this.hydrate();
    void first.finally(() => { if (this._live) this.transport.connect(this.onIncoming, () => void this.refreshSummary(), names => { if (names.join('|') !== this.state.typingNames.join('|')) this.setState({ typingNames: names }); }); });
    if (this._chirpTick && !this._chirpTimer) this._chirpTimer = setInterval(this._chirpTick, 2800);
    this.startNotifPolling();
    this.startChirpPolling();
    void this.loadGroups();
  };
  private pauseLive = () => {
    if (!this._live) return;
    this._live = false;
    this.transport.disconnect();
    if (this._chirpTimer) { clearInterval(this._chirpTimer); this._chirpTimer = null; }
    this.stopNotifPolling();
    this.live.stop();
  };
  /* ---- composer (owner call 2026-09-07): a real textarea that grows as you write (up to 7 lines) ---- */
  private _composer: HTMLTextAreaElement | null = null;
  private _postReplyEl: HTMLTextAreaElement | null = null;
  private mountComposer = (el: HTMLTextAreaElement | null) => { this._composer = el; if (el) this.growComposer(el); };
  private growComposer = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = Math.min(119, Math.max(17, el.scrollHeight)) + 'px';
  };

  /* ---- the deck's real height (owner call 2026-09-07: while messaging the phone grew and its top screen was
     pushed above the frame). The top screen shrinks to whatever the deck leaves, so the whole phone stays visible. ---- */
  /* ---- the whole device must fit the frame, whatever is inside it (owner call 2026-09-07: "make sure it never
     happens again"). The top screen already yields to the deck; if the column is STILL taller than the frame
     (a long draft, a tall mode, a short window), the device scales down around its bottom-right corner. ---- */
  private _device = React.createRef<HTMLDivElement>();
  private _deviceObserver: ResizeObserver | null = null;
  private fitDevice = () => {
    const el = this._device.current;
    if (!el || !this.state.open) return;
    const natural = el.offsetHeight;                              /* layout height: unaffected by the parent's scale or its transition */
    if (natural < 1) return;
    const avail = Math.max(200, (this.state.vh || window.innerHeight) - 44);   /* 30px bottom offset + 14px breathing room */
    /* readable (owner call 2026-09-10): the device grows to fill the frame instead of staying at its 352px design size —
       up to 1.5× on desktop (the popup is 640px wide), and to the viewport width on phones */
    const naturalW = Math.max(1, el.offsetWidth);
    const availW = Math.max(200, window.innerWidth - 40);
    const k = Math.min(1.5, Math.round(Math.min(avail / natural, availW / naturalW) * 100) / 100);
    if (Math.abs(k - this.state.fit) > 0.01) this.setState({ fit: k });
  };

  private measureDeck = () => {
    const el = this._bottomSurface.current;
    if (!el || !this.state.open) return;
    const h = Math.round(el.getBoundingClientRect().height);
    if (h > 0 && Math.abs(h - this.state.deckH) > 2) this.setState({ deckH: h });
  };

  /* ---- alerts stream while the phone is open: the thread poll only wakes on thread changes,
     so likes / mentions / news / Loop Bucks arrive on their own 7s cadence (30s in a background tab) ---- */
  private _notifTimer: ReturnType<typeof setTimeout> | null = null;
  private startNotifPolling = () => {
    if (this._notifTimer) clearTimeout(this._notifTimer);
    const tick = async () => {
      if (!this._live) return;
      if (document.visibilityState !== 'hidden') {
        try { const r = await this.transport.notifications(); if (r && Array.isArray(r.items)) this.setState({ notifs: this.toNotifs(r.items) }); }
        catch { /* the next tick retries */ }
      }
      if (this._live) this._notifTimer = setTimeout(tick, document.visibilityState === 'hidden' ? 30000 : 7000);
    };
    this._notifTimer = setTimeout(tick, 7000);
  };
  private stopNotifPolling = () => { if (this._notifTimer) clearTimeout(this._notifTimer); this._notifTimer = null; this.stopChirpPolling(); };
  /* group chirps: their own fast loop (2 s on screen, 8 s hidden) while any group has Chirp on — separate from the 7 s alert poll */
  private _gkTimer: ReturnType<typeof setTimeout> | null = null;
  private startChirpPolling = () => {
    if (this._gkTimer) return;
    const tick = async () => {
      this._gkTimer = null;
      if (!this._live) return;
      if (this.state.groups.some(g => g.chirp)) { await this.gkPoll(); }
      if (this._live) this._gkTimer = setTimeout(tick, document.visibilityState === 'hidden' ? 6000 : 1000);
    };
    this._gkTimer = setTimeout(tick, 1500);
  };
  private stopChirpPolling = () => { if (this._gkTimer) clearTimeout(this._gkTimer); this._gkTimer = null; };

  /* ---- Groups (owner call 2026-09-10): per-channel group alerts into this phone + group Chirp.
     Alerts ride the normal alert feed (the WP side fans them out); Chirp = hold-to-record → upload → sml-group-kick,
     listeners poll the feed with the alerts and play in order. ---- */
  private _gkLast = 0;
  private _gkMe = 0;
  /* LIVE: the analyst's voice arrives over WebRTC while they talk (same rooms as the group page); recorded chirps stay the fallback */
  private live = new ChirpLiveListener(() => String((window.LOOP_KICK_CONFIG && window.LOOP_KICK_CONFIG.sessionToken) || ''), states => this.setState({ gkLive: states }));
  private liveSync = () => {
    if (this.transport.name !== 'live' || !this._live) { this.live.stop(); return; }
    this.live.sync(this.state.groups.filter(g => g.chirp).map(g => ({ id: g.id, wants: (c: { by: { id: number }; channelId: number }) => this.gkWants(g, c as GroupChirp) })));
  };
  private _gkSig: Record<number, number> = {};   /* per-group cursor for the signal files */
  private _gkSigFails = 0;
  private _gkQueue: GroupChirp[] = [];
  private _gkAudio: HTMLAudioElement | null = null;
  private _gkUnlocked = false;
  /* phones refuse audio that was not started by a touch: one element is blessed by the first touch (silent clip) and reused for every chirp */
  private gkPlayer = () => { if (!this._gkAudio) { this._gkAudio = new Audio(); this._gkAudio.preload = 'auto'; this._gkAudio.setAttribute('playsinline', ''); } return this._gkAudio; };
  private gkUnlock = () => {
    if (this._gkUnlocked) return; this._gkUnlocked = true;
    try { const a = this.gkPlayer(); if (!this.state.gkPlaying) { a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='; void a.play().catch(() => { this._gkUnlocked = false; }); } } catch { this._gkUnlocked = false; }
  };
  private _gkRec: MediaRecorder | null = null;
  private _gkChunks: Blob[] = [];
  private _gkRecTimer: ReturnType<typeof setInterval> | null = null;
  private _gkRecStart = 0;
  private _gkNoteTimer: ReturnType<typeof setTimeout> | null = null;
  private loadGroups = async (withMembers = false) => {
    if (this.transport.name !== 'live') { this.setState({ groupsLoaded: true }); return; }
    try {
      const r = await this.transport.groups(withMembers);
      if (!this._gkLast) this._gkLast = Number(r.lastChirp) || 0;
      if (r.me) this._gkMe = Number(r.me) || this._gkMe;
      this.setState(p => ({ groups: (r.groups || []).map(g => ({ ...g, members: g.members || p.groups.find(x => x.id === g.id)?.members })), groupsLoaded: true, groupsErr: '' }), this.liveSync);
    } catch (e) { this.setState({ groupsLoaded: true, groupsErr: (e as Error).message || 'Could not load your groups' }); }
  };
  private gkNote = (text: string) => {
    this.setState({ groupsNote: text });
    if (this._gkNoteTimer) clearTimeout(this._gkNoteTimer);
    this._gkNoteTimer = setTimeout(() => this.setState({ groupsNote: '' }), 6000);
  };
  private gkToggle = async (g: KickGroup, channelId: number, field: 'alerts' | 'chirp', on: boolean) => {
    const key = `${g.id}:${channelId}:${field}`;
    this.setState({ groupsBusy: key, groupsErr: '' });
    const body: { group_id: number; channel_id: number; alerts?: boolean; chirp?: boolean } = { group_id: g.id, channel_id: channelId };
    if (field === 'alerts') body.alerts = on; else body.chirp = on;
    try {
      const r = await this.transport.groupSub(body);
      this.setState(p => ({ groups: p.groups.map(x => x.id === g.id ? { ...x, ...r.group, members: x.members } : x), groupsBusy: '' }), this.liveSync);
      if (field === 'chirp') this.gkNote(on ? `🔊 You will hear ${g.name} chirps anywhere on the site` : `Chirp off for ${g.name}`);
      else if (channelId === 0) this.gkNote(on ? `🔔 Every ${g.name} channel now alerts this phone` : `Alerts off for ${g.name}`);
    } catch (e) { this.setState({ groupsBusy: '', groupsErr: (e as Error).message || 'Could not save that' }); }
  };
  /* which channels / voices to hear (empty = all) */
  private gkPick = async (g: KickGroup, kind: 'channels' | 'voices', id: number) => {
    const cur = (kind === 'channels' ? g.chirpChannels : g.chirpVoices) || [];
    const next = id === 0 ? [] : (cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]);
    this.setState({ groupsBusy: `pick:${g.id}` });
    try {
      const r = await this.transport.groupSub(kind === 'channels' ? { group_id: g.id, channel_id: 0, chirp_channels: next } : { group_id: g.id, channel_id: 0, chirp_voices: next });
      this.setState(p => ({ groups: p.groups.map(x => x.id === g.id ? { ...x, ...r.group, members: x.members } : x), groupsBusy: '' }));
    } catch (e) { this.setState({ groupsBusy: '', groupsErr: (e as Error).message || 'Could not save that' }); }
  };
  private gkSavePerms = async (g: KickGroup, mode: string, users: number[]) => {
    this.setState({ groupsBusy: `perm:${g.id}`, groupsErr: '' });
    try {
      const r = await this.transport.groupChirpPerms({ group_id: g.id, mode, users });
      this.setState(p => ({ groups: p.groups.map(x => x.id === g.id ? { ...x, chirpRule: r.rule } : x), groupsBusy: '' }));
    } catch (e) { this.setState({ groupsBusy: '', groupsErr: (e as Error).message || 'Could not save who can Chirp' }); }
  };
  private gkRecStart = async (g: KickGroup) => {
    if (this._gkRec) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { this.setState({ groupsErr: 'This browser cannot record audio.' }); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000, channelCount: 1 } });
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(m => MediaRecorder.isTypeSupported(m)) || '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : { audioBitsPerSecond: 128000 });
      this._gkChunks = [];
      rec.ondataavailable = ev => { if (ev.data && ev.data.size) this._gkChunks.push(ev.data); };
      rec.onstop = () => { stream.getTracks().forEach(tr => tr.stop()); void this.gkRecDone(g, rec.mimeType || mime || 'audio/webm'); };
      rec.start(250);
      this._gkRec = rec; this._gkRecStart = Date.now();
      this.setState({ groupsBusy: `rec:${g.id}`, gkRecSec: 0, groupsErr: '' });
      this._gkRecTimer = setInterval(() => { const sec = Math.floor((Date.now() - this._gkRecStart) / 1000); this.setState({ gkRecSec: sec }); if (sec >= 30) this.gkRecStop(); }, 250);
    } catch { this.setState({ groupsErr: 'Microphone blocked. Allow the mic to Chirp.' }); }
  };
  private gkRecStop = () => {
    const rec = this._gkRec; if (!rec) return;
    this._gkRec = null;
    if (this._gkRecTimer) { clearInterval(this._gkRecTimer); this._gkRecTimer = null; }
    try { if (rec.state !== 'inactive') rec.stop(); } catch { /* already stopped */ }
  };
  private gkRecDone = async (g: KickGroup, mime: string) => {
    const sec = Math.max(1, Math.round((Date.now() - this._gkRecStart) / 1000));
    const blob = new Blob(this._gkChunks, { type: mime.split(';')[0] });
    this._gkChunks = [];
    if (blob.size < 400) { this.setState({ groupsBusy: '', groupsErr: 'Hold the button while you talk.' }); return; }
    this.setState({ groupsBusy: `send:${g.id}` });
    try {
      const ext = /mp4/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm';
      const file = new File([blob], `chirp-${Date.now()}.${ext}`, { type: blob.type });
      const up = await this.transport.upload(file, 'voice');
      const r = await this.transport.groupChirp({ group_id: g.id, attachment_id: up.id, duration: sec });
      this.setState({ groupsBusy: '' });
      this.gkNote(`🔊 Chirped ${g.name} · ${sec}s · everyone on the group page hears it now, ${r.listeners} member${r.listeners === 1 ? '' : 's'} listening elsewhere`);
    } catch (e) { this.setState({ groupsBusy: '', groupsErr: (e as Error).message || 'That chirp did not send' }); }
  };
  /* the signal file: ~50 ms static fetch per group per second instead of a WordPress boot; falls back to the REST feed if it fails */
  private gkWants = (g: KickGroup, c: { channelId: number; by: { id: number } }) => {
    const ch = g.chirpChannels || [], vo = g.chirpVoices || [];
    if (ch.length && c.channelId && !ch.includes(Number(c.channelId))) return false;
    if (vo.length && !vo.includes(Number(c.by?.id))) return false;
    return true;
  };
  private gkPoll = async () => {
    if (this.transport.name !== 'live') return;
    const groups = this.state.groups.filter(g => g.chirp && g.signal);
    if (groups.length && this._gkSigFails <= 3) {
      await Promise.all(groups.map(async g => {
        try {
          const res = await fetch(`${g.signal}?v=${Date.now()}`, { cache: 'no-store', credentials: 'omit' });
          if (!res.ok) { this._gkSigFails++; return; }
          const j = await res.json() as { last: number; recent: GroupChirp[] };
          this._gkSigFails = 0;
          const l = Number(j.last) || 0;
          const cur = this._gkSig[g.id];
          if (cur === undefined) { this._gkSig[g.id] = l; return; }
          if (l > cur) {
            const items = (j.recent || []).filter(c => Number(c.id) > cur && Number(c.by?.id) !== this._gkMe && this.gkWants(g, c)).sort((a, b) => a.id - b.id);
            this._gkSig[g.id] = l;
            if (items.length) { this._gkQueue.push(...items); void this.gkPlayNext(); }
          }
        } catch { this._gkSigFails++; }
      }));
      return;
    }
    try {
      const r = await this.transport.groupChirpFeed(this._gkLast);
      const last = Number(r.last) || 0;
      this._gkLast = Math.max(this._gkLast, last);   /* with no cursor yet the server only sends the last 45 s, so the first chirp ever still plays */
      if (Array.isArray(r.chirps) && r.chirps.length) { this._gkQueue.push(...r.chirps); void this.gkPlayNext(); }
    } catch { /* next tick */ }
  };
  private gkPlayNext = async () => {
    if (this.state.gkPlaying || !this._gkQueue.length) return;
    const c = this._gkQueue.shift() as GroupChirp;
    const el = this.gkPlayer();
    const done = () => { el.onended = null; el.onerror = null; this.setState({ gkPlaying: null, gkNeedTap: false }); void this.gkPlayNext(); };
    el.onended = done; el.onerror = done;
    el.src = c.url; el.load();
    this.setState({ gkPlaying: c, gkNeedTap: false });
    try { await el.play(); } catch { this.setState({ gkNeedTap: true }); const h = () => { document.removeEventListener('pointerdown', h, true); this.gkTapPlay(); }; document.addEventListener('pointerdown', h, true); }
  };
  private gkTapPlay = () => { const el = this._gkAudio; if (!el) return; void el.play().then(() => this.setState({ gkNeedTap: false })).catch(() => {}); };

  /* ---- "… is typing" (owner call 2026-09-07): while the draft has text we tell the server every 4s,
     and stop 6s after the last keystroke or when the draft empties (sending empties it). ---- */
  private _typingOn = false;
  private _typingSentAt = 0;
  private _typingOffTimer: ReturnType<typeof setTimeout> | null = null;
  private noteTyping = () => {
    const id = this.state.activeThreadId;
    if (!id || this.state.mode !== 'compose' || this.transport.name !== 'live') return;
    const has = this.state.draft.trim().length > 0;
    if (this._typingOffTimer) { clearTimeout(this._typingOffTimer); this._typingOffTimer = null; }
    if (!has) { if (this._typingOn) { this._typingOn = false; void this.transport.typing(id, false).catch(() => {}); } return; }
    if (!this._typingOn || Date.now() - this._typingSentAt > 4000) { this._typingOn = true; this._typingSentAt = Date.now(); void this.transport.typing(id, true).catch(() => {}); }
    this._typingOffTimer = setTimeout(() => { this._typingOn = false; void this.transport.typing(id, false).catch(() => {}); }, 6000);
  };

  private _onParentMessage = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const type = event.data && (event.data as { type?: string }).type;
    if (type === 'sml-loop-kick:open') {
      // Owner call 2026-09-08: the phone's own X (or Escape) leaves the app closed and the page hides the popup;
      // when the page opens the popup again the phone must come back up too, not stay folded behind the dock mask.
      if (!this.state.open || !this.state.slid) this.setState({ open: true, slid: true });
      this.goLive();
      // The prewarmed frame reported its phone-shaped mask while the popup was hidden (0×0),
      // which the bridge rightly ignored. Report again now that we are visible, and once more
      // after the layout has settled, so the bridge can mask everything outside the phone.
      this.scheduleEmbedSurface();
      [350, 1200].forEach(ms => this._surfaceTimers.push(setTimeout(this.publishEmbedSurface, ms)));
    } else if (type === 'sml-loop-kick:close') this.pauseLive();
    else if (type === 'sml-loop-kick:watch') {
      /* a watch page's mini button: keep playing its video or stream here, from where it was */
      const d = event.data as { item?: WatchItem; time?: number };
      if (d.item && (d.item.src || d.item.ytId)) {
        this.playWatch(d.item, Number(d.time) || 0);
        this.goLive();
        try { (event.source as Window).postMessage({ type: 'sml-loop-kick:watch-ack', id: d.item.id }, '*'); } catch { /* the page will retry */ }
      }
    }
  };

  private hydrate = async () => {
    this.setState({ loading: !this._hasSnapshot, sendError: '' });
    try { this.applyBootstrap(await this.transport.bootstrap(), false); }
    catch (error) { this.setState({ loading: false, sendError: (error as Error).message }); }
  };

  private refreshSummary = async () => {
    try { this.applyBootstrap(await this.transport.bootstrap()); } catch { /* next poll retries */ }
  };

  private openThread = async (thread: ThreadSummary) => {
    this.transport.setActiveThread(thread.id);
    this.setState({ activeThreadId: thread.id, thread: [], loading: true, sendError: '', tab: 'messages', typingNames: [], callMenu: false });
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

  /** owner call 2026-09-07: only friends (members who follow each other) can be messaged, Chirped or called */
  private openPersonGated = (person: Person) => {
    if (person.friend === false) { this.setState({ sendError: `Follow ${person.name} and have them follow you back. Then you are friends and can message, Chirp or call.` }); return; }
    void this.openPerson(person);
  };

  private callFriend = async (person: Person, video = false) => {
    await this.openPerson(person);
    if (this.state.activeThreadId) this.startCall(video);
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

  private markAllRead = async () => {
    this.setState(prev => ({ notifs: prev.notifs.map(n => ({ ...n, unread: false })) }));
    try { const r = await this.transport.updateNotification({ action: 'read_all' }); if (r && Array.isArray(r.items)) this.setState({ notifs: this.toNotifs(r.items) }); } catch { /* optimistic state stands; the next bootstrap reconciles */ }
  };

  private clearAll = async () => {
    const before = this.state.notifs;
    this.setState({ notifs: [] });
    try { const r = await this.transport.updateNotification({ action: 'clear_all' }); if (r && Array.isArray(r.items)) this.setState({ notifs: this.toNotifs(r.items) }); }
    catch { this.setState({ notifs: before }); }
  };

  private markNotification = async (item: Notif) => {
    this.setState(p => ({ notifs: p.notifs.map(n => n.id === item.id ? { ...n, unread: false } : n) }));
    if (!item.id.startsWith('demo-')) {
      try { await this.transport.updateNotification({ action: 'read', id: item.id }); } catch { /* optimistic read can retry later */ }
    }
    /* a message alert opens the conversation right here, in the device */
    if (item.type === 'dm') {
      this.setState({ tab: 'messages' });
      if (item.actor?.id) { try { const thread = await this.transport.openThread(item.actor.id); if (thread?.id) await this.openThread(thread); } catch { /* the messages tab is already showing */ } }
      return;
    }
    const focus = /[?&]focus=([A-Za-z0-9._:-]+)/.exec(item.link || '');
    if (focus) { void this.openPost(decodeURIComponent(focus[1])); return; }   /* the post opens right here (owner call 2026-09-08) */
    if (item.link) window.open(item.link, '_top');
  };

  /* ---------------- a feed post inside the phone ---------------- */
  private openPost = async (item: string) => {
    this.setState({ tab: 'notifs', postItem: item, post: null, postBusy: 'load', postReply: '', postNote: '' });
    try { const post = await this.transport.post(item); if (this.state.postItem === item) this.setState({ post, postBusy: '' }); }
    catch (e) { this.setState({ postBusy: '', postNote: (e as Error).message || 'Could not load that post.' }); }
  };
  private closePost = () => this.setState({ post: null, postItem: '', postBusy: '', postReply: '', postNote: '' });
  private postAct = async (action: 'like' | 'comment' | 'share', extra: { text?: string; platform?: string } = {}) => {
    const post = this.state.post; if (!post || this.state.postBusy) return;
    this.setState({ postBusy: action, postNote: '' });
    try {
      const next = await this.transport.postAction(post.item, action, extra);
      this.setState({ post: next, postBusy: '', postReply: action === 'comment' ? '' : this.state.postReply, postNote: action === 'comment' ? 'Reply posted' : (action === 'share' ? 'Shared · link copied' : '') });
    } catch (e) { this.setState({ postBusy: '', postNote: (e as Error).message || 'That did not go through.' }); }
  };
  private sharePost = async () => {
    const post = this.state.post; if (!post) return;
    const text = post.author.name + ' posted on Stockmarketloop.com ' + post.url;
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked: the note still shows the link was shared */ }
    if ((navigator as any).share) { try { await (navigator as any).share({ title: post.author.name + ' on Stock Market Loop', text: post.text.slice(0, 120), url: post.url }); } catch { /* dismissed */ } }
    await this.postAct('share', { platform: 'loopkick' });
  };

  /* Follow back from a follow alert (server side: sml-notify handles action=follow_back on the hub route). */
  private followBack = async (item: Notif) => {
    if (!item.actor?.id) return;
    this.setState(p => ({ notifs: p.notifs.map(n => n.id === item.id ? { ...n, canFollowBack: false, following: true } : n) }));
    try { await this.transport.updateNotification({ action: 'follow_back', id: item.id, actor_id: item.actor.id }); }
    catch { this.setState(p => ({ notifs: p.notifs.map(n => n.id === item.id ? { ...n, canFollowBack: true, following: false } : n) })); }
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

  /** Incoming message (poll in live mode, canned reply in mock): the open conversation gets the bubble,
      any other conversation refreshes the thread list so the Messages badge lights — never the Alerts tab. */
  private onIncoming = (m: WireMessage) => {
    if (!m || !m.text) return;
    this.scrollBottom();
    if (m.threadId === this.state.activeThreadId) this.setState(p => ({ thread: [...p.thread, this.wireToThread(m)] }));
    else void this.refreshSummary();
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
      thread: [...p.thread, { id: `optimistic-${Date.now()}`, from: 'me', text, ts: Date.now() }],
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
    const deckH = s.deckH || 264;
    const screen = Math.max(110, Math.min(s.slid ? 200 : 250, vh - (s.slid ? deckH + 196 : 200)));
    const acc = ACCENT_OPTS.find(a => a.c === s.accent) || ACCENT_OPTS[0];
    const accentGrad = `linear-gradient(140deg,${acc.c},${acc.d})`;
    const bgOf = (key: string) => (BG_OPTS.find(b => b.key === key) || BG_OPTS[0]).bg(acc.c);
    const deviceFont = (FONT_OPTS.find(f => f.key === s.font) || FONT_OPTS[0]).stack;
    const openTo = (tab: State['tab']) => () => { this.scrollBottom(); this.setState({ open: true, slid: true, tab }); };
    const showComposer = (s.mode === 'compose' && s.slid && !!activeThread);
    const coverVisible = s.mode === 'compose' && !s.slid;
    const callTime = Math.floor(s.callSec / 60) + ':' + String(s.callSec % 60).padStart(2, '0');
    const callTgt = this.callTarget();
    const calleeName = s.callPeerName || (callTgt ? callTgt.name : PEER_NAME);
    const preCall = s.callPhase === 'idle' || s.callPhase === 'ended'; // show "ready to call" screen
    const mono = 'ui-monospace,Menlo,monospace';

    const wm = (size: number, ls: number) => (
      <div style={{ position: 'absolute', inset: 0, display: s.wmOn ? 'flex' : 'none', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, pointerEvents: 'none', zIndex: 5 }}>
        <img src={WM_LOGO} alt="" draggable={false} style={{ width: Math.round(size * 5.2), maxWidth: '78%', opacity: .1, transform: 'rotate(-12deg)' }} />
        {s.wmText && <span style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: Math.round(size * .55), letterSpacing: ls, color: 'rgba(255,255,255,.06)', transform: 'rotate(-12deg)', whiteSpace: 'nowrap' }}>{s.wmText}</span>}
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
            <div style={{ fontSize: 10.5, color: '#dfe7ee' }}>{unread ? unread + ' new' : 'All caught up'}</div>
          </div>
          {unread > 0 && (
            <span style={{ minWidth: 20, height: 20, padding: '0 6px', borderRadius: 999, background: '#ff3b5c', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{unread}</span>
          )}
        </div>

        {/* ---- device ---- */}
        <div style={{ position: 'fixed', right: 30, bottom: 30, zIndex: 80, display: s.open ? 'block' : 'none', transform: `scale(${s.fit})`, transformOrigin: 'bottom right', transition: 'transform .22s ease', ['--acc' as string]: acc.c }}>
          <div ref={this._device} className="lk-device3d" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', transform: 'none', fontFamily: deviceFont, filter: `drop-shadow(0 22px 40px rgba(0,0,0,.7)) drop-shadow(0 0 30px ${acc.c}22)` }}>

            {/* ---- top fold ---- */}
            <div style={{ height: s.slid ? screen + 148 : 0, overflow: 'visible', transition: 'height .42s cubic-bezier(.2,.8,.25,1)', display: 'flex', alignItems: 'flex-end' }}>
              <div ref={this._topSurface} style={{ width: 352, position: 'relative', isolation: 'isolate', borderRadius: 34, padding: 3, background: 'linear-gradient(145deg,#aab6c2 0%,#4a545f 16%,#14181d 46%,#0a0d10 58%,#39434e 82%,#7d8a97 100%)', boxShadow: `inset 0 1px 1.5px rgba(255,255,255,.7), inset 0 -1px 2px rgba(0,0,0,.6), 0 0 0 1px rgba(0,0,0,.5), 0 0 34px -6px ${acc.c}3a, 0 46px 90px -34px ${acc.c}30`, zIndex: 2, transformOrigin: 'center bottom', transform: s.slid ? 'rotateX(0deg)' : 'rotateX(-89deg)', opacity: s.slid ? 1 : 0, pointerEvents: s.slid ? 'auto' : 'none', transition: 'transform .42s cubic-bezier(.2,.8,.25,1), opacity .32s ease' }}>
                <div style={{ position: 'absolute', inset: 0, borderRadius: 34, background: 'radial-gradient(130px 95px at 16% 10%, rgba(255,255,255,.5) 0%, rgba(255,255,255,.13) 32%, transparent 60%)', pointerEvents: 'none', zIndex: 3 }} />
                <div style={{ position: 'absolute', right: -3, top: 70, width: 4, height: 52, borderRadius: '0 3px 3px 0', background: acc.c, boxShadow: `1px 0 3px ${acc.c}66` }} />
                <div style={{ position: 'absolute', right: -3, top: 134, width: 4, height: 70, borderRadius: '0 3px 3px 0', background: 'linear-gradient(#39424c,#12161b)' }} />
                <div style={{ position: 'absolute', left: -3, top: 92, width: 4, height: 40, borderRadius: '3px 0 0 3px', background: 'linear-gradient(#39424c,#12161b)' }} />

                <div style={{ borderRadius: 31, background: '#010304', padding: '10px 10px 12px', position: 'relative', overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', inset: 0, borderRadius: 31, background: 'linear-gradient(122deg, rgba(255,255,255,.19) 0%, rgba(255,255,255,.07) 11%, rgba(255,255,255,.015) 20%, transparent 30%, transparent 68%, rgba(255,255,255,.03) 84%, rgba(255,255,255,.12) 100%)', pointerEvents: 'none', zIndex: 6 }} />
                  {/* flat, glare-free (owner call 2026-09-10): no drifting sheen over the glass */}

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
                    {/* no environment reflection over the screen — the text stays clean */}
                    {wm(44, 4)}
                    {/* status bar */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 14px 4px', fontFamily: mono, fontSize: 9, letterSpacing: 0.6, color: '#dfe7ee' }}>
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
                        { key: 'friends', label: 'Friends', badge: 0 },
                        { key: 'groups', label: 'Groups', badge: 0 },
                      ] as { key: State['tab']; label: string; badge: number }[]).map(t => (
                        <div key={t.key} onClick={() => { this.scrollBottom(); this.setState({ tab: t.key }); if (t.key === 'groups') void this.loadGroups(); }}
                          style={{ flex: 1, textAlign: 'center', padding: '7px 0', fontSize: 11, fontWeight: 600, borderRadius: 9, cursor: 'pointer', color: s.tab === t.key ? acc.fg : '#dfe7ee', background: s.tab === t.key ? acc.c : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, transition: 'background .18s, color .18s' }}>
                          <span>{t.label}</span>
                          {t.badge > 0 && (
                            <span style={{ minWidth: 15, height: 15, padding: '0 4px', borderRadius: 999, background: '#ff3b5c', color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{t.badge}</span>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* screen content */}
                    <div style={{ height: screen, overflowY: 'auto', padding: '2px 12px 12px', transition: 'height .3s ease' }}>
                      {s.gkLive.some(l => l.talking.length || l.needTap) && (() => {
                        const talk = s.gkLive.flatMap(l => l.talking.map(m => ({ m, g: s.groups.find(x => x.id === l.gid) })));
                        const need = s.gkLive.some(l => l.needTap);
                        return (
                          <div onClick={() => this.live.tapToHear()} role={need ? 'button' : undefined} style={{ position: 'sticky', top: 0, zIndex: 6, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 11, marginBottom: 8, cursor: need ? 'pointer' : 'default', background: 'linear-gradient(140deg,#3a1220,#1f0b12)', boxShadow: 'inset 0 0 0 1px rgba(255,59,92,.45), 0 6px 18px -8px rgba(0,0,0,.8)' }}>
                            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff3b5c', flex: 'none', boxShadow: '0 0 0 4px rgba(255,59,92,.25)' }} />
                            <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: '#e8edf2', lineHeight: 1.35 }}>
                              {talk.length ? <><b style={{ color: '#ff8fa3' }}>LIVE · {talk.map(t => t.m.name).join(', ')}</b> talking in {talk[0]?.g?.name || 'the group'}</> : <b style={{ color: '#ff8fa3' }}>LIVE chirp</b>}
                              {need ? ' — tap to hear it' : ''}
                            </span>
                          </div>
                        );
                      })()}
                      {s.gkPlaying && (
                        <div onClick={this.gkTapPlay} role={s.gkNeedTap ? 'button' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 11, marginBottom: 8, cursor: s.gkNeedTap ? 'pointer' : 'default', background: 'linear-gradient(140deg,#123a2a,#0b1f18)', boxShadow: 'inset 0 0 0 1px rgba(0,255,136,.35)' }}>
                          {s.gkPlaying.by?.avatar ? <img src={s.gkPlaying.by.avatar} alt="" referrerPolicy="no-referrer" style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover', flex: 'none' }} /> : <span style={{ width: 24, height: 24, borderRadius: '50%', background: '#00ff88', flex: 'none' }} />}
                          <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: '#e8edf2', lineHeight: 1.35 }}><b style={{ color: '#00ff88' }}>🔊 {s.gkPlaying.by?.name}</b> chirped in {s.gkPlaying.group}{s.gkNeedTap ? ' — tap to hear it' : ''}</span>
                        </div>
                      )}
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
                                {(['pinned', 'muted'] as const).map(flag => <button key={flag} onClick={() => void this.toggleFlag(flag)} title={`${activeThread[flag] ? 'Remove' : 'Set'} ${flag}`} style={{ border: 0, padding: '4px 5px', borderRadius: 6, cursor: 'pointer', background: activeThread[flag] ? acc.c : '#111a23', color: activeThread[flag] ? acc.fg : '#dfe7ee', fontSize: 8 }}>{flag[0].toUpperCase()}</button>)}
                                <button onClick={() => this.setState(prev => ({ callMenu: !prev.callMenu }))} title="Call: voice, video or Chirp" style={{ border: 0, padding: '4px 7px', borderRadius: 6, cursor: 'pointer', background: s.callMenu ? acc.c : '#111a23', color: s.callMenu ? acc.fg : acc.c, fontSize: 9, fontWeight: 800 }}>☎ Call</button>
                                {activeThread.type === 'dm' && <button onClick={() => void this.clearActiveHistory()} title="Delete private conversation history" style={{ border: 0, padding: '4px 5px', borderRadius: 6, cursor: 'pointer', background: '#241018', color: '#ff5c7a', fontSize: 8 }}>D</button>}
                              </div>
                              {s.callMenu && (
                                <div style={{ display: 'flex', gap: 6, padding: '6px 7px', borderRadius: 10, background: '#101820', animation: 'msgIn .2s ease' }}>
                                  {([
                                    ['Voice call', () => this.startCall(false)],
                                    ['Video call', () => this.startCall(true)],
                                    ['Chirp', () => { if (activePerson) { this.setState({ tab: 'chirp' }); void this.startChirp(activePerson); } else this.setState({ tab: 'chirp' }); }],
                                  ] as [string, () => void][]).map(([label, go]) => (
                                    <button key={label} onClick={() => { this.setState({ callMenu: false }); go(); }} style={{ flex: 1, border: '1px solid rgba(255,255,255,.1)', borderRadius: 999, padding: '6px 8px', fontSize: 10, fontWeight: 700, cursor: 'pointer', background: '#0a1117', color: '#e8edf2' }}>{label}</button>
                                  ))}
                                </div>
                              )}
                              {activeThread.state === 'request' && (
                                <div style={{ display: 'flex', gap: 7, padding: '7px', borderRadius: 10, background: '#101820' }}>
                                  <span style={{ flex: 1, color: '#e9eff4', fontSize: 10 }}>Message request</span>
                                  <button onClick={() => void this.transport.respondRequest(activeThread.id, 'accept').then(() => this.refreshSummary())} style={{ border: 0, borderRadius: 6, background: acc.c, color: acc.fg, fontSize: 9, cursor: 'pointer' }}>Accept</button>
                                  <button onClick={() => void this.transport.respondRequest(activeThread.id, 'decline').then(() => { this.setState({ activeThreadId: 0, thread: [] }); void this.refreshSummary(); })} style={{ border: '1px solid #ff5c7a', borderRadius: 6, background: 'transparent', color: '#ff5c7a', fontSize: 9, cursor: 'pointer' }}>Decline</button>
                                </div>
                              )}
                              {s.loading && <div style={{ color: '#dfe7ee', fontSize: 10, textAlign: 'center' }}>Loading conversation…</div>}
                              {s.thread.map((m, i) => m.from === 'me' ? (
                                <div key={m.id || i} style={{ display: 'flex', justifyContent: 'flex-end', animation: 'msgIn .2s ease' }}>
                                  <div style={{ maxWidth: '80%', padding: '9px 13px', borderRadius: '17px 17px 5px 17px', fontSize: 12, lineHeight: 1.5, background: accentGrad, color: acc.fg, boxShadow: `0 6px 18px ${acc.c}3d, inset 0 1px 0 rgba(255,255,255,.35)` }}>
                                    {m.media?.map(media => media.mime.startsWith('image/') ? <img key={media.id} src={media.url} alt="Message attachment" style={{ display: 'block', width: '100%', maxHeight: 140, objectFit: 'cover', borderRadius: 8, marginBottom: m.text ? 5 : 0 }} /> : <audio key={media.id} controls src={media.url} style={{ width: 190, maxWidth: '100%' }} />)}
                                    {customEmojiText(m.text)}
                                    {m.ts ? <div style={{ fontFamily: mono, fontSize: 8.5, marginTop: 4, opacity: .72, textAlign: 'right', letterSpacing: .3 }}>{fmtTs(m.ts)}</div> : null}
                                  </div>
                                </div>
                              ) : (
                                <div key={m.id || i} style={{ display: 'flex', justifyContent: 'flex-start', animation: 'msgIn .2s ease' }}>
                                  <div style={{ maxWidth: '80%', padding: '9px 13px', borderRadius: '17px 17px 17px 5px', fontSize: 12, lineHeight: 1.5, background: 'rgba(22,30,41,.94)', color: '#dbe4ec', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.07), inset 0 0 0 1px rgba(255,255,255,.04), 0 4px 12px rgba(0,0,0,.4)' }}>
                                    {m.media?.map(media => media.mime.startsWith('image/') ? <img key={media.id} src={media.url} alt="Message attachment" style={{ display: 'block', width: '100%', maxHeight: 140, objectFit: 'cover', borderRadius: 8, marginBottom: m.text ? 5 : 0 }} /> : <audio key={media.id} controls src={media.url} style={{ width: 190, maxWidth: '100%' }} />)}
                                    {customEmojiText(m.text)}
                                    {m.ts ? <div style={{ fontFamily: mono, fontSize: 8.5, marginTop: 4, opacity: .72, textAlign: 'right', letterSpacing: .3 }}>{fmtTs(m.ts)}</div> : null}
                                  </div>
                                </div>
                              ))}
                              {s.typingNames.length > 0 && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#e9eff4', fontSize: 10.5, padding: '2px 6px', animation: 'msgIn .2s ease' }}>
                                  <span className="lk-typing" aria-hidden="true"><i /><i /><i /></span>
                                  <span><strong style={{ color: '#c3ccd4' }}>{s.typingNames.join(', ')}</strong> {s.typingNames.length > 1 ? 'are' : 'is'} typing…</span>
                                </div>
                              )}
                            </>
                          ) : (
                            <>
                              <input value={s.search} onChange={event => this.searchPeople(event.target.value)} placeholder="Search members…" aria-label="Search members" style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #1e2831', borderRadius: 9, padding: '8px 10px', background: '#0a1117', color: '#e8edf2', outline: 'none', fontSize: 11 }} />
                              {(s.searchResults.length ? s.searchResults : s.people.filter(person => !person.presence?.stale).slice(0, 4)).map(person => (
                                <button key={`person-${person.userId}`} onClick={() => this.openPersonGated(person)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 0, borderRadius: 10, background: '#0a1117', color: '#e8edf2', padding: '7px 9px', cursor: 'pointer', textAlign: 'left' }}>
                                  {person.avatar ? <img src={person.avatar} alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }} /> : <span style={{ width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center', background: '#17242a', color: acc.c }}>{person.name.slice(0, 1)}</span>}
                                  <span style={{ minWidth: 0, flex: 1 }}><strong style={{ display: 'block', fontSize: 11 }}>{person.name}</strong><small style={{ color: '#dfe7ee' }}>@{person.handle}</small></span>
                                  <span style={{ color: person.presence?.stale ? '#b3bfca' : acc.c, fontSize: 9 }}>{person.friend === false ? 'not friends' : (person.presence?.stale ? '' : '● live')}</span>
                                </button>
                              ))}
                              <div style={{ fontFamily: mono, fontSize: 8, color: '#5c6771', letterSpacing: 1, paddingTop: 3 }}>CONVERSATIONS</div>
                              {s.loading && <div style={{ color: '#dfe7ee', fontSize: 10, textAlign: 'center' }}>Loading your inbox…</div>}
                              {s.threads.map(thread => {
                                const person = thread.people?.[0];
                                return <button key={thread.id} onClick={() => void this.openThread(thread)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 0, borderRadius: 11, background: thread.unread ? 'linear-gradient(160deg,#0b1620,#081018)' : '#070d13', color: '#e8edf2', padding: '8px 9px', cursor: 'pointer', textAlign: 'left' }}>
                                  {person?.avatar ? <img src={person.avatar} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }} /> : <span style={{ width: 32, height: 32, borderRadius: '50%', display: 'grid', placeItems: 'center', background: '#17242a', color: acc.c }}>{(person?.name || thread.title || thread.type).slice(0, 1).toUpperCase()}</span>}
                                  <span style={{ minWidth: 0, flex: 1 }}><strong style={{ display: 'block', fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{person?.name || thread.title || `${thread.type} thread`}</strong><small style={{ display: 'block', color: '#dfe7ee', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{thread.last_message.preview ? customEmojiText(thread.last_message.preview) : thread.category}</small></span>
                                  {thread.unread > 0 && <span style={{ minWidth: 17, height: 17, borderRadius: 10, display: 'grid', placeItems: 'center', background: '#ff3b5c', color: '#fff', fontSize: 8 }}>{thread.unread}</span>}
                                </button>;
                              })}
                              {!s.loading && !s.threads.length && <div style={{ color: '#dfe7ee', fontSize: 10, textAlign: 'center', padding: 12 }}>No conversations yet. Choose a friend or search for a member.</div>}
                            </>
                          )}
                          {s.sendError && (
                            <div style={{ fontSize: 10, color: '#ff5c7a', textAlign: 'center', padding: '2px 0' }}>{s.sendError}</div>
                          )}
                        </div>
                      )}

                      {s.tab === 'chirp' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                          <div style={{ color: '#e9eff4', fontSize: 10.5, lineHeight: 1.45 }}>Live push-to-talk with friends. Chirps are not stored as recordings.</div>
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
                                style={{ border: 0, borderRadius: 8, padding: '7px 9px', background: person.chirpEnabled ? '#3d8bfd' : '#17242a', color: person.chirpEnabled ? '#fff' : '#c9d3dc', cursor: person.chirpEnabled ? 'pointer' : 'not-allowed', fontSize: 9, touchAction: 'none' }}>Hold Chirp</button>
                            </div>
                          ))}
                          {!s.people.length && CHIRPS.slice(0, 1).map(c => <div key={c.user} style={{ color: '#dfe7ee', fontSize: 10 }}>Your mutual friends will appear here when Chirp is enabled.</div>)}
                        </div>
                      )}

                      {s.tab === 'friends' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div style={{ color: '#e9eff4', fontSize: 10.5, lineHeight: 1.45 }}>Friends are members you follow who follow you back. Only friends can message, Chirp or call each other.</div>
                          {s.sendError && <div style={{ fontSize: 10, color: '#ff5c7a', textAlign: 'center', padding: '2px 0' }}>{s.sendError}</div>}
                          {s.people.map(person => {
                            const live = !!person.presence && !person.presence.stale && person.presence.state !== 'offline';
                            return (
                              <div key={`friend-${person.userId}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px', borderRadius: 11, background: '#0a1117' }}>
                                <a href={person.profileUrl || '#'} target="_top" title={`Open ${person.name}'s profile`} style={{ position: 'relative', flex: 'none', display: 'block', width: 32, height: 32 }}>
                                  {person.avatar ? <img src={person.avatar} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', display: 'block' }} /> : <span style={{ width: 32, height: 32, borderRadius: '50%', background: '#1c2730', display: 'grid', placeItems: 'center', fontSize: 11, color: '#c3ccd4' }}>{(person.name || '?').slice(0, 1).toUpperCase()}</span>}
                                  {live && <i style={{ position: 'absolute', right: -1, bottom: -1, width: 10, height: 10, borderRadius: '50%', background: acc.c, border: '2px solid #0a1117' }} />}
                                </a>
                                <span style={{ flex: 1, minWidth: 0 }}>
                                  <strong style={{ display: 'block', color: '#e8edf2', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{person.name}</strong>
                                  <small style={{ color: live ? acc.c : '#dfe7ee', fontSize: 9.5 }}>@{person.handle}{live ? ' · live' : ''}</small>
                                </span>
                                <button type="button" onClick={() => void this.openPerson(person)} title={`Message ${person.name}`} style={{ border: 0, borderRadius: 8, padding: '6px 9px', background: 'linear-gradient(140deg,#00e07a,#009c55)', color: '#06120c', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>Message</button>
                                <button type="button" onClick={() => void this.callFriend(person, false)} title={`Voice call ${person.name}`} aria-label={`Voice call ${person.name}`} style={{ border: 0, borderRadius: 8, padding: '6px 8px', background: '#17242a', color: '#c3ccd4', fontSize: 11, cursor: 'pointer' }}>☏</button>
                              </div>
                            );
                          })}
                          {!s.people.length && <div style={{ color: '#dfe7ee', fontSize: 10, textAlign: 'center', padding: 12 }}>No friends yet. When you and another member follow each other you become friends and they show up here.</div>}
                        </div>
                      )}

                      {s.tab === 'groups' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div style={{ color: '#e9eff4', fontSize: 10.5, lineHeight: 1.45 }}>Pick which group channels alert this phone the moment something is posted, and turn on Chirp to hear a group's voice pings wherever you are on the site.</div>
                          {s.groupsNote && <div style={{ padding: 8, borderRadius: 9, color: acc.c, background: '#0a1117', fontSize: 10, lineHeight: 1.4 }}>{s.groupsNote}</div>}
                          {s.groupsErr && <div style={{ fontSize: 10, color: '#ff5c7a', textAlign: 'center', padding: '2px 0' }}>{s.groupsErr}</div>}
                          {s.groups.map(g => {
                            const rec = s.groupsBusy === `rec:${g.id}`, sending = s.groupsBusy === `send:${g.id}`;
                            const lv = s.gkLive.find(l => l.gid === g.id); const liveOn = !!(lv && lv.joined && lv.speakers > 0); const liveTalk = !!(lv && lv.talking.length);
                            const mode = g.chirpRule?.mode || 'owner', users = g.chirpRule?.users || [];
                            const pill = (on: boolean, busy: boolean, label: string, onClick: () => void, title: string) => (
                              <button type="button" disabled={busy} onClick={onClick} title={title} aria-pressed={on}
                                style={{ border: 0, borderRadius: 999, padding: '5px 9px', fontSize: 9, fontWeight: 700, letterSpacing: .3, whiteSpace: 'nowrap', cursor: busy ? 'default' : 'pointer', background: on ? acc.c : '#131c26', color: on ? acc.fg : '#dfe7ee', opacity: busy ? .6 : 1 }}>{label}</button>
                            );
                            return (
                              <div key={`gk-${g.id}`} style={{ padding: '9px 10px', borderRadius: 12, background: '#0a1117', display: 'flex', flexDirection: 'column', gap: 7 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                  {g.icon ? <img src={g.icon} alt="" referrerPolicy="no-referrer" style={{ width: 28, height: 28, borderRadius: 8, objectFit: 'cover', flex: 'none' }} /> : <span style={{ width: 28, height: 28, borderRadius: 8, background: '#16232e', flex: 'none' }} />}
                                  <a href={g.url} target="_top" style={{ flex: 1, minWidth: 0, textDecoration: 'none' }}>
                                    <strong style={{ display: 'block', color: '#e8edf2', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.name}</strong>
                                    <small style={{ color: '#dfe7ee', fontSize: 9 }}>{g.role}{g.canChirp ? ' · has the mic' : ''}{liveOn ? <b style={{ marginLeft: 6, color: liveTalk ? '#ff8fa3' : '#00ff88' }}>{liveTalk ? '● TALKING LIVE' : '● LIVE'}</b> : null}</small>
                                  </a>
                                  {pill(g.alertsAll, s.groupsBusy === `${g.id}:0:alerts`, g.alertsAll ? '🔔 All on' : '🔔 All', () => void this.gkToggle(g, 0, 'alerts', !g.alertsAll), 'Alert this phone for every channel in the group')}
                                  {pill(g.chirp, s.groupsBusy === `${g.id}:0:chirp`, g.chirp ? '🔊 On' : '🔊 Chirp', () => void this.gkToggle(g, 0, 'chirp', !g.chirp), 'Hear this group\'s chirps anywhere on the site')}
                                </div>
                                {g.chirp && (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: .6, textTransform: 'uppercase', color: '#dfe7ee' }}>Hear chirps from</div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                      {[{ id: 0, label: 'All channels' }, ...g.channels.map(c => ({ id: c.id, label: (c.type === 'alerts' ? '🚨 ' : '# ') + c.name }))].map(c => {
                                        const on = c.id === 0 ? !(g.chirpChannels || []).length : (g.chirpChannels || []).includes(c.id);
                                        return <button key={`gkch-${c.id}`} type="button" disabled={s.groupsBusy === `pick:${g.id}`} onClick={() => void this.gkPick(g, 'channels', c.id)} style={{ border: '1px solid ' + (on ? acc.c : 'rgba(255,255,255,.12)'), borderRadius: 999, padding: '3px 8px', fontSize: 9, cursor: 'pointer', background: on ? 'rgba(0,255,136,.14)' : 'transparent', color: on ? '#e8edf2' : '#dfe7ee', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</button>;
                                      })}
                                    </div>
                                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: .6, textTransform: 'uppercase', color: '#dfe7ee' }}>Voices</div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                      {[{ id: 0, name: 'Everyone with the mic', avatar: '', role: '' }, ...(g.voices || [])].map(v => {
                                        const on = v.id === 0 ? !(g.chirpVoices || []).length : (g.chirpVoices || []).includes(v.id);
                                        return <button key={`gkv-${v.id}`} type="button" disabled={s.groupsBusy === `pick:${g.id}`} onClick={() => void this.gkPick(g, 'voices', v.id)} title={v.role} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid ' + (on ? acc.c : 'rgba(255,255,255,.12)'), borderRadius: 999, padding: '3px 8px', fontSize: 9, cursor: 'pointer', background: on ? 'rgba(0,255,136,.14)' : 'transparent', color: on ? '#e8edf2' : '#dfe7ee' }}>{v.avatar ? <img src={v.avatar} alt="" referrerPolicy="no-referrer" style={{ width: 14, height: 14, borderRadius: '50%', objectFit: 'cover' }} /> : null}{v.name}{v.role ? <small style={{ opacity: .7 }}>· {v.role}</small> : null}</button>;
                                      })}
                                    </div>
                                  </div>
                                )}
                                {g.canChirp && (
                                  <button type="button" disabled={sending}
                                    onPointerDown={ev => { ev.preventDefault(); ev.currentTarget.setPointerCapture?.(ev.pointerId); void this.gkRecStart(g); }}
                                    onPointerUp={ev => { ev.preventDefault(); this.gkRecStop(); }} onPointerCancel={() => this.gkRecStop()}
                                    onKeyDown={ev => { if ((ev.key === ' ' || ev.key === 'Enter') && !ev.repeat) { ev.preventDefault(); ev.stopPropagation(); void this.gkRecStart(g); } }}
                                    onKeyUp={ev => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); this.gkRecStop(); } }}
                                    onClick={ev => ev.preventDefault()} onContextMenu={ev => ev.preventDefault()} aria-label={`Hold to Chirp ${g.name}`}
                                    style={{ border: 0, borderRadius: 10, padding: '9px 10px', fontSize: 10.5, fontWeight: 700, cursor: 'pointer', background: rec ? '#ff3b5c' : sending ? '#17242a' : 'linear-gradient(140deg,#3d8bfd,#1f5fd0)', color: '#fff', userSelect: 'none', touchAction: 'none' }}>
                                    {rec ? `● Recording ${s.gkRecSec}s — release to send` : sending ? 'Sending…' : '🎙 Hold to Chirp the whole group'}
                                  </button>
                                )}
                                {g.canManage && (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5, fontSize: 9.5, color: '#e9eff4' }}>
                                    <span>Who can Chirp:</span>
                                    {([['owner', 'Only me'], ['staff', 'Admins & analysts'], ['members', 'Everyone'], ['list', 'Pick members']] as [string, string][]).map(([m, label]) => (
                                      <button key={m} type="button" disabled={s.groupsBusy === `perm:${g.id}`}
                                        onClick={() => { void this.gkSavePerms(g, m, users); if (m === 'list' && !g.members) void this.loadGroups(true); }}
                                        style={{ border: 0, borderRadius: 999, padding: '4px 8px', fontSize: 9, fontWeight: 700, cursor: 'pointer', background: mode === m ? acc.c : '#131c26', color: mode === m ? acc.fg : '#dfe7ee' }}>{label}</button>
                                    ))}
                                    {mode === 'list' && (g.members || []).map(m => {
                                      const on = users.includes(m.id);
                                      return (
                                        <button key={`gkm-${m.id}`} type="button" onClick={() => void this.gkSavePerms(g, 'list', on ? users.filter(x => x !== m.id) : [...users, m.id])}
                                          style={{ border: '1px solid ' + (on ? acc.c : 'rgba(255,255,255,.12)'), borderRadius: 999, padding: '3px 8px', fontSize: 9, cursor: 'pointer', background: on ? 'rgba(0,255,136,.12)' : 'transparent', color: on ? '#e8edf2' : '#dfe7ee' }}>{on ? '✓ ' : ''}{m.name}</button>
                                      );
                                    })}
                                    {mode === 'list' && !g.members && <span>loading members…</span>}
                                    {mode === 'list' && g.members && !g.members.length && <span>no other members yet</span>}
                                  </div>
                                )}
                                <details>
                                  <summary style={{ fontSize: 9.5, color: '#e9eff4', cursor: 'pointer' }}>Channels · {g.channels.filter(c => c.alerts).length} of {g.channels.length} alerting this phone</summary>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                                    {g.channels.map(c => (
                                      <div key={`gkc-${c.id}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <span style={{ flex: 1, minWidth: 0, fontSize: 10, color: c.alerts ? '#e8edf2' : '#dfe7ee', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.type === 'alerts' ? '🚨 ' : '# '}{c.name}</span>
                                        {pill(c.alerts, s.groupsBusy === `${g.id}:${c.id}:alerts` || g.alertsAll, c.alerts ? '🔔 on' : '🔕 off', () => void this.gkToggle(g, c.id, 'alerts', !c.own), g.alertsAll ? 'All channels are on for this group' : 'Alert this phone when this channel posts')}
                                      </div>
                                    ))}
                                  </div>
                                </details>
                              </div>
                            );
                          })}
                          {s.groupsLoaded && !s.groups.length && <div style={{ color: '#dfe7ee', fontSize: 10, textAlign: 'center', padding: 12 }}>You are not in any groups yet. Join one from the Groups page and it shows up here.</div>}
                          {!s.groupsLoaded && <div style={{ color: '#dfe7ee', fontSize: 10, textAlign: 'center', padding: 12 }}>Loading your groups…</div>}
                        </div>
                      )}

                      {s.tab === 'notifs' && (s.post || s.postItem) && (() => {
                        const post = s.post; const busy = s.postBusy;
                        const stamp = (d?: string) => d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
                        const pill = (label: string, on: boolean, click: () => void, disabled = false) => (
                          <button key={label} type="button" onClick={click} disabled={disabled}
                            style={{ flex: 1, border: on ? 'none' : '1px solid rgba(255,255,255,.12)', borderRadius: 999, padding: '7px 8px', fontSize: 10, fontWeight: 800, cursor: disabled ? 'default' : 'pointer', background: on ? acc.c : '#0e1721', color: on ? acc.fg : '#cfe4f7', opacity: disabled ? .6 : 1 }}>{label}</button>
                        );
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <button type="button" onClick={this.closePost} style={{ border: 0, borderRadius: 8, padding: '5px 9px', background: '#111a23', color: '#cfe4f7', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>‹ Alerts</button>
                              <span style={{ fontFamily: mono, fontSize: 8.5, letterSpacing: 1, color: '#5c6771' }}>{post ? (post.kind === 'article' ? 'ARTICLE' : 'POST') : 'LOADING'}</span>
                              {post && <a href={post.pageUrl} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto', fontFamily: mono, fontSize: 8.5, letterSpacing: 1, color: acc.c, textDecoration: 'none' }}>OPEN ON SITE →</a>}
                            </div>
                            {!post && <div style={{ color: '#dfe7ee', fontSize: 10, textAlign: 'center', padding: 14 }}>{busy === 'load' ? 'Loading the post…' : (s.postNote || 'Nothing here.')}</div>}
                            {post && (
                              <div style={{ borderRadius: 13, padding: '10px 12px', background: 'linear-gradient(160deg,#0b1620 0%,#081018 100%)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.05)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  {post.author.avatar
                                    ? <img src={post.author.avatar} alt="" referrerPolicy="no-referrer" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', flex: 'none', boxShadow: '0 0 0 1.5px rgba(93,185,255,.7)' }} />
                                    : <span style={{ width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center', background: '#17242a', color: acc.c, fontWeight: 800, flex: 'none' }}>{(post.author.name || '?').slice(0, 1)}</span>}
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ fontSize: 11.5, fontWeight: 700, color: '#5db9ff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{post.author.name}</div>
                                    <div style={{ fontFamily: mono, fontSize: 8.5, color: '#b3bfca' }}>{stamp(post.date)}</div>
                                  </div>
                                </div>
                                {post.title && <div style={{ fontSize: 12.5, fontWeight: 800, color: '#e8edf2', marginTop: 8, lineHeight: 1.35 }}>{post.title}</div>}
                                <div style={{ fontSize: 11.5, color: '#dbe4ec', lineHeight: 1.5, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{customEmojiText(post.text)}</div>
                                <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                                  {pill((post.liked ? '♥ Liked' : '♡ Like') + ' ' + post.likes, post.liked, () => void this.postAct('like'), !!busy)}
                                  {pill('Comment ' + post.comments, false, () => { const el = this._postReplyEl; if (el) el.focus(); }, false)}
                                  {pill('Share ' + post.shares, false, () => void this.sharePost(), !!busy)}
                                </div>
                                {s.postNote && <div style={{ fontFamily: mono, fontSize: 8.5, color: acc.c, marginTop: 6 }}>{s.postNote}</div>}
                              </div>
                            )}
                            {post && post.recent.length > 0 && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 120, overflowY: 'auto' }}>
                                {post.recent.map(c => (
                                  <div key={c.id} style={{ display: 'flex', gap: 7, padding: '6px 9px', borderRadius: 10, background: '#070d13' }}>
                                    {c.avatar ? <img src={c.avatar} alt="" referrerPolicy="no-referrer" style={{ width: 20, height: 20, borderRadius: '50%', objectFit: 'cover', flex: 'none' }} /> : <span style={{ width: 20, height: 20, borderRadius: '50%', background: '#17242a', flex: 'none' }} />}
                                    <div style={{ minWidth: 0, flex: 1 }}>
                                      <div style={{ fontSize: 10, fontWeight: 700, color: c.mine ? acc.c : '#c3ccd4' }}>{c.name} <span style={{ fontFamily: mono, fontSize: 8, color: '#b3bfca', fontWeight: 400 }}>{stamp(c.date)}</span></div>
                                      <div style={{ fontSize: 10.5, color: '#dbe4ec', lineHeight: 1.4, wordBreak: 'break-word' }}>{c.text}</div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                            {post && (
                              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
                                <textarea ref={el => { this._postReplyEl = el; }} value={s.postReply} rows={1} placeholder={'Reply to ' + post.author.name + '…'}
                                  onChange={e => this.setState({ postReply: e.target.value.slice(0, 1000) })}
                                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const text = s.postReply.trim(); if (text) void this.postAct('comment', { text }); } }}
                                  style={{ flex: 1, minWidth: 0, border: '1px solid #1e2831', borderRadius: 11, padding: '8px 10px', background: '#0a1117', color: '#e8edf2', fontSize: 11, lineHeight: '16px', fontFamily: 'inherit', resize: 'none', outline: 'none', maxHeight: 80 }} />
                                <button type="button" disabled={!s.postReply.trim() || !!busy} onClick={() => { const text = s.postReply.trim(); if (text) void this.postAct('comment', { text }); }}
                                  style={{ border: 0, borderRadius: 999, padding: '8px 12px', fontSize: 10, fontWeight: 800, cursor: 'pointer', background: acc.c, color: acc.fg, opacity: !s.postReply.trim() || busy ? .5 : 1 }}>{busy === 'comment' ? '…' : 'Reply'}</button>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {s.tab === 'notifs' && !s.post && !s.postItem && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {s.notifs.length > 0 && (
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, padding: '0 2px 2px' }}>
                              {s.notifs.some(n => n.unread) && (
                                <button type="button" onClick={() => void this.markAllRead()}
                                  style={{ border: '1px solid rgba(255,255,255,.12)', borderRadius: 999, padding: '5px 10px', fontSize: 9, fontWeight: 700, letterSpacing: .4, cursor: 'pointer', background: '#0e1721', color: '#cfe4f7' }}>
                                  Mark all read
                                </button>
                              )}
                              <button type="button" onClick={() => void this.clearAll()}
                                style={{ border: 0, borderRadius: 999, padding: '5px 10px', fontSize: 9, fontWeight: 700, letterSpacing: .4, cursor: 'pointer', background: acc.c, color: acc.fg }}>
                                Clear all
                              </button>
                            </div>
                          )}
                          {s.notifs.map((n, i) => (
                            <div key={n.id || i} onClick={() => void this.markNotification(n)}
                              style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 13, cursor: 'pointer', background: n.unread ? 'linear-gradient(160deg,#0b1620 0%,#081018 100%)' : '#070d13', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.04)' }}>
                              {n.actor?.avatar
                                ? <img src={n.actor.avatar} alt="" referrerPolicy="no-referrer" style={{ width: 26, height: 26, borderRadius: '50%', flex: 'none', objectFit: 'cover', boxShadow: '0 0 0 1.5px rgba(93,185,255,.7)' }} />
                                : <div style={{ width: 26, height: 26, borderRadius: 8, flex: 'none', background: n.tint, boxShadow: 'inset 0 1px 0 rgba(255,255,255,.25)' }} />}
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ fontSize: 11.5, fontWeight: 600, color: n.actor ? '#5db9ff' : '#e8edf2', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.title}</div>
                                <div style={{ fontSize: 11, color: '#dfe7ee', lineHeight: 1.45 }}>{n.text}</div>
                                {(n.link || n.type === 'dm') && <div style={{ fontFamily: mono, fontSize: 8.5, letterSpacing: 1, color: acc.c, marginTop: 4 }}>{n.type === 'dm' ? 'OPEN MESSAGE →' : n.type === 'live' ? 'WATCH LIVE →' : n.type === 'video' ? 'WATCH →' : n.type === 'follow' ? 'VIEW PROFILE →' : n.type === 'news' ? 'READ ON THE LOOP →' : n.type === 'mention' ? 'OPEN THE POST →' : (n.type === 'loop_bucks' || n.type === 'gift') ? 'OPEN WALLET →' : (n.type === 'group_alert' || n.type === 'group_chirp') ? 'OPEN THE GROUP →' : 'VIEW POST →'}</div>}
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, marginLeft: 'auto', flex: 'none' }}>
                                <div style={{ fontFamily: mono, fontSize: 8.5, color: '#b3bfca' }}>{n.time}</div>
                                {n.type === 'follow' && n.actor?.id && (n.canFollowBack || n.following) && (
                                  <button type="button" disabled={!n.canFollowBack} onClick={e => { e.stopPropagation(); void this.followBack(n); }}
                                    style={{ border: 0, borderRadius: 999, padding: '5px 9px', fontSize: 9, fontWeight: 700, cursor: n.canFollowBack ? 'pointer' : 'default', background: n.canFollowBack ? acc.c : '#131c26', color: n.canFollowBack ? acc.fg : '#dfe7ee' }}>
                                    {n.canFollowBack ? 'Follow back' : 'Following'}
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                          {!s.notifs.length && <div style={{ color: '#dfe7ee', fontSize: 10, textAlign: 'center', padding: 14 }}>No site alerts. You’re all caught up.</div>}
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
                              if (mo.key === 'room') { this.enterRoom(); return; }
                              if (mo.key === 'video' || mo.key === 'voice') {
                                // Show the pre-call screen — do NOT auto-dial. The user taps Call.
                                this.setState({ mode: mo.key, callVideo: mo.key === 'video' });
                                return;
                              }
                              this.setState({ mode: mo.key } as Pick<State, 'mode'>);
                            }}
                            style={{ flex: 1, padding: '6px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 9.5, fontWeight: 600, letterSpacing: 0.3, background: s.mode === mo.key ? acc.c : 'transparent', color: s.mode === mo.key ? acc.fg : '#dfe7ee', whiteSpace: 'nowrap', transition: 'background .18s, color .18s' }}>{mo.label}</button>
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
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-end', padding: '9px 13px', borderRadius: 13, background: '#0a1117', boxShadow: 'inset 0 1px 3px rgba(0,0,0,.6)' }}>
                          <textarea ref={this.mountComposer} value={s.draft} rows={1} spellCheck
                            placeholder={s.mode === 'room' ? 'Say something in the room…' : 'Type a message…'}
                            onChange={e => { this.setState({ draft: e.target.value.slice(0, 4000) }); this.growComposer(e.target); }}
                            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } }}
                            style={{ flex: 1, minWidth: 0, display: 'block', border: 0, outline: 'none', resize: 'none', background: 'transparent', color: '#e8edf2', fontSize: 12, lineHeight: '17px', fontFamily: 'inherit', padding: 0, margin: 0, height: 17, maxHeight: 119, overflowY: 'auto', caretColor: acc.c, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} />
                        </div>
                        <div className="lk-send" onClick={() => this.send()} style={{ width: 40, height: 40, borderRadius: '50%', flex: 'none', cursor: 'pointer', background: accentGrad, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 4px 12px ${acc.c}44, inset 0 1px 0 rgba(255,255,255,.4)` }}>
                          <span style={{ width: 0, height: 0, borderLeft: `11px solid ${acc.fg}`, borderTop: '6.5px solid transparent', borderBottom: '6.5px solid transparent', marginLeft: 3 }} />
                        </div>
                      </div>
                    )}

                    {/* ticker voice room — the terminal's live voice chart room, joined from the phone */}
                    {s.mode === 'room' && (() => {
                      const tr = s.tr; const room = tr.room; const members = room ? (room.members || []) : [];
                      const joined = tr.phase === 'joined';
                      const btn = (label: string, bg: string, fg: string, onClick: () => void, disabled = false) => (
                        <button key={label} onClick={onClick} disabled={disabled} style={{ padding: '8px 12px', borderRadius: 999, border: bg === 'transparent' ? '1px solid #1e2831' : 'none', cursor: disabled ? 'default' : 'pointer', fontSize: 11, fontWeight: 700, background: bg, color: fg, opacity: disabled ? .55 : 1 }}>{label}</button>
                      );
                      return (
                        <div style={{ borderRadius: 13, background: '#05090d', boxShadow: 'inset 0 1px 3px rgba(0,0,0,.5)', overflow: 'hidden' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 11px', borderBottom: '1px solid #0f1720' }}>
                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: joined ? acc.c : '#5c6771', boxShadow: joined ? `0 0 6px ${acc.c}` : 'none' }} />
                            <span style={{ fontSize: 11, fontWeight: 600, color: '#e8edf2' }}>{tr.symbol ? `$${tr.symbol} Live Voice Room` : 'Ticker Voice Rooms'}</span>
                            <span style={{ fontFamily: mono, fontSize: 9, color: room && room.count ? acc.c : '#5c6771', marginLeft: 'auto' }}>{room ? `${room.count} live` : ''}</span>
                          </div>
                          <div style={{ display: 'flex', gap: 6, padding: '8px 10px 4px' }}>
                            <input value={s.trInput} onChange={e => this.setState({ trInput: e.target.value.toUpperCase() })} onKeyDown={e => { if (e.key === 'Enter') this.roomLook(); }} placeholder="Type a ticker, e.g. SPY" maxLength={12}
                              style={{ flex: 1, minWidth: 0, background: '#0a1117', border: '1px solid #1e2831', borderRadius: 9, padding: '8px 10px', color: '#e8edf2', fontSize: 12, outline: 'none', fontFamily: mono, letterSpacing: 1 }} />
                            {btn(tr.phase === 'looking' && !room ? '…' : 'Look', '#131d26', '#e8edf2', () => this.roomLook())}
                          </div>
                          <div style={{ padding: '4px 10px 8px', minHeight: 96 }}>
                            {!tr.symbol && <div style={{ fontSize: 10.5, color: '#dfe7ee', lineHeight: 1.5, padding: '10px 2px' }}>Every ticker terminal has a live voice chart room. Type a ticker to see who is in it before you join.</div>}
                            {tr.error && <div style={{ fontSize: 10.5, color: '#ff5c7a', padding: '4px 2px' }}>{tr.error}</div>}
                            {tr.symbol && room && !members.length && <div style={{ fontSize: 10.5, color: '#dfe7ee', padding: '8px 2px' }}>No traders in ${tr.symbol} right now. Be the first.</div>}
                            {members.slice(0, 12).map(m => (
                              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 2px' }}>
                                <img src={m.avatar_url} alt="" width={26} height={26} style={{ width: 26, height: 26, borderRadius: '50%', objectFit: 'cover', flex: 'none', background: '#131d26', boxShadow: m.speaking ? `0 0 0 2px ${acc.c}` : 'none' }} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 11.5, fontWeight: 600, color: '#e8edf2', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}{room && m.id === room.current_user_id ? ' (you)' : ''}</div>
                                  <div style={{ fontSize: 9.5, color: '#dfe7ee' }}>{m.mode === 'speaker' ? (m.muted ? 'Muted speaker' : 'Speaker') : 'Listening'}</div>
                                </div>
                                <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.speaking ? acc.c : '#2a343d', boxShadow: m.speaking ? `0 0 8px ${acc.c}` : 'none', flex: 'none' }} />
                              </div>
                            ))}
                          </div>
                          <div ref={el => this.tickerRoom.setAudioHost(el)} style={{ display: 'none' }} />
                          {tr.symbol && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8, padding: '4px 10px 11px' }}>
                              {!joined && btn(tr.phase === 'joining' ? 'Joining…' : 'Join with mic', acc.c, acc.fg, () => this.roomJoin('speaker'), tr.phase === 'joining')}
                              {!joined && btn('Listen', '#131d26', '#e8edf2', () => this.roomJoin('listener'), tr.phase === 'joining')}
                              {joined && tr.mode === 'speaker' && btn(tr.muted ? 'Unmute' : 'Mute', tr.muted ? '#ff5c7a' : '#131d26', tr.muted ? '#fff' : '#e8edf2', this.roomMute)}
                              {joined && btn('Leave', 'linear-gradient(140deg,#ff5c7a,#d42a4c)', '#fff', this.leaveRoom)}
                              {btn('Open terminal ↗', 'transparent', '#dfe7ee', this.roomOpenTerminal)}
                            </div>
                          )}
                          {joined && tr.mode === 'speaker' && (
                            <div style={{ height: 3, margin: '0 10px 10px', borderRadius: 2, background: '#0f1720' }}><div style={{ height: '100%', width: `${tr.level}%`, borderRadius: 2, background: acc.c, transition: 'width .08s' }} /></div>
                          )}
                        </div>
                      );
                    })()}

                    {/* watch */}
                    {s.mode === 'watch' && (() => {
                      const wd = s.watchData;
                      const item = s.watchItem;
                      const vidSrc = item && item.src ? item.src : '';
                      const ytId = item && !vidSrc && item.ytId ? item.ytId : '';
                      const hasMedia = !!(vidSrc || ytId);
                      const isLive = !!item && item.kind === 'live';
                      const title = item ? item.title : 'Loop Channel';
                      const sub = item ? (isLive ? `LIVE · ${item.creator || 'Loop Desk'}` : `${item.creator || 'Loop Channel'}${item.date ? ' · ' + item.date : ''}`) : 'Videos and live streams from the Loop Channel';
                      const q = s.watchQ.trim();
                      const rows: WatchItem[] = wd ? (q ? [...wd.live, ...wd.videos] : wd.live) : [];
                      const fmt = (n?: number) => { const t = Math.max(0, Math.round(n || 0)); const m = Math.floor(t / 60), sec = t % 60; return t ? `${m}:${sec < 10 ? '0' : ''}${sec}` : ''; };
                      return (
                      <div style={{ borderRadius: 13, overflow: 'hidden', background: '#0a1117', boxShadow: 'inset 0 1px 3px rgba(0,0,0,.5)' }}>
                        <div style={{ height: 118, position: 'relative', background: item && item.poster ? `#000 url(${item.poster}) center/cover no-repeat` : 'repeating-linear-gradient(135deg,#0d141b 0 12px,#090f15 12px 24px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {vidSrc && s.playing && (
                            <video key={item!.id + '|' + vidSrc} ref={this.mountWatch} playsInline controls={false} poster={item!.poster || undefined}
                              onClick={this.unmuteWatch}
                              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} />
                          )}
                          {ytId && s.playing && (
                            <iframe key={ytId} src={`https://www.youtube-nocookie.com/embed/${ytId}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1`}
                              allow="autoplay; encrypted-media; picture-in-picture" title="Loop live stream"
                              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, background: '#000' }} />
                          )}
                          {!hasMedia && (
                            <div style={{ padding: '0 18px', textAlign: 'center', fontSize: 10.5, lineHeight: 1.5, color: '#dfe7ee' }}>
                              {wd ? 'Search below for a Loop Channel video or live stream, or tap the mini button on any watch page.' : 'Loading the Loop Channel…'}
                            </div>
                          )}
                          {hasMedia && (
                            <div className="lk-play" onClick={() => this.setState(prev => ({ playing: !prev.playing }))} style={{ width: 42, height: 42, borderRadius: '50%', background: 'rgba(0,0,0,.55)', border: `1px solid ${acc.c}88`, display: s.playing ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 4, position: 'relative' }}>
                              <span style={{ width: 0, height: 0, borderLeft: `13px solid ${acc.c}`, borderTop: '8px solid transparent', borderBottom: '8px solid transparent', marginLeft: 3 }} />
                            </div>
                          )}
                          {hasMedia && s.playing && (
                            <div onClick={() => this.setState({ playing: false })} title="Pause"
                              style={{ position: 'absolute', top: 26, left: 8, zIndex: 3, padding: '3px 7px', borderRadius: 6, background: 'rgba(0,0,0,.6)', fontFamily: mono, fontSize: 8.5, color: '#e9eff4', cursor: 'pointer' }}>❚❚</div>
                          )}
                          {hasMedia && s.playing && s.watchNeedTap && (
                            <div onClick={this.unmuteWatch}
                              style={{ position: 'absolute', bottom: 8, left: 8, zIndex: 4, padding: '4px 9px', borderRadius: 999, background: acc.c, color: acc.fg, fontSize: 9, fontWeight: 800, letterSpacing: .3, cursor: 'pointer' }}>🔇 Tap for sound</div>
                          )}
                          {isLive ? (
                            <span style={{ position: 'absolute', top: 7, left: 8, zIndex: 3, display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 6, background: 'rgba(0,0,0,.6)', fontFamily: mono, fontSize: 8.5, letterSpacing: 1, color: '#ff5c7a' }}>
                              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#ff3b5c' }} />LIVE
                            </span>
                          ) : item ? (
                            <span style={{ position: 'absolute', top: 7, left: 8, zIndex: 3, padding: '3px 8px', borderRadius: 6, background: 'rgba(0,0,0,.6)', fontFamily: mono, fontSize: 8.5, letterSpacing: 1, color: '#5c6771' }}>LOOP CHANNEL</span>
                          ) : null}
                          {isLive && <span style={{ position: 'absolute', top: 7, right: 8, zIndex: 3, padding: '3px 8px', borderRadius: 6, background: 'rgba(0,0,0,.6)', fontFamily: mono, fontSize: 8.5, color: '#e9eff4' }}>{s.viewers.toLocaleString()} watching</span>}
                        </div>
                        <div onClick={() => { if (item && item.url) window.open(item.url, '_blank', 'noopener'); }} title={item ? 'Open the full watch page' : undefined}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px', cursor: item ? 'pointer' : 'default' }}>
                          <div style={{ width: 22, height: 22, borderRadius: 7, flex: 'none', background: 'linear-gradient(140deg,#b98cff,#8a55e0)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.25)' }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#e8edf2', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
                            <div style={{ fontSize: 9.5, color: '#5c6771', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>
                          </div>
                        </div>
                        {/* search only — no library under the player (owner call 2026-09-06) */}
                        <div style={{ borderTop: '1px solid rgba(255,255,255,.05)', padding: '7px 9px 9px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 9px', borderRadius: 9, background: '#070d13', boxShadow: 'inset 0 1px 2px rgba(0,0,0,.6)' }}>
                            <span style={{ color: '#5c6771', fontSize: 11 }}>⌕</span>
                            <input value={s.watchQ} onChange={e => this.searchWatch(e.target.value)} placeholder="Search Loop Channel videos & live streams"
                              style={{ flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent', color: '#e8edf2', fontSize: 10.5, fontFamily: 'inherit' }} />
                            {q && <span onClick={() => this.searchWatch('')} style={{ color: '#5c6771', fontSize: 11, cursor: 'pointer' }}>✕</span>}
                          </div>
                          {rows.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 118, overflowY: 'auto', marginTop: 6 }}>
                              {rows.map(r => {
                                const on = !!item && item.id === r.id;
                                return (
                                  <div key={r.id} onClick={() => this.playWatch(r)}
                                    style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 6px', borderRadius: 8, cursor: 'pointer', background: on ? 'rgba(255,255,255,.05)' : 'transparent' }}>
                                    {r.poster
                                      ? <img src={r.poster} alt="" referrerPolicy="no-referrer" style={{ width: 34, height: 20, borderRadius: 4, objectFit: 'cover', flex: 'none', background: '#000' }} />
                                      : <span style={{ width: 34, height: 20, borderRadius: 4, flex: 'none', background: r.kind === 'live' ? 'linear-gradient(140deg,#ff3b5c,#7a1230)' : '#131c26', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: mono, fontSize: 7.5, color: '#fff' }}>{r.kind === 'live' ? (r.status === 'scheduled' ? 'SOON' : 'LIVE') : '▶'}</span>}
                                    <span style={{ fontSize: 10.5, color: on ? acc.c : '#c3ccd4', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{r.title}</span>
                                    <span style={{ fontFamily: mono, fontSize: 8.5, color: r.kind === 'live' ? '#ff5c7a' : '#5c6771', flex: 'none' }}>{r.kind === 'live' ? (r.status === 'scheduled' ? 'SCHEDULED' : 'LIVE') : (fmt(r.duration) || r.date || '')}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {q && wd && rows.length === 0 && <div style={{ fontSize: 10, color: '#5c6771', padding: '8px 4px 0' }}>Nothing on the Loop Channel matches “{q}”.</div>}
                          {!q && wd && rows.length === 0 && <div style={{ fontSize: 9.5, color: '#5c6771', padding: '7px 4px 0' }}>Type a ticker, title or creator. {wd.videos.length ? `${wd.videos.length} videos indexed.` : ''}</div>}
                        </div>
                      </div>
                      );
                    })()}

                    {/* video call — real getUserMedia + WebRTC */}
                    {s.mode === 'video' && (
                      <div style={{ borderRadius: 13, overflow: 'hidden', position: 'relative', background: '#05090d', boxShadow: 'inset 0 1px 3px rgba(0,0,0,.5)' }}>
                        <div style={{ position: 'relative', height: 168, background: 'radial-gradient(320px 160px at 50% 32%, #14222e 0%, #05090d 78%)' }}>
                          <video ref={el => { this._remoteEl = el; this.attachStream(el, this._remoteStream, false); }} autoPlay playsInline
                            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: s.callPhase === 'connected' ? 1 : 0, transition: 'opacity .3s' }} />
                          {s.callPhase !== 'connected' && (
                            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 9, padding: 12, textAlign: 'center' }}>
                              <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'linear-gradient(140deg,#20303c,#101820)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 700, color: acc.c, boxShadow: `0 0 0 2px ${acc.c}40` }}>{calleeName.slice(0, 1).toUpperCase()}</div>
                              <div style={{ fontSize: 11.5, fontWeight: 600, color: '#e8edf2' }}>{calleeName}</div>
                              <div style={{ fontFamily: mono, fontSize: 9.5, color: s.callError ? '#ff5c7a' : acc.c }}>{s.callError || (s.callPhase === 'calling' ? 'Calling…' : s.callPhase === 'connecting' ? 'Connecting…' : 'Video call')}</div>
                              {preCall && <button onClick={() => this.startCall(true)} style={{ marginTop: 4, padding: '9px 26px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, background: acc.c, color: acc.fg }}>📹 Call {calleeName.split(' ')[0]}</button>}
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
                          {s.camOff && <div style={{ position: 'absolute', right: 8, bottom: 8, width: 58, height: 82, borderRadius: 9, background: '#0b1218', border: '1px solid #1e2831', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: mono, fontSize: 7, color: '#b3bfca' }}>CAM OFF</div>}
                        </div>
                        {!preCall && (
                          <div style={{ display: 'flex', justifyContent: 'center', gap: 10, padding: '9px 0 10px' }}>
                            {callBtn('M', s.muted ? '#ff5c7a' : '#131d26', s.muted ? '#fff' : '#e9eff4', this.toggleMute)}
                            {callBtn('V', s.camOff ? '#ff5c7a' : '#131d26', s.camOff ? '#fff' : '#e9eff4', this.toggleCam)}
                            {callBtn('✕', 'linear-gradient(140deg,#ff5c7a,#d42a4c)', '#fff', this.endCall, true)}
                          </div>
                        )}
                      </div>
                    )}

                    {/* voice call — real getUserMedia + WebRTC (audio) */}
                    {s.mode === 'voice' && (
                      <div style={{ borderRadius: 13, overflow: 'hidden', background: '#0a1117', boxShadow: 'inset 0 1px 3px rgba(0,0,0,.5)', padding: '14px 12px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9 }}>
                        <video ref={el => { this._remoteEl = el; this.attachStream(el, this._remoteStream, false); }} autoPlay playsInline style={{ display: 'none' }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%' }}>
                          <div style={{ width: 40, height: 40, borderRadius: '50%', flex: 'none', background: 'linear-gradient(140deg,#20303c,#101820)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, color: acc.c, boxShadow: `0 0 0 2px ${acc.c}40` }}>{calleeName.slice(0, 1).toUpperCase()}</div>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: '#e8edf2' }}>{calleeName}</div>
                            <div style={{ fontFamily: mono, fontSize: 9.5, color: s.callError ? '#ff5c7a' : acc.c }}>{s.callError || (s.callPhase === 'connected' ? `Voice · ${callTime}` : s.callPhase === 'calling' ? 'Calling…' : s.callPhase === 'connecting' ? 'Connecting…' : 'Voice call')}</div>
                          </div>
                          {s.callPhase === 'connected' && (
                            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'flex-end', gap: 2.5, height: 22 }}>
                              {[8, 16, 11, 19, 9].map((h, i) => (
                                <span key={i} style={{ width: 3, height: h, borderRadius: 2, background: acc.c, animation: `wave .9s ease-in-out ${i * 0.15}s infinite` }} />
                              ))}
                            </div>
                          )}
                        </div>
                        {preCall ? (
                          <button onClick={() => this.startCall(false)} style={{ padding: '9px 26px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, background: acc.c, color: acc.fg }}>📞 Call {calleeName.split(' ')[0]}</button>
                        ) : (
                          <div style={{ display: 'flex', justifyContent: 'center', gap: 10, paddingTop: 2 }}>
                            {callBtn('M', s.muted ? '#ff5c7a' : '#131d26', s.muted ? '#fff' : '#e9eff4', this.toggleMute)}
                            {callBtn('S', s.speaker ? acc.c : '#131d26', s.speaker ? acc.fg : '#e9eff4', () => this.setState(p => ({ speaker: !p.speaker })))}
                            {callBtn('✕', 'linear-gradient(140deg,#ff5c7a,#d42a4c)', '#fff', this.endCall, true)}
                          </div>
                        )}
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
                              style={{ flex: 1, padding: '6px 0', borderRadius: 8, cursor: 'pointer', background: f.key === s.font ? '#131d26' : '#04090e', border: `1px solid ${f.key === s.font ? acc.c : '#1e2831'}`, color: f.key === s.font ? '#e8edf2' : '#dfe7ee', fontFamily: f.stack, fontSize: 10.5, whiteSpace: 'nowrap' }}>{f.label}</button>
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
                            <span style={{ flex: 1, fontFamily: mono, fontSize: 8, letterSpacing: 1.1, color: '#dfe7ee' }}>{label}</span>
                            <button onClick={() => void this.togglePreference(key)} style={{ width: 34, height: 19, padding: 2, border: 0, borderRadius: 10, cursor: 'pointer', background: s.preferences[key] ? acc.c : '#242c34' }}><span style={{ display: 'block', width: 15, height: 15, borderRadius: '50%', background: '#fff', transform: `translateX(${s.preferences[key] ? 15 : 0}px)`, transition: 'transform .18s' }} /></button>
                          </div>
                        ))}
                        {([
                          ['chirp_enabled', 'CHIRP ENABLED'],
                          ['dnd', 'CHIRP DO NOT DISTURB'],
                        ] as const).map(([key, label]) => (
                          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ flex: 1, fontFamily: mono, fontSize: 8, letterSpacing: 1.1, color: '#dfe7ee' }}>{label}</span>
                            <button onClick={() => void this.toggleChirpPreference(key)} style={{ width: 34, height: 19, padding: 2, border: 0, borderRadius: 10, cursor: 'pointer', background: s.chirpPrefs[key] ? acc.c : '#242c34' }}><span style={{ display: 'block', width: 15, height: 15, borderRadius: '50%', background: '#fff', transform: `translateX(${s.chirpPrefs[key] ? 15 : 0}px)`, transition: 'transform .18s' }} /></button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* folded cover */}
                    {coverVisible && (
                      <div onClick={() => { this.scrollBottom(); this.setState(p => ({ slid: !p.slid })); }} style={{ display: 'flex', flexDirection: 'column', gap: 8, cursor: 'pointer' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1px 2px' }}>
                          <span style={{ fontFamily: "'Archivo',sans-serif", fontSize: 9, letterSpacing: 2, color: '#b3bfca' }}>LOOP-KICK</span>
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
                              <div style={{ fontSize: 10, color: '#dfe7ee', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.text}</div>
                            </div>
                            <div style={{ fontFamily: mono, fontSize: 8.5, color: '#b3bfca', flex: 'none' }}>{n.time}</div>
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
