/**
 * LOOP-KICK phone — faithful React port of `Loop Kick Phone.dc.html`,
 * wired into the message system via src/transport.ts.
 *
 * The original design's DCLogic class maps almost 1:1 onto a React class
 * component; state keys, mode names, and style values are kept verbatim so
 * the rendered device matches the approved design.
 */
import React from 'react';
import { createTransport, Transport, WireMessage } from './transport';

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

/* ---------------- types ---------------- */

interface ThreadMsg { from: 'me' | 'them'; text: string; }
interface Notif { title: string; text: string; time: string; tint: string; unread: boolean; }
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
}

const S: Record<string, React.CSSProperties> = {}; // populated in render helpers below

export default class LoopKickPhone extends React.Component<{}, State> {
  state: State = {
    open: false,
    slid: false,
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
      { title: 'Sarah', text: 'Are you free tonight?', time: '2m', tint: NOTIF_TINTS[0], unread: true },
      { title: 'Alex', text: 'Check out these pics!', time: '14m', tint: NOTIF_TINTS[1], unread: true },
      { title: 'Mike', text: "Let's meet up later", time: '38m', tint: NOTIF_TINTS[2], unread: true },
      { title: 'Loop Live', text: 'Market open stream starts in 10 minutes', time: '1h', tint: NOTIF_TINTS[3], unread: false },
    ],
    vh: typeof window !== 'undefined' ? window.innerHeight : 900,
    sendError: '',
  };

  private transport: Transport = createTransport();
  private _wantScroll = false;
  private _interval: ReturnType<typeof setInterval> | null = null;
  private _roomTick = 0;
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

  scrollBottom() { this._wantScroll = true; }

  componentDidUpdate() {
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

    /* ---- message system: initial load + live stream ---- */
    this.transport.load()
      .then(list => this.setState({ thread: list.map(this.wireToThread) }))
      .catch(err => {
        console.error('LOOP-KICK:', err.message);
        this.setState({ sendError: 'Could not load messages.' });
      })
      .finally(() => this.transport.connect(this.onIncoming));

    /* ---- design's ambient simulations (watch/call/room) ---- */
    this._interval = setInterval(() => {
      const s = this.state;
      if (!s.open || !s.slid) return;
      if (s.mode === 'watch' && s.playing) {
        this.setState(p => ({ watchSec: p.watchSec + 1, viewers: p.viewers + (Math.random() < 0.3 ? 1 : 0) }));
      }
      if (s.mode === 'video' || s.mode === 'voice') {
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
    this.transport.disconnect();
  }

  /* ---------------- message system wiring ---------------- */

  private wireToThread = (m: WireMessage): ThreadMsg => ({
    from: m.mine ? 'me' : 'them',
    text: m.text,
  });

  /** Incoming message (WebSocket in live mode, canned reply in mock). */
  private onIncoming = (m: WireMessage) => {
    if (!m || !m.text) return;
    const s = this.state;
    const seen = s.open && s.slid && s.tab === 'messages';
    this.scrollBottom();
    this.setState(p => ({
      thread: [...p.thread, this.wireToThread(m)],
      notifs: seen
        ? p.notifs
        : [
            {
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
    if (!text) return;
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
      thread: [...p.thread, { from: 'me', text }],
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
    const vh = s.vh || 900;
    const screen = Math.max(110, Math.min(s.slid ? 200 : 250, vh - (s.slid ? 460 : 200)));
    const acc = ACCENT_OPTS.find(a => a.c === s.accent) || ACCENT_OPTS[0];
    const accentGrad = `linear-gradient(140deg,${acc.c},${acc.d})`;
    const bgOf = (key: string) => (BG_OPTS.find(b => b.key === key) || BG_OPTS[0]).bg(acc.c);
    const deviceFont = (FONT_OPTS.find(f => f.key === s.font) || FONT_OPTS[0]).stack;
    const openTo = (tab: State['tab']) => () => { this.scrollBottom(); this.setState({ open: true, slid: true, tab }); };
    const showComposer = (s.mode === 'compose' && s.slid) || s.mode === 'room';
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
        {/* ---- dock ---- */}
        <div onClick={() => { this.scrollBottom(); this.setState(p => ({ open: !p.open })); }}
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
        <div style={{ position: 'fixed', right: 30, bottom: 30, zIndex: 80, display: s.open ? 'block' : 'none', maxHeight: 'calc(100vh - 44px)', perspective: 1400, ['--acc' as string]: acc.c }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', transform: 'rotateX(5deg) rotateY(-4deg)', transformStyle: 'preserve-3d', fontFamily: deviceFont, filter: 'drop-shadow(0 44px 40px rgba(0,0,0,.66)) drop-shadow(0 10px 14px rgba(0,0,0,.5))' }}>

            {/* ---- top fold ---- */}
            <div style={{ height: s.slid ? screen + 148 : 0, overflow: 'visible', transition: 'height .42s cubic-bezier(.2,.8,.25,1)', display: 'flex', alignItems: 'flex-end' }}>
              <div style={{ width: 352, position: 'relative', borderRadius: 30, padding: 3, background: 'linear-gradient(150deg,#5c6771 0%,#20262d 22%,#0c0f13 50%,#2a323c 80%, #48515c 100%)', boxShadow: 'inset 0 1px 1px rgba(255,255,255,.35)', zIndex: 2, transformOrigin: 'center bottom', transform: s.slid ? 'rotateX(0deg)' : 'rotateX(-89deg)', opacity: s.slid ? 1 : 0, pointerEvents: s.slid ? 'auto' : 'none', transition: 'transform .42s cubic-bezier(.2,.8,.25,1), opacity .32s ease' }}>
                <div style={{ position: 'absolute', right: -3, top: 70, width: 4, height: 52, borderRadius: '0 3px 3px 0', background: acc.c, boxShadow: `1px 0 3px ${acc.c}66` }} />
                <div style={{ position: 'absolute', right: -3, top: 134, width: 4, height: 70, borderRadius: '0 3px 3px 0', background: 'linear-gradient(#39424c,#12161b)' }} />
                <div style={{ position: 'absolute', left: -3, top: 92, width: 4, height: 40, borderRadius: '3px 0 0 3px', background: 'linear-gradient(#39424c,#12161b)' }} />

                <div style={{ borderRadius: 27, background: '#010304', padding: '10px 10px 12px', position: 'relative', overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', inset: 0, borderRadius: 27, background: 'linear-gradient(118deg, rgba(255,255,255,.09) 0%, rgba(255,255,255,.025) 22%, transparent 40%, transparent 78%, rgba(255,255,255,.05) 100%)', pointerEvents: 'none', zIndex: 6 }} />

                  {/* notch row */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '2px 0 8px', position: 'relative' }}>
                    <span style={{ width: 34, height: 4, borderRadius: 3, background: 'linear-gradient(#1c2229,#0d1116)', boxShadow: 'inset 0 1px 2px rgba(0,0,0,.8)' }} />
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'radial-gradient(circle at 34% 30%, #2c4a63 0%, #0a1017 55%, #000 100%)', boxShadow: 'inset 0 0 2px #000, 0 0 3px rgba(66,135,245,.28)' }} />
                    <div className="lk-x" onClick={() => this.setState({ open: false, slid: false })} style={{ position: 'absolute', right: 2, top: 0, width: 19, height: 19, borderRadius: '50%', color: '#5c6771', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>×</div>
                  </div>

                  {/* top screen */}
                  <div style={{ borderRadius: 18, overflow: 'hidden', background: bgOf(s.topBgKey), position: 'relative', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.045)' }}>
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
                    <div style={{ display: 'flex', gap: 4, margin: '8px 12px 10px', padding: 3, borderRadius: 12, background: '#0a1117' }}>
                      {([
                        { key: 'messages', label: 'Messages', badge: 2 },
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
                          <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '2px 2px 9px' }}>
                            <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'linear-gradient(140deg,#20303c,#101820)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#00ff88', flex: 'none', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.08)' }}>S</div>
                            <div>
                              <div style={{ fontSize: 12.5, fontWeight: 600, color: '#e8edf2' }}>Sarah</div>
                              <div style={{ fontSize: 9.5, color: acc.c }}>online now</div>
                            </div>
                          </div>
                          {s.thread.map((m, i) => m.from === 'me' ? (
                            <div key={i} style={{ display: 'flex', justifyContent: 'flex-end', animation: 'msgIn .2s ease' }}>
                              <div style={{ maxWidth: '80%', padding: '8px 12px', borderRadius: '15px 15px 4px 15px', fontSize: 12, lineHeight: 1.5, background: accentGrad, color: acc.fg, boxShadow: `0 3px 10px ${acc.c}2e` }}>{m.text}</div>
                            </div>
                          ) : (
                            <div key={i} style={{ display: 'flex', justifyContent: 'flex-start', animation: 'msgIn .2s ease' }}>
                              <div style={{ maxWidth: '80%', padding: '8px 12px', borderRadius: '15px 15px 15px 4px', fontSize: 12, lineHeight: 1.5, background: '#111a23', color: '#dbe4ec', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.05)' }}>{m.text}</div>
                            </div>
                          ))}
                          {s.sendError && (
                            <div style={{ fontSize: 10, color: '#ff5c7a', textAlign: 'center', padding: '2px 0' }}>{s.sendError}</div>
                          )}
                        </div>
                      )}

                      {s.tab === 'chirp' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                          {CHIRPS.map((c, i) => (
                            <div key={i} style={{ padding: '10px 12px', borderRadius: 13, background: 'linear-gradient(160deg,#0a1219 0%,#070d13 100%)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.04)' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                                <span style={{ fontSize: 11, fontWeight: 600, color: '#e8edf2' }}>{c.user}</span>
                                <span style={{ fontFamily: mono, fontSize: 9.5, color: '#00ff88' }}>{c.ticker}</span>
                                <span style={{ fontFamily: mono, fontSize: 9, color: '#4a545e', marginLeft: 'auto' }}>{c.time}</span>
                              </div>
                              <div style={{ fontSize: 11.5, color: '#98a3ad', lineHeight: 1.5 }}>{c.text}</div>
                            </div>
                          ))}
                        </div>
                      )}

                      {s.tab === 'notifs' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {s.notifs.map((n, i) => (
                            <div key={i} onClick={() => this.setState(p => ({ notifs: p.notifs.map((x, j) => j === i ? { ...x, unread: false } : x) }))}
                              style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 13, cursor: 'pointer', background: n.unread ? 'linear-gradient(160deg,#0b1620 0%,#081018 100%)' : '#070d13', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.04)' }}>
                              <div style={{ width: 26, height: 26, borderRadius: 8, flex: 'none', background: n.tint, boxShadow: 'inset 0 1px 0 rgba(255,255,255,.25)' }} />
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 11.5, fontWeight: 600, color: '#e8edf2', marginBottom: 2 }}>{n.title}</div>
                                <div style={{ fontSize: 11, color: '#7e8a96', lineHeight: 1.45 }}>{n.text}</div>
                              </div>
                              <div style={{ fontFamily: mono, fontSize: 8.5, color: '#4a545e', marginLeft: 'auto', flex: 'none' }}>{n.time}</div>
                            </div>
                          ))}
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
            <div style={{ width: 330, transformOrigin: 'top center', transform: 'rotateX(0deg)', opacity: 1, transition: 'transform .42s cubic-bezier(.2,.8,.25,1), opacity .3s ease', borderRadius: 26, padding: 3, background: 'linear-gradient(210deg,#4c555f 0%,#1b2127 25%,#0b0e12 55%,#2c343d 100%)', boxShadow: 'inset 0 1px 1px rgba(255,255,255,.28)', pointerEvents: 'auto' }}>
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
                              const reset = (mo.key === 'video' || mo.key === 'voice') && s.mode !== 'video' && s.mode !== 'voice' ? { callSec: 0 } : {};
                              this.setState({ mode: mo.key, ...reset } as Pick<State, 'mode'>);
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

                    {/* video call */}
                    {s.mode === 'video' && (
                      <div style={{ borderRadius: 13, overflow: 'hidden', position: 'relative', background: '#0a1117', boxShadow: 'inset 0 1px 3px rgba(0,0,0,.5)' }}>
                        <div style={{ height: 132, position: 'relative', background: 'radial-gradient(320px 160px at 50% 32%, #14222e 0%, #0a1117 75%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
                          <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'linear-gradient(140deg,#20303c,#101820)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 700, color: '#00ff88', boxShadow: '0 0 0 2px rgba(0,255,136,.25), inset 0 1px 0 rgba(255,255,255,.08)' }}>S</div>
                          <div style={{ fontSize: 11.5, fontWeight: 600, color: '#e8edf2' }}>Sarah</div>
                          <div style={{ fontFamily: mono, fontSize: 9.5, color: '#00ff88' }}>{callTime}</div>
                          <div style={{ position: 'absolute', right: 8, bottom: 8, width: 52, height: 38, borderRadius: 8, background: 'repeating-linear-gradient(135deg,#101820 0 6px,#0b1218 6px 12px)', border: '1px solid #1e2831', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: mono, fontSize: 7, color: '#4a545e' }}>YOU</div>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, padding: '9px 0 10px' }}>
                          {callBtn('M', s.muted ? '#ff5c7a' : '#131d26', s.muted ? '#fff' : '#98a3ad', () => this.setState(p => ({ muted: !p.muted })))}
                          {callBtn('V', s.camOff ? '#ff5c7a' : '#131d26', s.camOff ? '#fff' : '#98a3ad', () => this.setState(p => ({ camOff: !p.camOff })))}
                          {callBtn('✕', 'linear-gradient(140deg,#ff5c7a,#d42a4c)', '#fff', () => this.setState({ mode: 'compose', callSec: 0 }), true)}
                        </div>
                      </div>
                    )}

                    {/* voice call */}
                    {s.mode === 'voice' && (
                      <div style={{ borderRadius: 13, overflow: 'hidden', background: '#0a1117', boxShadow: 'inset 0 1px 3px rgba(0,0,0,.5)', padding: '14px 12px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%' }}>
                          <div style={{ width: 40, height: 40, borderRadius: '50%', flex: 'none', background: 'linear-gradient(140deg,#20303c,#101820)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, color: '#00ff88', boxShadow: '0 0 0 2px rgba(0,255,136,.25)' }}>S</div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: '#e8edf2' }}>Sarah</div>
                            <div style={{ fontFamily: mono, fontSize: 9.5, color: '#00ff88' }}>Voice · {callTime}</div>
                          </div>
                          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'flex-end', gap: 2.5, height: 22 }}>
                            {[8, 16, 11, 19, 9].map((h, i) => (
                              <span key={i} style={{ width: 3, height: h, borderRadius: 2, background: acc.c, animation: `wave .9s ease-in-out ${i * 0.15}s infinite` }} />
                            ))}
                          </div>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, paddingTop: 2 }}>
                          {callBtn('M', s.muted ? '#ff5c7a' : '#131d26', s.muted ? '#fff' : '#98a3ad', () => this.setState(p => ({ muted: !p.muted })))}
                          {callBtn('S', s.speaker ? acc.c : '#131d26', s.speaker ? acc.fg : '#98a3ad', () => this.setState(p => ({ speaker: !p.speaker })))}
                          {callBtn('✕', 'linear-gradient(140deg,#ff5c7a,#d42a4c)', '#fff', () => this.setState({ mode: 'compose', callSec: 0 }), true)}
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
