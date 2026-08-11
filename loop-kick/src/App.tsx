/**
 * LOOP HUB page shell from the design, hosting the LOOP-KICK phone.
 * The hero buttons drive the device through a ref, exactly like the
 * design's openMessages / openChirp / openNotifs actions.
 */
import { useRef } from 'react';
import LoopKickPhone from './LoopKickPhone';

const ghost: React.CSSProperties = {
  padding: '11px 20px',
  borderRadius: 999,
  border: '1px solid #232a31',
  background: 'transparent',
  color: '#c3ccd4',
  fontSize: 13,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export default function App() {
  const phone = useRef<LoopKickPhone>(null);
  const embed = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('embed') === '1';

  if (embed) {
    return (
      <div style={{ minHeight: '100vh', overflow: 'hidden', background: '#07090b' }}>
        <LoopKickPhone ref={phone} initialOpen />
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'radial-gradient(900px 500px at 75% 10%, #10161c 0%, #07090b 60%)', color: '#e8edf2', fontFamily: "'IBM Plex Sans',sans-serif" }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '0 28px', height: 60, background: 'rgba(7,9,11,.9)', borderBottom: '1px solid #1b2026' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#00ff88', boxShadow: '0 0 12px #00ff8899' }} />
          <span style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, letterSpacing: 2, fontSize: 14 }}>LOOP HUB</span>
        </div>
        <div style={{ display: 'flex', gap: 20, fontSize: 13, color: '#7e8a96' }}>
          <span>Watch</span><span>Live</span><span>Newsletters</span><span>Markets</span>
        </div>
      </div>

      <div style={{ maxWidth: 760, margin: '0 auto', padding: '80px 28px' }}>
        <div style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 10, letterSpacing: 1.8, color: '#00ff88', marginBottom: 14 }}>LOOP-KICK · DUAL SCREEN</div>
        <h1 style={{ fontFamily: "'Archivo',sans-serif", fontSize: 40, lineHeight: 1.1, margin: '0 0 14px', letterSpacing: -1 }}>Messages, Chirp and notifications live in one device.</h1>
        <p style={{ margin: '0 0 28px', color: '#98a3ad', fontSize: 15, lineHeight: 1.65, maxWidth: 520, textWrap: 'pretty' }}>
          Tap the device in the corner to wake it. Unfold the second screen to reply — type with your keyboard or tap a quick reply.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={() => phone.current?.openTo('messages')}
            style={{ padding: '11px 20px', borderRadius: 999, border: 'none', background: '#00ff88', color: '#06120c', fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            Open Messages
          </button>
          <button className="lk-ghostbtn" onClick={() => phone.current?.openTo('chirp')} style={ghost}>Open Chirp</button>
          <button className="lk-ghostbtn" onClick={() => phone.current?.openTo('notifs')} style={ghost}>Open Notifications</button>
        </div>
      </div>

      <LoopKickPhone ref={phone} />
    </div>
  );
}
