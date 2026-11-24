# Gesture Remote — 4-Builder Work Split

> Replace **Builder 1–4** with real names. Contribution is an equal **25% each**; adjust to actual work.

## 1. Ownership

| Builder | Role | Primary files / areas | Main deliverables | Viva topics |
| --- | --- | --- | --- | --- |
| **Builder 1** | UI & Theme | `cursor.html`, `cursor.css`, theme/status parts of `cursor.js` | Page layout, Soft UI, light/dark theme, responsive design, accessibility | HTML, CSS, CSS variables, responsive design, `localStorage`, ARIA |
| **Builder 2** | Gesture & Input Client | touch/movement/input parts of `cursor.js` | Touch state machine, cursor movement, tap/drag/scroll/right-click, input socket | Touch events, thresholds, relative movement, acceleration, rAF, binary frames, backpressure |
| **Builder 3** | Backend & OS Input | input/server parts of `cursor_server.py` | Static serving, WebSocket server, binary protocol, Win32 input, click/drag/scroll, cleanup | asyncio, websockets, `struct`, `ctypes`, Win32, DPI, protocol |
| **Builder 4** | Screen, Network & QA | screen parts of `cursor.js` and `cursor_server.py`, `start_all.bat`, docs | Screen capture, JPEG stream, separate socket, tunnel, performance, tests, README | `mss`, Pillow, JPEG, threading, screen socket, tunnel/TLS, testing |

## 2. File ownership

| File / area | Primary owner | Support / reviewer |
| --- | --- | --- |
| `cursor.html` structure | Builder 1 | Builder 4 |
| `cursor.css` layout and themes | Builder 1 | Builder 4 |
| `cursor.js` theme, status, viewer markup behavior | Builder 1 | Builder 2 |
| `cursor.js` touch gestures and movement | Builder 2 | Builder 1 |
| `cursor.js` input socket, reconnect, backpressure | Builder 2 | Builder 3 |
| `cursor.js` screen viewer and screen socket | Builder 4 | Builder 1 |
| `cursor_server.py` static routes and WebSocket server | Builder 3 | Builder 4 |
| `cursor_server.py` input backend and protocol | Builder 3 | Builder 2 |
| `cursor_server.py` screen capture and stream | Builder 4 | Builder 3 |
| Protocol contract | Builder 3 | All |
| `start_all.bat`, tunnel, deployment | Builder 4 | Builder 3 |
| README, project guide, test plan | Builder 4 | All |

## 3. Builder 1 — UI & Theme

**Files:** `cursor.html`, `cursor.css`, theme/status parts of `cursor.js`

**Tasks**

- [ ] Build page structure: header, touchpad, viewer, gesture guide.
- [ ] Build Soft UI layout and both light/dark palettes.
- [ ] Add theme toggle, saved theme, and pre-paint restore.
- [ ] Update `theme-color` meta and toggle ARIA state.
- [ ] Make layout responsive at 390 px, 360 px, and below 370 px.
- [ ] Add safe-area insets for notched phones.
- [ ] Add status pill states: connecting, connected, offline.
- [ ] Add `prefers-reduced-motion` support.
- [ ] Review contrast and touch target sizes.
- [ ] Verify no horizontal overflow.

**Done when:** both themes work, theme survives reload, small screens fit, and the page has no console errors.

**Viva topics:** HTML structure, CSS variables, flex/grid, media queries, safe areas, `localStorage`, ARIA, reduced motion.

## 4. Builder 2 — Gesture & Input Client

**Files:** touch, movement, and input-socket parts of `cursor.js`

**Tasks**

- [ ] Build touch state machine: start, move, end, cancel.
- [ ] Implement relative movement and acceleration.
- [ ] Batch movement with `requestAnimationFrame`.
- [ ] Build 5-byte binary move and scroll frames.
- [ ] Implement tap, double-tap, hold-drag, two-finger scroll, two-finger right-click.
- [ ] Implement axis lock and tap/scroll disambiguation.
- [ ] Implement input socket connect, reconnect, and status updates.
- [ ] Implement `bufferedAmount` backpressure and urgent clicks.
- [ ] Add glow, drag state, and haptic feedback.
- [ ] Add cleanup on close, page hide, visibility change, and touch cancel.

**Done when:** all gestures work, no accidental clicks after scrolling, no stuck drag, and movement stays responsive on a slow link.

**Viva topics:** touch events, `preventDefault`, passive listeners, thresholds, delta/gain, acceleration, rAF, `ArrayBuffer`/`DataView`, little-endian, backpressure.

## 5. Builder 3 — Backend & OS Input

**Files:** input/server parts of `cursor_server.py`

