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

/** Origins allowed to hand this phone its session over postMessage. */
export function trustedParentOrigin(origin: string): boolean {
  if (!origin) return false;
  if (origin === 'https://stockmarketloop.com' || origin === 'https://www.stockmarketloop.com') return true;
  if (typeof location !== 'undefined' && origin === location.origin) return true;
  return /^https:\/\/[0-9]+\.discordsays\.com$/i.test(origin);
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
