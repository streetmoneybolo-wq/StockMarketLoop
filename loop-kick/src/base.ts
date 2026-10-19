/**
 * Base-path + host-messaging helpers for running the phone under Discord's
 * Activity proxy. Inside Discord the app is served at
 * https://{appid}.discordsays.com/.proxy/loop-kick/… — every root-relative
 * URL must carry that prefix or it 404s on the proxy origin. Everywhere else
 * (the site popup, direct visits) BASE is ''.
 */
const proxyMatch = typeof location !== 'undefined'
  ? /^(.*\/\.proxy\/loop-kick)(\/|$)/.exec(location.pathname)
  : null;

export const BASE: string = proxyMatch ? proxyMatch[1] : '';

export const inDiscordProxy: boolean = !!proxyMatch || (typeof location !== 'undefined' && /\.discordsays\.com$/i.test(location.hostname));

export function apiUrl(path: string): string {
  return BASE + path;
}

/** Our own Discord Activities (Academy, Connect). Any Discord app is a numeric
 *  *.discordsays.com subdomain, so trust is pinned by application id. */
export const ACTIVITY_APP_IDS = ['1551336038713139370', '1537698927401377894'];

/** Origins allowed to hand this phone its session over postMessage. */
export function trustedParentOrigin(origin: string): boolean {
  if (!origin) return false;
  if (origin === 'https://stockmarketloop.com' || origin === 'https://www.stockmarketloop.com') return true;
  return ACTIVITY_APP_IDS.some(id => origin === `https://${id}.discordsays.com`);
}

function parentTargetOrigin(): string {
  try { if (document.referrer) return new URL(document.referrer).origin; } catch { /* fall through */ }
  return '*';
}

export function postToParent(payload: Record<string, unknown>): void {
  if (window.parent === window) return;
  try { window.parent.postMessage(payload, parentTargetOrigin()); } catch { /* host not listening */ }
}

/** Tell the host our token bounced so it can silently re-mint (throttled). */
let lastAuthNudge = 0;
export function notifyAuthNeeded(): void {
  const now = Date.now();
  if (now - lastAuthNudge < 5000) return;
  lastAuthNudge = now;
  postToParent({ type: 'sml-loop-kick:auth-needed', version: 1 });
}

/** Inside Discord the Activity's Content Security Policy lets images, audio and video load only from the
 *  Activity's own proxy origin, so everything the phone shows from the site (attachments, avatars, posters,
 *  chirps, mp4 videos) is fetched through our /api/media relay instead. Outside Discord the URL is untouched. */
export function mediaUrl(url?: string | null): string {
  const raw = String(url || '');
  if (!inDiscordProxy || !/^https?:\/\//i.test(raw)) return raw;
  try { if (new URL(raw).origin === location.origin) return raw; } catch { return raw; }
  return apiUrl('/api/media?u=' + encodeURIComponent(raw));
}

/** Open a page outside the phone. Inside Discord a window cannot be opened from the sandbox, so the host
 *  (the Academy or the LOOP-KICK Activity) is asked to open it through Discord's external-link prompt. */
export function openOutside(url?: string | null): void {
  const target = String(url || '');
  if (!/^https?:\/\//i.test(target)) return;
  if (inDiscordProxy) { postToParent({ type: 'sml-loop-kick:external', version: 1, url: target }); return; }
  try { window.open(target, '_blank', 'noopener'); } catch { /* popup blocked */ }
}
