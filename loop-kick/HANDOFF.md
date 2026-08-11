# LOOP-KICK — handoff

Dual-screen fold-out messaging device ("LOOP-KICK phone") for the StockMarketLoop /
LOOP HUB site. The UI is a finished, approved design ported from a Claude Design file.
The frontend works standalone against a built-in mock. What's left is the backend and
production wiring.

## What exists and works

- `src/LoopKickPhone.tsx` — the entire device as one React class component. Dock,
  folded cover, unfold animation, tabs (Messages / Chirp / Alerts), deck modes
  (Reply / Watch / Room / Video / Voice / Style), style panel (accent, font, screen
  backgrounds, watermark). **The visual design is approved — do not restyle it.**
  Every inline style value is intentional and matches the design file.
- `src/transport.ts` — the message-system boundary. Two implementations behind one
  interface: `mock` (default, self-contained) and `live` (REST + WebSocket).
- `src/App.tsx` — LOOP HUB hero page hosting the device; hero buttons drive it via ref.
- Tests: 17 jsdom checks passed covering open/fold flow, typing, optimistic send with
  rollback, Escape, and unread routing (incoming while closed → notification + badge;
  incoming while viewing Messages → thread only).
- `pnpm install && pnpm dev` to run; `bash bundle-artifact.sh`-style Parcel build was
  used for the single-file artifact, but normal `vite build` works for deployment.

## Wire contract (transport.ts speaks this — build the server to match)

| Endpoint | Method | Shape |
|---|---|---|
| `/api/messages` | GET | `{ "messages": [{ "id", "from", "mine", "text", "ts" }] }` |
| `/api/messages/send` | POST `{ "content": string }` | one message object back |
| `/ws` | WebSocket | frames are single message objects, same shape |

`mine` is boolean (did the current user send it), `ts` is epoch millis. Malformed WS
frames are dropped client-side, so the server doesn't need to be perfect, but should be.

Runtime selection — no rebuild needed:
```html
<script>
  window.LOOP_KICK_CONFIG = {
    transport: 'live',
    socketUrl: 'wss://HOST/ws',
    endpoints: { messages: '/api/messages', send: '/api/messages/send' }
  };
</script>
<!-- then load the app bundle -->
```

## Remaining work, in priority order

1. **Backend.** Node/Express (or similar) implementing the three endpoints above, with
   a `messages` table (sender, receiver, content, timestamp) and WebSocket broadcast
   on new messages. Auth can start as a stub but design for per-user threads.
2. **Real text input.** The composer is currently a visual fake: a global `keydown`
   listener builds the draft and a span shows a blinking caret (faithful to the design
   file). Replace with a real `<input>` that is visually identical — keep the caret
   look via `caret-color` or keep the span overlaid — so browser IME, mobile keyboards,
   paste, and page-level shortcuts work. Remove the global single-character key capture
   once done; keep Enter-to-send and Escape-to-close.
3. **Multiple threads.** The UI shows one hardcoded contact ("Sarah"). Extend the
   Messages tab to a thread list → thread view. `WireMessage.from` already carries the
   sender; add a `thread` or `peer` field to the wire contract when the backend lands.
4. **Persist style settings.** Accent / font / backgrounds / watermark currently reset
   on reload. Persist server-side per user (`/api/settings/loopkick`) — there is
   deliberately no localStorage in this codebase.
5. **Chirp + Alerts data.** `CHIRPS` and the seeded `notifs` array in
   `LoopKickPhone.tsx` are static demo data. Feed them from real endpoints.
6. **Mobile pass.** The device is 352px wide, fixed bottom-right, with a 3D tilt
   (`rotateX(5deg) rotateY(-4deg)`). On narrow viewports it should go full-width and
   probably drop the tilt. Media-query work only — don't change desktop rendering.
7. **Site integration.** Mount into the existing static site
   (github.com/streetmoneybolo-wq/StockMarketLoop): either adopt Vite for the whole
   site, or keep the site static and mount the built JS/CSS onto a `#loop-kick-root`
   div. The site's earlier vanilla inbox module (`inbox-module.js`) is superseded by
   this — remove it when the device lands.

## Constraints — read before changing anything

- Design fidelity is the hard requirement. Colors, radii, easing curves
  (`cubic-bezier(.2,.8,.25,1)`, `.42s`), the 3D transform, fonts (Archivo /
  IBM Plex Sans / Space Grotesk, embedded woff2) are all from the approved file.
- No localStorage/sessionStorage anywhere. Server-side persistence only.
- Keep `transport.ts` as the only place that knows about the network. UI components
  never fetch directly.
- Optimistic send with rollback is intentional; don't "simplify" it to await-then-render.
- The Watch/Room/Video/Voice modes are visual simulations. Wiring them to real
  streams/WebRTC is out of scope unless explicitly requested.
