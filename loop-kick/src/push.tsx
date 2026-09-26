import React from 'react';
import { apiUrl, inDiscordProxy, postToParent } from './base';

/**
 * "Phone alerts" row at the top of the Alerts tab. Web push must be set up
 * top-level on this app's own origin (browsers block the permission prompt in
 * cross-origin iframes), so the button opens /enable-alerts.html in a real tab
 * carrying the current session in the fragment. Inside Discord the tab opens
 * through the host's external-link path.
 */
type PushState = 'unknown' | 'off' | 'on' | 'unsupported';

export function PushAlertsRow(): React.ReactElement | null {
  const [state, setState] = React.useState<PushState>('unknown');

  React.useEffect(() => {
    let alive = true;
    const token = String(window.LOOP_KICK_CONFIG?.sessionToken || '');
    if (!token) { setState('unknown'); return; }
    fetch(apiUrl('/api/push/status'), { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(j => { if (alive) setState(j && j.enabled ? (j.subscribed ? 'on' : 'off') : 'unsupported'); })
      .catch(() => { if (alive) setState('unknown'); });
    return () => { alive = false; };
  }, []);

  if (state === 'unsupported' || state === 'unknown') return null;

  const openSetup = () => {
    const token = String(window.LOOP_KICK_CONFIG?.sessionToken || '');
    const target = (inDiscordProxy ? 'https://stockmarketloop-loop-kick.onrender.com' : location.origin)
      + '/enable-alerts.html#session=' + encodeURIComponent(token);
    if (inDiscordProxy) {
      postToParent({ type: 'sml-loop-kick:external', version: 1, url: target });
      return;
    }
    try { window.open(target, '_blank', 'noopener'); } catch { /* blocked */ }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 10px', borderRadius: 12, background: 'rgba(34,217,122,.08)', border: '1px solid rgba(34,217,122,.25)' }}>
      <div style={{ fontSize: 10.5, lineHeight: 1.45, color: '#cfe4d8' }}>
        <b style={{ display: 'block', fontSize: 11, color: '#9fe8c0' }}>Phone alerts {state === 'on' ? 'are on' : ''}</b>
        {state === 'on' ? 'This device gets a push when something lands here.' : 'Get these alerts as push notifications on your phone.'}
      </div>
      <button type="button" onClick={openSetup}
        style={{ border: 0, borderRadius: 999, padding: '7px 12px', fontSize: 9.5, fontWeight: 700, letterSpacing: .4, cursor: 'pointer', background: state === 'on' ? '#0e1721' : '#22d97a', color: state === 'on' ? '#cfe4f7' : '#04170d', whiteSpace: 'nowrap' }}>
        {state === 'on' ? 'Manage' : 'Enable'}
      </button>
    </div>
  );
}