**Tasks**

- [ ] Build static file routes for the page, CSS, and JS.
- [ ] Handle WebSocket upgrades on the same port.
- [ ] Parse binary move and scroll frames.
- [ ] Parse JSON click, mousedown, and mouseup messages.
- [ ] Implement Win32 cursor movement with `GetCursorPos` and `SetCursorPos`.
- [ ] Implement Win32 click, drag, vertical wheel, and horizontal wheel.
- [ ] Add DPI awareness.
- [ ] Add PyAutoGUI fallback for non-Windows platforms.
- [ ] Track held buttons and release them on disconnect.
- [ ] Add `TCP_NODELAY`, `compression=None`, and ping settings.
- [ ] Add safe range checks and invalid-message handling.

**Done when:** move, scroll, click, drag, and right-click work; invalid input cannot crash the server; a disconnect never leaves a button held.

**Viva topics:** asyncio, `websockets`, `process_request`, binary protocol, `struct.unpack_from`, `ctypes`, `wintypes`, Win32 events, DPI, `TCP_NODELAY`, cleanup.

## 6. Builder 4 — Screen, Network & QA

**Files:** screen parts of `cursor.js` and `cursor_server.py`, `start_all.bat`, docs

**Tasks**

- [ ] Build screen capture with `mss`.
- [ ] Resize frames and draw the cursor overlay.
- [ ] Encode JPEG with the tuned quality/subsampling settings.
- [ ] Skip unchanged frames with a 64 px grayscale thumbnail.
- [ ] Add a one-second heartbeat frame.
- [ ] Build the separate screen WebSocket and stream request.
- [ ] Build viewer open/close, fullscreen, stale detection, and resize handling.
- [ ] Add stream profiles for tunnel and LAN.
- [ ] Add server-side stream clamping.
- [ ] Set up the Cloudflare tunnel and `start_all.bat`.
- [ ] Write the test plan, README, and project guide.
- [ ] Run LAN, tunnel, theme, responsive, and reconnect tests.

**Done when:** screen opens and closes without affecting input, static screens do not waste CPU, the stream stops when hidden, and both LAN and tunnel profiles work.

**Viva topics:** `mss`, Pillow, JPEG, `ImageChops`, `ThreadPoolExecutor`, separate socket, frame dropping, `createImageBitmap`, `ResizeObserver`, Cloudflare tunnel, TLS/WSS, testing.

## 7. Shared work

- [ ] Agree the protocol contract before coding.
- [ ] Keep binary tags and JSON message names unchanged.
- [ ] Test the full path on a real phone.
- [ ] Test on LAN.
- [ ] Test through the tunnel.
- [ ] Test light and dark themes.
- [ ] Test at 390 px and 360 px.
- [ ] Test disconnect and reconnect.
- [ ] Review each other’s pull requests.
- [ ] Rehearse the viva demo together.
- [ ] Update README and guide after behavior changes.

## 8. Branch plan

| Builder | Branch |
| --- | --- |
| Builder 1 | `feat/ui-theme` |
| Builder 2 | `feat/gestures-input` |
| Builder 3 | `feat/backend-input` |
| Builder 4 | `feat/screen-network` |

Merge into `main` only after one other builder reviews and the full path still works.

## 9. Handoffs

| From | To | Artifact |
| --- | --- | --- |
| Builder 1 | Builder 2 | DOM IDs, CSS state classes, theme behavior |
| Builder 1 | Builder 4 | Viewer markup, status states, responsive rules |
| Builder 2 | Builder 3 | Input frame layout, JSON actions, urgent flags |
| Builder 3 | Builder 2 | Protocol confirmations, server errors, clamp ranges |
| Builder 3 | Builder 4 | Stream config, tags, server lifecycle |
| Builder 4 | All | Test results, tunnel steps, docs updates |

## 10. Build order

| Phase | Work | Owners |
| --- | --- | --- |
| 1 | Protocol contract + page/server skeleton | Builders 1, 3 |
| 2 | Gestures + real cursor input | Builders 2, 3 |
| 3 | Screen capture + viewer | Builders 3, 4 |
| 4 | Theme, responsive layout, tunnel, performance | All |
| 5 | Testing, docs, viva rehearsal | Builder 4 + all |

## 11. Contribution

| Builder | Role | Contribution |
| --- | --- | --- |
| Builder 1 | UI & Theme | 25% |
| Builder 2 | Gesture & Input Client | 25% |
| Builder 3 | Backend & OS Input | 25% |
| Builder 4 | Screen, Network & QA | 25% |
| **Total** | | **100%** |

> Adjust percentages if the actual contribution is not equal.
