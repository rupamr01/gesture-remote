# Gesture Remote — Project Guide & Viva Handbook

> This document explains the complete project, how a phone moves the computer cursor, how the three builders split the work, how the team works together, and what to learn before the viva.
>
> **Before submitting:** replace “Builder 1/2/3” with your real names and adjust the contribution percentages to match your actual work.
>
> For installation and commands, see [README.md](README.md).

### How to use this document

| If you need… | Read |
| --- | --- |
| A short explanation for the examiner | Section 2 |
| The complete cursor pipeline | Section 4 |
| Every gesture and threshold | Section 5 |
| The screen streaming design | Section 6 |
| The 3-person work split | Section 11 |
| The team workflow and contracts | Section 12 |
| A study checklist | Section 13 |
| Likely viva questions with answers | Section 14 |
| A live demo script | Section 15 |
| Commands, protocol, and constants | Section 19 |
| A final pre-viva checklist | Section 20 |

---

## 1. Project at a glance

**Gesture Remote** turns a phone into a wireless touchpad, scroll wheel, and mouse for a computer.

The phone opens a normal web page. The page captures touch gestures and sends small WebSocket messages to a Python server running on the computer. The server translates those messages into real mouse actions using the operating system's input API. A second WebSocket can stream the computer screen back to the phone on demand.

### The problem

A phone is always nearby, but controlling a laptop still needs a mouse or trackpad. Installing a separate app on the phone is inconvenient, and many remote-mouse apps are slow, ad-heavy, or require an account.

### The solution

- A mobile web page — no app install, no build step.
- A Python server on the computer.
- One port for the page and both WebSockets.
- Works on the same Wi-Fi (LAN) or through a Cloudflare Quick Tunnel.
- Low-latency input: binary frames, animation-frame batching, and native Windows input.
- Optional live screen preview on a separate socket so video never blocks the pointer.

### Tech stack

| Layer | Technology | Why |
| --- | --- | --- |
| Phone UI | HTML, CSS, vanilla JavaScript | Fast, no framework, no build step |
| Input transport | WebSocket | Full-duplex, low overhead, works through tunnels |
| Server | Python 3, `asyncio`, `websockets` | Simple async server, one process |
| OS input | Win32 API through `ctypes` | Direct, low-latency mouse control |
| Screen capture | `mss` | Fast cross-platform screen grabs |
| Image encoding | Pillow (PIL) | Resize, draw cursor, JPEG encode |
| Remote access | Cloudflare Quick Tunnel | HTTPS/WSS without port forwarding |
| Version control | Git + GitHub | Shared repo, history, reviews |

### Main features

- Soft UI touchpad with light and dark themes.
- One-finger movement with acceleration.
- Tap, double-tap, hold-to-drag, two-finger scroll, two-finger right-click.
- Live screen preview with cursor overlay and fullscreen.
- Responsive layout down to small phones.
- Reconnecting sockets and a visible connection status.
- Safety cleanup so a mouse button never stays stuck.

---

## 2. The 60-second viva explanation

> “Our project turns a phone into a wireless trackpad for a computer. The phone page captures touch events, converts finger movement into relative X/Y deltas, applies an acceleration curve, and batches the movement into one small binary WebSocket packet per animation frame. A Python server receives that 5-byte packet, unpacks the two 16-bit integers, and adds the delta to the current cursor position using the Windows API. Clicks, drags, and scrolling use the same input socket. A second WebSocket streams JPEG screen frames only while the viewer is open, so large frames never block the pointer. The page and both sockets share port 8766, which means one Cloudflare tunnel exposes the whole remote.”

If you remember only one sentence:

> **The phone sends movement deltas, not absolute coordinates; the server adds those deltas to the real cursor.**

---

## 3. System architecture

```text
┌──────────────────────────── PHONE ────────────────────────────┐
│  cursor.html + cursor.css + cursor.js                         │
│                                                               │
│  Touch events ──► gesture logic ──► binary/JSON messages       │
│       ▲                                      │                │
│       │                                      ▼                │
│  Canvas viewer ◄── JPEG frames ◄──── screen WebSocket         │
└───────────────────────────────┬───────────────────────────────┘
                                │
                     HTTPS / WSS through
                 Cloudflare Quick Tunnel (optional)
                                │
┌───────────────────────────────▼───────────────────────────────┐
│  cursor_server.py — Python asyncio + websockets :8766          │
│                                                               │
│  process_request ──► static files: /, /cursor.html,            │
│                     /cursor.js, /cursor.css                    │
│                                                               │
│  WebSocket connection #1: input                               │
│      binary move/scroll + JSON click/drag                     │
│                                                               │
│  WebSocket connection #2: screen (opened by the client)       │
│      stream request ──► capture task ──► JPEG frames          │
└───────────────────────────────┬───────────────────────────────┘
                                │
                    Windows API / PyAutoGUI fallback
                                │
                                ▼
                    Real mouse cursor + screen
```

### Components

| Component | Responsibility |
| --- | --- |
| `cursor.html` | Page structure, theme bootstrap, touchpad, screen viewer, controls |
| `cursor.css` | Soft UI layout, light/dark palettes, responsive rules, animations |
| `cursor.js` | Theme, sockets, gestures, movement batching, screen viewer |
| `cursor_server.py` | Static server, WebSocket server, input backend, screen stream |
| `start_all.bat` | Checks port 8766 and starts the server in a new window |
| `requirements.txt` | Python dependencies |
| `README.md` | Setup, controls, protocol, troubleshooting |
| `PROJECT_GUIDE.md` | This document: architecture, team split, viva preparation |

### Why one port matters

The server uses `websockets.serve(..., process_request=serve_static)`.

- A normal HTTP request for `/cursor.html` is answered with the page.
- A request with `Upgrade: websocket` is passed through to the WebSocket handler.
- The page, input socket, and screen socket all use the same host and port.

That gives one public URL through the tunnel:

```text
https://<tunnel-host>/cursor.html   → static page
wss://<tunnel-host>                 → input socket
wss://<tunnel-host>                 → screen socket
```

There is no CORS problem because everything is same-origin.

### Connection flow

1. The phone requests `http://<PC-IP>:8766/cursor.html` or the tunnel URL.
2. `cursor_server.py` serves the HTML, CSS, and JS.
3. `cursor.js` opens the input WebSocket immediately.
4. The status pill changes from “Connecting” to “Connected.”
5. When the user opens the screen viewer, the client opens a second WebSocket and sends a `stream` request.
6. The server starts sending JPEG frames on that second connection.
7. When the viewer closes, the client sends `active: false` and closes the screen socket.

---

## 4. How the phone moves the cursor — full pipeline

This is the most important part of the project. Learn it end to end.

### 4.1 The big idea: relative movement

The phone does **not** send “put the cursor at 73% of the screen width.”

It sends the **change** since the last touch position:

```text
finger moves 10 px right and 4 px down
        ↓
delta = (+10, +4)
        ↓
server adds that delta to the current cursor position
```

This is exactly how a laptop trackpad works.

Why relative movement is better:

- The phone and laptop have different resolutions and aspect ratios.
- No calibration or coordinate mapping is needed.
- Touching the pad does not make the cursor jump.
- You can lift and swipe repeatedly to cross a large screen.
- It works with different monitors and display scaling.

### 4.2 Touch start

In `cursor.js`, the `touchstart` handler:

1. Calls `event.preventDefault()` so the browser does not scroll, zoom, or select text.
2. Caches `pad.getBoundingClientRect()` once per gesture. This avoids a layout read on every `touchmove`.
3. If this is the first finger, calls `beginGesture(x, y)`:
   - stores `startX`, `startY`, `lastX`, `lastY`;
   - records the start time;
   - resets movement accumulators;
   - starts a 320 ms hold-to-drag timer.
4. If a second finger arrives:
   - cancels the hold timer;
   - ends any active drag;
   - switches to two-finger scroll mode;
   - records the midpoint of the two fingers.
5. Moves the visual glow to the touch point using a GPU-friendly `translate3d` transform.

### 4.3 Touch move and acceleration

For one finger, the handler calculates:

```js
const dx = x - lastX;
const dy = y - lastY;
```

Then it converts the raw finger speed into a movement gain:

```js
const dt = Math.max(6, now - lastMoveSample);
const speed = Math.hypot(dx, dy) * (16 / dt);

const gain =
    MOVE_MIN_GAIN +
    (MOVE_MAX_GAIN - MOVE_MIN_GAIN) *
    (1 - Math.exp(-speed / MOVE_ACCEL_SPEED));

moveAccX = clamp(moveAccX + dx * gain, MAX_MOVE_STEP);
moveAccY = clamp(moveAccY + dy * gain, MAX_MOVE_STEP);
```

The constants:

| Constant | Value | Meaning |
| --- | --- | --- |
| `MOVE_MIN_GAIN` | `1.15` | Slow, precise movement |
| `MOVE_MAX_GAIN` | `2.9` | Fast movement across the screen |
| `MOVE_ACCEL_SPEED` | `14` | How quickly gain rises with speed |
| `MAX_MOVE_STEP` | `1200` | Safety clamp per frame |

The formula is an exponential curve:

- Slow finger → gain near `1.15` → fine control.
- Fast finger → gain approaches `2.9` → quick traversal.
- The transition is smooth, not a sudden jump.

`dt` is clamped to at least 6 ms so an unusually small time difference does not create a huge speed spike.

### 4.4 Animation-frame batching

Raw `touchmove` events can fire 120–240 times per second. Sending every event would flood the socket and make the cursor lag.

Instead, the code accumulates movement and schedules one flush per rendered frame:

```js
function scheduleFlush() {
    if (inputScheduled) return;
    inputScheduled = true;

    requestAnimationFrame(() => {
        inputScheduled = false;
        flushMove();
        flushScroll();
    });
}
```

This means:

- At most one movement packet per animation frame.
- On a typical phone that is about 60 packets per second; on a 120 Hz phone it can be up to 120, but still far less than raw touch events.
- Only the latest accumulated delta matters; intermediate positions can be combined safely.

### 4.5 The binary move packet

Movement uses a fixed 5-byte binary frame:

```text
byte 0      : tag = 1 (move)
bytes 1–2   : int16 little-endian dx
bytes 3–4   : int16 little-endian dy
```

The client reuses one `ArrayBuffer` and one `DataView` to avoid allocating a new buffer for every frame:

```js
const moveFrame = new ArrayBuffer(5);
const moveView = new DataView(moveFrame);
moveView.setUint8(0, 1);

moveView.setInt16(1, dx, true); // true = little-endian
moveView.setInt16(3, dy, true);

sendFrame(moveFrame);
```

Why binary instead of JSON?

- No `JSON.stringify` on the phone.
- No JSON parse on the server.
- 5 bytes instead of a text object.
- Less CPU and less bandwidth at high frequency.
- `int16` is enough because each step is clamped to ±1200.

### 4.6 Server decode

`cursor_server.py` receives the binary message and checks the tag:

```python
EVENT_MOVE = 1
EVENT_SCROLL = 2
EVENT_SCREEN = 3

if len(message) >= 5 and message[0] == EVENT_MOVE:
    dx, dy = struct.unpack_from("<hh", message, 1)
    move_rel(dx, dy)
```

`<hh` means:

- `<` = little-endian.
- `h` = signed 16-bit integer.
- Two values: `dx`, `dy`.

The client’s `setInt16(..., true)` and the server’s `<hh` must always match. If one side used big-endian, movement would become garbage.

### 4.7 Windows cursor update

On Windows, the server uses the native API directly:

```python
user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]

def move_rel(dx, dy):
    dx = int(dx)
    dy = int(dy)
    if dx == 0 and dy == 0:
        return
    if user32.GetCursorPos(ctypes.byref(_cursor)):
        user32.SetCursorPos(_cursor.x + dx, _cursor.y + dy)
```

It also calls `SetProcessDPIAware()` so coordinates stay in physical screen pixels instead of being scaled by Windows display scaling.

On non-Windows systems, the server falls back to PyAutoGUI:

```python
pyautogui.moveRel(dx, dy, _pause=False)
```

PyAutoGUI is **not** used on Windows in this project because the direct Win32 call avoids wrapper overhead.

### 4.8 Worked example

Suppose the finger moves 10 px right and 4 px down in about 16 ms:

```text
dx = 10, dy = 4
speed ≈ 10.8
gain ≈ 2.1
accumulated movement ≈ (21, 8)
```

The client sends:

```text
[01][15][00][08][00]   ← little-endian int16 values
```

The server reads `dx = 21`, `dy = 8`, gets the current cursor position, and calls:

```text
SetCursorPos(currentX + 21, currentY + 8)
```

The cursor moves immediately. The phone never needs to know the laptop resolution.

### 4.9 Why this design is fast

| Design choice | Effect |
| --- | --- |
| Relative deltas | No coordinate mapping, natural trackpad feel |
| Acceleration curve | Precise slow movement, fast long movement |
| One packet per frame | Prevents touch-event flooding |
| Fixed 5-byte binary frame | Minimal serialization and bandwidth |
| Reused `ArrayBuffer` | No per-frame allocation |
| `TCP_NODELAY` | Small packets are not delayed by Nagle’s algorithm |
| `compression=None` | No CPU cost for compressing tiny frames |
| `bufferedAmount` guard | Drops stale movement instead of building a queue |
| Native Win32 input | Avoids PyAutoGUI wrapper overhead |

### 4.10 Backpressure: what happens on a slow link

`canSend()` checks the socket before sending:

```js
function canSend(urgent) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    return urgent || socket.bufferedAmount <= 2048;
}
```

- If more than 2048 bytes are already queued, normal movement is skipped.
- Clicks and drags are marked `urgent` and still go through.
- When a movement frame is sent, only the sent amount is subtracted from the accumulator:

```js
if (!sendFrame(moveFrame)) return;
moveAccX -= dx;
moveAccY -= dy;
```

So the unsent remainder is preserved. This is important: if the code cleared the accumulator on a failed send, the cursor would feel stuck.

---

## 5. Every gesture, step by step

### 5.1 Gesture summary

| Gesture | Detection | Message sent | Server action |
| --- | --- | --- | --- |
| One-finger drag | Single touch + movement | Binary move `[1][dx][dy]` | Move cursor relatively |
| Tap | `< 220 ms`, movement `< 16 px` | JSON `click` left | Left click |
| Double-tap | Two taps within `300 ms` | Two left clicks | OS treats as double-click |
| Hold, then drag | Still for `320 ms`, movement `≤ 8 px` | JSON `mousedown` / `mouseup` | Hold left button while moving |
| Two-finger drag | Two touches + movement | Binary scroll `[2][dy][dx]` | Wheel / horizontal wheel |
| Two-finger tap | `< 220 ms`, movement `< 16 px`, no scroll | JSON `click` right | Right click |

### 5.2 Tap and double-tap

On `touchend`:

```js
const duration = performance.now() - touchStartTime;
const isTap = duration < TAP_MAX_MS && movedDistance < TAP_MAX_MOVE;
```

Thresholds:

| Constant | Value |
| --- | --- |
| `TAP_MAX_MS` | `220 ms` |
| `TAP_MAX_MOVE` | `16 px` |
| `DOUBLE_TAP_MS` | `300 ms` |

A tap sends:

```json
{ "type": "click", "button": "left", "clicks": 1 }
```

For a double-tap, the first tap already sends a click. The second tap sends another click within 300 ms, and the operating system interprets the pair as a double-click. The code then resets `lastTapTime` so a third tap starts a new sequence.

The phone vibrates briefly if `navigator.vibrate` is available.

### 5.3 Hold-to-drag

When a single finger touches down, a 320 ms timer starts.

- If the finger stays still for 320 ms, `startDrag()` sends:

```json
{ "type": "mousedown", "button": "left" }
```

- The user can then move the finger; the cursor moves with the left button held.
- On release, `endDrag()` sends:

```json
{ "type": "mouseup", "button": "left" }
```

- If the finger moves more than 8 px before the timer fires, the timer is cleared and the gesture becomes normal pointer movement, not a drag.

This is how the remote can drag a file, select text, or move a window.

### 5.4 Two-finger scroll and axis lock

When a second finger touches:

- The hold timer is cancelled.
- Any active drag is ended.
- The code records the midpoint of the two fingers.
- `gestureHadMulti = true` so the gesture can never become a left click.

On each move, the midpoint delta is added to `scrollAccX` / `scrollAccY` with `SCROLL_GAIN = 1.2`.

After 8 px of total travel, the code locks to one axis:

```js
if (!scrollAxis && scrollTravel > SCROLL_LOCK_PX) {
    scrollAxis =
        Math.abs(scrollAccY) >= Math.abs(scrollAccX) ? "y" : "x";

    if (scrollAxis === "y") scrollAccX = 0;
    else scrollAccY = 0;
}
```

This prevents a slightly diagonal swipe from wobbling between vertical and horizontal scrolling.

The scroll packet is also 5 bytes:

```text
byte 0      : tag = 2 (scroll)
bytes 1–2   : int16 little-endian dy
bytes 3–4   : int16 little-endian dx
```

On Windows, the server converts it to wheel events:

```python
vertical = int(-dy * 4)
horizontal = int(dx * 4)

user32.mouse_event(MOUSEEVENTF_WHEEL, 0, 0, vertical, 0)
user32.mouse_event(MOUSEEVENTF_HWHEEL, 0, 0, horizontal, 0)
```

The sign is inverted so dragging feels natural, and the multiplier makes the scroll speed useful.

### 5.5 Two-finger tap = right click

A two-finger tap is a short gesture with little movement:

- `multiTapEligible` must still be true.
- Duration must be `< 220 ms`.
- Movement must be `< 16 px`.
- No axis lock must have happened.

If all conditions pass, the client sends:

```json
{ "type": "click", "button": "right", "clicks": 1 }
```

Scrolling cancels `multiTapEligible`, so a scroll is never mistaken for a right-click.

### 5.6 Lifting one finger during a scroll

If one finger lifts and one remains:

- The code keeps `gestureHadMulti = true`.
- The remaining finger can continue moving the cursor.
- The gesture cannot become a click.
- `scrollAxis` is reset.

This avoids a sudden jump or accidental click.

### 5.7 Safety cleanup

A mouse button must never stay pressed after the phone disconnects.

The client releases the drag on:

- socket close;
- `pagehide`;
- the page becoming hidden;
- `touchcancel`.

The server also tracks the held button:

```python
state = {"held": None}
```

In the `finally` block of the connection handler:

```python
if state["held"] is not None:
    mouse_up(state["held"])
    state["held"] = None
```

This is a defensive second layer: even if the client disappears, the server releases the button.

---

## 6. Screen preview pipeline

The screen preview is optional and runs only while the viewer is open.

### 6.1 Client side

1. The user taps the screen button.
2. `openViewer()` shows the viewer and adds the `viewing` class.
3. `connectScreen()` opens a **second** WebSocket.
4. On open, the client sends:

```json
{
  "type": "stream",
  "active": true,
  "fps": 8,
  "quality": 42,
  "width": 760,
  "viewerWidth": 360
}
```

5. The server starts a screen task for that connection.
6. Incoming frames begin with tag `3`; the rest is JPEG data.
7. The client decodes and draws the frame on the canvas.

When the viewer closes, the client sends `active: false` and closes the socket.

### 6.2 Server side

`send_screen()` runs a loop:

1. Read the current FPS, quality, and width from the stream config.
2. Compute the cursor size from `viewerWidth` so the drawn pointer stays about 12 CSS px on the phone.
3. Capture the screen in a worker thread.
4. Resize the image to the requested width.
5. Draw the cursor arrow at the real cursor position.
6. Encode the image as JPEG.
7. Send `[3][JPEG bytes]`.
8. Sleep for the remainder of the frame interval.

### 6.3 Capture details

```python
shot = sct.grab(monitor)
image = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
```

- `mss` captures monitor 1.
- The raw buffer is BGRA/BGRX; Pillow converts it to RGB.
- The image is resized with bilinear filtering.
- The cursor is drawn by the server because screen capture does not reliably include the pointer.
- JPEG encoding uses `optimize=False`, `progressive=False`, and `subsampling=2` for speed.

### 6.4 Skipping unchanged frames

Encoding every frame is wasteful when the screen is static.

The server keeps a small 64-pixel-wide grayscale thumbnail of the previous frame:

```python
thumb = image.resize(...).convert("L")
changed = ImageChops.difference(thumb, previous).getbbox() is not None
```

It also checks whether the cursor moved.

If nothing changed and less than one second has passed since the last frame, it returns `None` and skips JPEG encoding entirely. A heartbeat frame is sent once per second so the phone knows the stream is still alive.

### 6.5 Client decoding and frame dropping

```js
createImageBitmap(new Blob([buffer.slice(1)], { type: "image/jpeg" }))
    .then((bitmap) => {
        screenCtx.drawImage(bitmap, 0, 0);
        bitmap.close();
    })
```

- `buffer.slice(1)` removes the tag byte.
- `createImageBitmap` decodes asynchronously.
- If a frame is still decoding, the next frame is dropped instead of queued.
- The newest frame is always more useful than a backlog of old frames.
- A stale timer marks the viewer “No signal” after 2.5 seconds without a frame.

### 6.6 Resize and fullscreen

- A `ResizeObserver` watches the canvas.
- After a 250 ms debounce, it re-sends the stream config with the new `viewerWidth`.
- The server uses that width to keep the drawn cursor the right size after rotation or fullscreen.
- The viewer supports the Fullscreen API and tries to lock orientation to landscape.
- Tapping the canvas toggles fullscreen; it does **not** send a remote click.

### 6.7 Stream profiles

| Network | FPS | JPEG quality | Width |
| --- | --- | --- | --- |
| Tunnel (`https:`) | 8 | 42 | 760 px |
| LAN (`http:`) | 12 | 55 | 960 px |

The server clamps values to safe ranges:

- FPS: 1–20
- Quality: 30–80
- Width: 480–1280
- `viewerWidth`: 100–4000

### 6.8 Why a separate socket?

A JPEG frame can be tens of kilobytes. If screen frames and pointer movement shared one WebSocket, a large frame could sit ahead of a movement packet in the send queue.

Using a second socket gives application-level isolation:

- Input stays small and responsive.
- Screen traffic can be dropped or slowed without affecting the pointer.
- Closing the viewer closes only the screen socket.

The server itself does not force two sockets; each connection can request a stream. The **client** chooses to open a second connection for isolation.

---

## 7. Theme system

The page has a light theme by default and an optional dark theme.

### How it works

1. `cursor.html` has an inline script in `<head>`.
2. It reads `localStorage["touchpad-theme"]`.
3. If the value is `"dark"`, it sets `document.documentElement.dataset.theme = "dark"` before the stylesheet loads.
4. It also updates `<meta id="theme-color">` so the mobile browser chrome matches.
5. `cursor.css` defines all colors as CSS variables under `:root` and overrides them under `:root[data-theme="dark"]`.
6. The toggle button calls `applyTheme()` and saves the choice.
7. `applyTheme()` updates:
   - `data-theme`;
   - `aria-pressed`;
   - `aria-label` and `title`;
   - the `theme-color` meta tag.

### Why the inline script matters

If dark mode were applied only after `cursor.js` loaded, the page would paint light first and then flash dark. Applying the attribute before the stylesheet paints avoids that flash.

### Theme details

- Light is the default; the page does **not** automatically follow the operating system theme.
- The choice persists across reloads.
- `localStorage` access is wrapped in `try/catch` because private mode can block it.
- The toggle shows a moon in light mode and a sun in dark mode.
- CSS includes `prefers-reduced-motion` support to disable animations for users who request it.

---

## 8. Networking and deployment

### 8.1 LAN mode

```text
Phone ── Wi-Fi ──► http://<PC-IP>:8766/cursor.html
                   ws://<PC-IP>:8766
```

- No internet required.
- The phone and computer must be on the same network.
- Windows Firewall must allow Python on private networks.
- The server binds `0.0.0.0`, so it listens on all interfaces.
- Traffic is plain HTTP/WS on the LAN, not encrypted.

### 8.2 Tunnel mode

```bash
cloudflared tunnel --url http://localhost:8766
```

Cloudflare prints a public URL such as:

```text
https://something.trycloudflare.com
```

Open:

```text
https://something.trycloudflare.com/cursor.html
```

- Cloudflare terminates TLS.
- The page uses `https`, so `cursor.js` automatically uses `wss://`.
- The tunnel forwards both static requests and WebSocket upgrades to the local server.
- The URL changes when `cloudflared` restarts.
- No Cloudflare account is required for a Quick Tunnel.

### 8.3 How the client chooses the WebSocket URL

```js
const wsOverride = new URLSearchParams(window.location.search).get("ws");
const WS_URL = wsOverride
    ? wsOverride
    : window.location.protocol === "https:"
        ? "wss://" + window.location.host
        : window.location.port === "8766"
            ? "ws://" + window.location.host
            : "ws://" + window.location.hostname + ":8766";
```

Cases:

| Page URL | WebSocket URL |
| --- | --- |
| `https://tunnel/cursor.html` | `wss://tunnel` |
| `http://PC:8766/cursor.html` | `ws://PC:8766` |
| `http://PC:8080/cursor.html` (legacy) | `ws://PC:8766` |
| `...?ws=ws://host:port` | exact override |

The `?ws=` parameter is useful for testing or custom deployments. The port-8080 branch is a legacy fallback from an earlier two-server setup; the current app serves everything from 8766.

### 8.4 One-click launcher

`start_all.bat`:

1. Changes to the project directory.
2. Checks whether port 8766 is already listening using PowerShell.
3. If free, starts `cmd /k python cursor_server.py` in a new window.
4. If busy, prints “Already running on port 8766.”
5. Prints the phone URL format and waits a few seconds.

It does **not** start the tunnel; run `cloudflared` separately.

### 8.5 Server startup

`cursor_server.py` prints:

```text
Phone:     http://<local-ip>:8766/cursor.html
WebSocket: ws://<local-ip>:8766
Tunnel:    cloudflared tunnel --url http://localhost:8766
```

`get_local_ip()` opens a UDP socket to `8.8.8.8:80` to discover the outbound interface address. No data is sent.

### 8.6 Static file routes

| Path | File | Content type |
| --- | --- | --- |
| `/` | `cursor.html` | `text/html; charset=utf-8` |
| `/cursor.html` | `cursor.html` | `text/html; charset=utf-8` |
| `/cursor.js` | `cursor.js` | `text/javascript; charset=utf-8` |
| `/cursor.css` | `cursor.css` | `text/css; charset=utf-8` |
| `/favicon.ico` | none | `204 No Content` |
| anything else | none | `404 Not Found` |

Responses use `Cache-Control: no-store` so the phone does not keep stale HTML/JS/CSS during development.

### 8.7 Security warning

There is **no authentication**.

- Anyone with the tunnel URL can move the mouse, click, and view the screen.
- The tunnel exposes the remote to the public internet.
- LAN mode is unencrypted; other devices on the network may be able to interfere.
- The server binds all interfaces.
- Stop the server and tunnel when finished.
- Do not use this on untrusted networks or someone else's computer without permission.
- For a real deployment, add a PIN/token, rate limiting, and a private tunnel or Cloudflare Access.

---

## 9. Performance decisions

| Problem | Solution | Result |
| --- | --- | --- |
| Too many touch events | Accumulate and flush once per animation frame | Fewer packets, stable movement |
| Large JSON movement messages | 5-byte binary frames | Less CPU and bandwidth |
| Socket queue grows on slow links | `bufferedAmount` guard + preserve remainder | No growing lag |
| Nagle delays small packets | `TCP_NODELAY` on accepted sockets | Lower input latency |
| Compression costs CPU | `compression=None` | Less overhead for tiny frames |
| Screen frames block input | Dedicated screen WebSocket | Input stays responsive |
| Idle screen re-encodes frames | 64 px thumbnail diff + 1 s heartbeat | Saves CPU and bandwidth |
| Capture blocks the event loop | Single-worker `ThreadPoolExecutor` | Async server stays responsive |
| Decoder backlog | Drop frames while `screenDecoding` is true | Always show the newest frame |
| Heavy UI effects | Static shadows, no `backdrop-filter` | Smoother phone rendering |
| Theme flash | Inline pre-paint script | No light flash in dark mode |
| Tunnel bandwidth | Lower FPS/quality/width on `https` | Smoother remote use |

### Latency vs quality

The project deliberately chooses latency over maximum image quality:

- The tunnel profile is 8 FPS, quality 42, width 760.
- The LAN profile is 12 FPS, quality 55, width 960.
- The pointer path is separate from the screen path.
- Unchanged screen frames are skipped.

For a remote mouse, a responsive pointer matters more than a perfect video feed.

---

## 10. File-by-file guide

### `cursor.html`

- Viewport and mobile meta tags.
- Inline theme restore script.
- First-paint background to prevent a flash.
- Header with brand, theme toggle, screen toggle, status pill.
- Screen viewer with canvas and fullscreen button.
- Touchpad section with hint text and glow element.
- Gesture guide cards.
- Script include with a cache-busting version.

### `cursor.css`

- CSS variables for both themes.
- Soft UI surfaces, shadows, and gradients.
- Layout: header, viewer, pad, gesture guide.
- Status dot states: connecting, connected, offline.
- Viewer states: connecting, live, offline.
- Responsive breakpoints for small phones, short screens, and landscape.
- Status pill collapses to a dot at ≤370 px.
- Safe-area insets for notched phones.
- `touch-action: none` and `user-select: none` on the pad.
- `prefers-reduced-motion` support.
- No `@import` and no `backdrop-filter` to keep rendering cheap.

### `cursor.js`

- Theme apply/save.
- Input WebSocket connection and reconnect.
- Status updates.
- Screen WebSocket, viewer, fullscreen, stale detection.
- Movement accumulation, acceleration, batching.
- Touch gesture state machine.
- Tap, double-tap, hold-drag, scroll, right-click.
- Cleanup on close, hide, and cancel.

### `cursor_server.py`

- Platform input backend:
  - Win32 native calls on Windows;
  - PyAutoGUI fallback elsewhere.
- Constants and stream configuration.
- Screen capture, cursor drawing, JPEG encoding, frame skipping.
- Static file serving.
- Binary and JSON message processing.
- Per-connection state and cleanup.
- WebSocket server setup with `TCP_NODELAY`, no compression, and ping settings.

### `start_all.bat`

- Port check.
- Server launch.
- User instructions.

### `requirements.txt`

- `websockets`
- `mss`
- `Pillow`
- `pyautogui` only on non-Windows platforms.

### `README.md`

- Setup, controls, tunnel instructions, protocol, troubleshooting.

### `PROJECT_GUIDE.md`

- This document.

> `stream_test.py` is an older local prototype. It is intentionally ignored by Git and is not part of the current app.

---

## 11. Work distribution — three builders

> Replace “Builder 1/2/3” with your real names before submitting. Adjust percentages to match your actual contribution; do not claim work you did not do.

The project is already integrated. The split below is by **ownership**, not three separate apps. Every builder must still understand the full end-to-end path for the viva.

### 11.1 Ownership table

| Builder | Role | Primary files / areas | Main deliverables | Viva focus |
| --- | --- | --- | --- | --- |
| **Builder 1** | Frontend & Interaction | `cursor.html`, `cursor.css`, gesture/theme parts of `cursor.js` | Soft UI, responsive layout, theme toggle, touch gestures, accessibility | DOM, CSS, touch events, gesture thresholds, rAF, UX |
| **Builder 2** | Backend & OS Input | `cursor_server.py` input/server sections | WebSocket server, static serving, binary protocol, Win32 input, click/drag/scroll, cleanup | asyncio, websockets, binary data, ctypes, Win32, DPI |
| **Builder 3** | Streaming, Network & QA | screen sections of `cursor.js` and `cursor_server.py`, `start_all.bat`, docs | Screen capture, JPEG stream, separate socket, tunnel, performance, tests, README | mss/Pillow, JPEG, threading, tunnel/TLS, latency, testing |

Approximate contribution: **34% / 33% / 33%**. Change this if your actual split is different.

### 11.2 File ownership matrix

`cursor.js` and `cursor_server.py` are shared files, so ownership is by **section**, not by whole file.

| File / area | Primary owner | Reviewer / secondary |
| --- | --- | --- |
| `cursor.html` structure | Builder 1 | Builder 3 |
| `cursor.css` layout and themes | Builder 1 | Builder 3 |
| `cursor.js` theme + gestures + movement | Builder 1 | Builder 2 |
| `cursor.js` screen viewer + stream socket | Builder 3 | Builder 1 |
| `cursor_server.py` input + WebSocket server | Builder 2 | Builder 1 |
| `cursor_server.py` screen capture + stream | Builder 3 | Builder 2 |
| Protocol contract | Builder 2 | All |
| `start_all.bat`, tunnel, deployment | Builder 3 | Builder 2 |
| README, project guide, test plan | Builder 3 | All |

### 11.3 Builder 1 — Frontend & Interaction

**Owns**

- Page structure and semantic markup.
- Soft UI visual design.
- Light/dark theme and persistence.
- Responsive layout and safe-area handling.
- Touch gesture state machine.
- Tap, double-tap, hold-drag, two-finger scroll, two-finger right-click.
- Movement acceleration and animation-frame batching.
- Visual feedback: glow, drag state, status pill, haptics.
- Accessibility labels, `aria-pressed`, live status region, reduced motion.

**Key functions to know**

- `applyTheme()`
- `beginGesture()`
- `touchstart`, `touchmove`, `touchend`, `touchcancel`
- `startDrag()`, `endDrag()`
- `endTouch()`
- `flushMove()`, `flushScroll()`, `scheduleFlush()`
- `setStatus()`, `setGlow()`

**Definition of done**

- Works at 360 px width without horizontal overflow.
- Light and dark themes both readable.
- Theme survives reload.
- Tap does not fire after a scroll.
- Hold-to-drag releases correctly.
- No stuck drag after page hide or socket close.
- No console errors.

**Likely viva questions**

- Why relative movement instead of absolute coordinates?
- How do you distinguish a tap from a drag?
- Why 220 ms and 16 px?
- What does `preventDefault()` do?
- Why `requestAnimationFrame`?
- How does the acceleration formula work?
- How does the two-finger right-click avoid firing after a scroll?
- How does the theme avoid a flash?

### 11.4 Builder 2 — Backend & OS Input

**Owns**

- Python WebSocket server.
- Static file serving on the same port.
- Binary protocol parsing.
- Windows native input backend.
- Click, drag, and scroll actions.
- Per-connection state and cleanup.
- `TCP_NODELAY`, compression settings, ping settings.
- LAN/tunnel same-origin behavior on the server side.

**Key functions to know**

- `move_rel()`, `scroll()`, `click()`, `mouse_down()`, `mouse_up()`
- `process_message()`
- `serve_static()`
- `handle_connection()`
- `LowLatencyConnection.connection_made()`
- `main()`

**Definition of done**

- Move, scroll, click, drag, and right-click all work.
- Binary frames decode correctly.
- A disconnected phone never leaves the mouse button held.
- Static page and WebSocket share port 8766.
- Server starts cleanly and prints the correct LAN URL.
- Invalid messages are ignored without crashing.

**Likely viva questions**

- Why binary for movement and JSON for clicks?
- What does `struct.unpack_from("<hh", ...)` mean?
- Why `SetProcessDPIAware()`?
- Why `GetCursorPos` before `SetCursorPos`?
- Why not use PyAutoGUI on Windows?
- How does one port serve both HTTP and WebSocket?
- What happens if the phone disconnects mid-drag?
- Why `TCP_NODELAY` and `compression=None`?

### 11.5 Builder 3 — Streaming, Network & QA

**Owns**

- Screen capture with `mss`.
- Cursor overlay drawing.
- JPEG encoding and resizing.
- Frame-skip logic.
- Separate screen WebSocket on the client.
- Viewer states, fullscreen, stale detection, resize handling.
- Cloudflare tunnel setup and remote testing.
- `start_all.bat`, performance tuning, documentation, test plan.

**Key functions to know**

- `capture_jpeg()`
- `send_screen()`
- `update_stream_config()`
- `handleScreenFrame()`
- `connectScreen()`, `startScreen()`, `stopScreen()`
- `sendStream()`
- `openViewer()`, `closeViewer()`
- `viewerWidthCss()`

**Definition of done**

- Screen opens and closes without affecting input.
- Stream stops when the viewer closes or the page is hidden.
- Static screen does not waste CPU on repeated JPEG encoding.
- Cursor overlay stays a sensible size after rotation/resize.
- Tunnel and LAN profiles both work.
- README and this guide are accurate.
- Test checklist is complete.

**Likely viva questions**

- Why a separate socket for screen frames?
- How does JPEG encoding work?
- Why skip unchanged frames?
- Why draw the cursor on the server?
- Why use a thread pool for capture?
- How does the tunnel work?
- Why is the tunnel profile lighter than LAN?
- What happens if decoding is slower than the stream?

### 11.6 Shared responsibilities

All three builders should be able to explain:

- The full phone → server → OS path.
- The binary protocol.
- Why relative movement is used.
- Why the screen uses a separate socket.
- The security limitations.
- How to run the demo.
- What each file does.
- At least two bugs they fixed and how.

### 11.7 Suggested build order

| Phase | Goal | Main owners | Output |
| --- | --- | --- | --- |
| 1 | Define protocol and page skeleton | All | Static page + WebSocket echo + agreed message formats |
| 2 | Input path | Builders 1 & 2 | Touch gestures → binary frames → real cursor |
| 3 | Screen path | Builders 2 & 3 | Capture → JPEG → viewer |
| 4 | Polish and deployment | All | Theme, responsive layout, tunnel, performance |
| 5 | QA and documentation | Builder 3 + all reviewers | Tests, README, viva rehearsal |

### 11.8 How to introduce your contribution

Use these as a starting point, then add one real bug or decision you personally handled.

**Builder 1 — Frontend & Interaction**

> “I built the phone interface and gesture layer. The page uses plain HTML, CSS, and JavaScript. On touch start I cache the pad rectangle and start the 320 ms hold timer. On touch move I compute the delta, apply the acceleration curve, accumulate it, and schedule one binary packet per animation frame. On touch end I classify the gesture as tap, double-tap, hold-drag, or two-finger right-click using time and distance thresholds. I also built the light/dark theme with `localStorage` and the responsive Soft UI.”

**Builder 2 — Backend & OS Input**

> “I built the Python server and input backend. It serves the page and accepts WebSocket upgrades on port 8766. High-frequency movement arrives as 5-byte binary frames; I unpack little-endian `int16` deltas and call `GetCursorPos` and `SetCursorPos` through `ctypes`. Clicks and drags use JSON, and I track the held button so it is released on disconnect. I also disabled Nagle and compression for lower latency.”

**Builder 3 — Streaming, Network & QA**

> “I built the screen streaming and deployment path. The viewer opens a second WebSocket and requests FPS, quality, width, and viewer width. The server captures monitor 1 with `mss`, resizes it, draws the cursor, encodes JPEG, and skips unchanged frames using a 64-pixel grayscale thumbnail. The client decodes with `createImageBitmap` and drops frames while busy. I also set up the Cloudflare tunnel, the one-click launcher, the performance profiles, and the testing and documentation.”

**All three**

> “Together we defined the protocol and tested the complete phone-to-cursor path on LAN and through the tunnel.”

---

## 12. How the team works together

### 12.1 Interface contract

The team should treat these as contracts. Changing them requires all three builders to agree.

| Contract | Values |
| --- | --- |
| Port | `8766` |
| Static routes | `/`, `/cursor.html`, `/cursor.js`, `/cursor.css` |
| Input move frame | `[1][int16 LE dx][int16 LE dy]` |
| Input scroll frame | `[2][int16 LE dy][int16 LE dx]` |
| Screen frame | `[3][JPEG bytes]` |
| JSON actions | `mousedown`, `mouseup`, `click`, `stream` |
| Stream fields | `active`, `fps`, `quality`, `width`, `viewerWidth` |
| Theme storage key | `touchpad-theme` |
| Theme attribute | `data-theme="dark"` on `<html>` |
| Status states | `connecting`, `connected`, `offline` |
| Viewer states | `connecting`, `live`, `offline` |
| DOM IDs | `pad`, `status`, `status-text`, `glow`, `viewer`, `screen`, `screen-toggle`, `viewer-state-text`, `viewer-fullscreen`, `theme-toggle`, `theme-color` |

### 12.2 Git workflow

- `main` is the stable branch.
- Create a feature branch per task:
  - `feat/ui`
  - `feat/input`
  - `feat/stream`
  - `fix/stuck-drag`
- Commit small, descriptive changes.
- Open a pull request.
- At least one other builder reviews it.
- Test on a real phone before merging.
- Update the README or this guide when behavior or protocol changes.

Example:

```bash
git checkout -b feat/ui
git add cursor.html cursor.css cursor.js
git commit -m "Add responsive touchpad layout"
git push -u origin feat/ui
```

### 12.3 Team rhythm

A simple rhythm that works:

- **Daily 10-minute sync:** what I did, what I will do, blockers.
- **Integration every 2–3 days:** merge working pieces and test the full path.
- **Bug triage:** label bugs by area (`ui`, `input`, `stream`, `network`).
- **Demo rehearsal:** once a week, run the exact viva demo on a phone.
- **Definition of done:** tested on LAN, tested through the tunnel, no console errors, no stuck mouse.

### 12.4 Handoff rules

- Builder 1 changes a gesture → tell Builder 2 if a new message type is needed.
- Builder 2 changes the protocol → update Builder 1 and Builder 3 immediately.
- Builder 3 changes stream fields → update the client stream request and server clamp ranges.
- Never rename a DOM ID without checking `cursor.js`.
- Never change a binary tag without checking both client and server.
- Keep the theme variables defined in both light and dark blocks.

### 12.5 Review checklist

Before merging:

- [ ] Page loads on LAN.
- [ ] Page loads through the tunnel.
- [ ] Input socket connects.
- [ ] Move, tap, double-tap, drag, scroll, right-click work.
- [ ] Screen viewer opens and closes.
- [ ] Screen stops when the page is hidden.
- [ ] Theme toggles and persists after reload.
- [ ] No horizontal overflow at 360 px.
- [ ] No console errors.
- [ ] No stuck mouse button after disconnect.
- [ ] `node --check cursor.js` passes.
- [ ] `python -m py_compile cursor_server.py` passes.
- [ ] Docs updated.

---

## 13. What to learn before the viva

### 13.1 Priority checklist

**Must know — every builder**

- [ ] HTTP request vs WebSocket upgrade.
- [ ] Same-origin and why no CORS is needed.
- [ ] HTTPS vs WSS.
- [ ] Touch events: `touchstart`, `touchmove`, `touchend`, `touchcancel`.
- [ ] `preventDefault()` and `{ passive: false }`.
- [ ] `touch-action: none`.
- [ ] Relative vs absolute coordinates.
- [ ] Delta, gain, acceleration, clamping.
- [ ] `requestAnimationFrame` batching.
- [ ] Binary `ArrayBuffer` / `DataView` / `int16` / little-endian.
- [ ] `socket.bufferedAmount` and backpressure.
- [ ] Python `asyncio` event loop, tasks, cancellation.
- [ ] `websockets` server, `process_request`, ping/pong.
- [ ] Win32 `GetCursorPos` / `SetCursorPos` / `mouse_event`.
- [ ] DPI awareness.
- [ ] Screen capture, resize, JPEG, frame skipping.
- [ ] Why the screen uses a separate socket.
- [ ] Tunnel vs LAN.
- [ ] Security limitations.

**Should know — by role**

- Builder 1: CSS variables, flex/grid, media queries, safe-area insets, `localStorage`, ARIA, `prefers-reduced-motion`.
- Builder 2: `struct`, `ctypes`, `wintypes`, `ThreadPoolExecutor`, `TCP_NODELAY`, error handling, cleanup in `finally`.
- Builder 3: `mss`, Pillow `Image`/`ImageDraw`/`ImageChops`, JPEG parameters, `createImageBitmap`, `Blob`, `ResizeObserver`, Cloudflare tunnel, latency/bandwidth tradeoffs.

**Nice to know**

- WebSocket frame format and masking.
- TCP head-of-line blocking.
- Nagle’s algorithm.
- JPEG chroma subsampling.
- Exponential acceleration curves.
- PWA basics.
- WebRTC as an alternative for screen streaming.
- Cloudflare named tunnels and Access.

### 13.2 Web and JavaScript concepts

| Concept | What to be able to say |
| --- | --- |
| IIFE | The whole client script is wrapped in `(() => { ... })()` to avoid global variables. |
| DOM | `getElementById`, `querySelector`, `classList`, `dataset`, `setAttribute`. |
| Events | `addEventListener`, bubbling, `preventDefault`, passive listeners. |
| Touch events | `event.touches` contains all active touches; `clientX/clientY` are viewport coordinates. |
| `touch-action` | CSS tells the browser not to handle panning/zooming on the pad. |
| `requestAnimationFrame` | Runs a callback before the next repaint; used to batch movement. |
| `ArrayBuffer` | Raw binary buffer. |
| `DataView` | Read/write typed values at byte offsets with control over endianness. |
| `Blob` | Wraps JPEG bytes so the browser can decode them. |
| `createImageBitmap` | Asynchronously decodes an image for canvas drawing. |
| `localStorage` | Small persistent key/value storage on the phone. |
| `ResizeObserver` | Detects canvas size changes after rotation/resize. |
| `navigator.vibrate` | Optional haptic feedback; not supported everywhere. |
| Fullscreen API | `requestFullscreen()` / `exitFullscreen()` for the viewer. |

### 13.3 Binary data and endianness

A 16-bit signed integer can hold `-32768` to `32767`.

The client writes:

```js
view.setInt16(offset, value, true); // true = little-endian
```

The server reads:

```python
struct.unpack_from("<hh", message, offset)
```

- `<` = little-endian.
- `h` = signed short (2 bytes).
- `hh` = two signed shorts.

Little-endian means the least significant byte comes first. Both sides must agree.

Why `int16`? Movement steps are small, and the code clamps them to ±1200, so 16 bits is more than enough. It keeps the packet at 5 bytes.

### 13.4 WebSocket concepts

| Concept | Explanation |
| --- | --- |
| Handshake | Starts as HTTP with `Upgrade: websocket`; server replies `101 Switching Protocols`. |
| Full-duplex | Both sides can send at any time. |
| Frames | Messages are split into frames; the app sees whole messages. |
| `binaryType` | Set to `"arraybuffer"` so binary frames arrive as `ArrayBuffer`. |
| Backpressure | `bufferedAmount` shows queued bytes; the app skips stale movement if it grows. |
| Ping/pong | The server pings every 20 s to detect dead connections. |
| Compression | Disabled here because tiny input frames do not benefit and screen JPEGs are already compressed. |
| Reconnect | The client retries after 1 s; the screen socket retries after 1.2 s. |

### 13.5 Python asyncio concepts

| Concept | Explanation |
| --- | --- |
| Event loop | Runs async tasks and I/O callbacks on one thread. |
| `async def` | Defines a coroutine. |
| `await` | Yields control while waiting for I/O. |
| `asyncio.create_task` | Starts the screen sender without blocking message handling. |
| `task.cancel()` | Stops the screen sender when the viewer closes. |
| `asyncio.Future()` | Keeps `main()` running forever. |
| `run_in_executor` | Runs blocking screen capture in a worker thread. |
| `ThreadPoolExecutor(max_workers=1)` | One capture worker; avoids blocking the event loop and avoids parallel captures. |
| `threading.local()` | Gives each thread its own `mss` instance. |

### 13.6 Windows input concepts

| Concept | Explanation |
| --- | --- |
| `GetCursorPos` | Reads the current cursor position into a `POINT`. |
| `SetCursorPos` | Moves the cursor to absolute screen coordinates. |
| `mouse_event` | Sends mouse button and wheel events. |
| `MOUSEEVENTF_WHEEL` | Vertical wheel event. |
| `MOUSEEVENTF_HWHEEL` | Horizontal wheel event. |
| DPI awareness | `SetProcessDPIAware()` keeps coordinates in physical pixels. |
| `ctypes` | Calls C functions in Windows DLLs from Python. |
| `argtypes` / `restype` | Tell `ctypes` the correct argument and return types. |

### 13.7 Screen capture and JPEG

| Concept | Explanation |
| --- | --- |
| `mss` | Fast screen capture library; returns raw pixel bytes. |
| Monitor 1 | The primary monitor is captured. |
| BGRA/BGRX | Windows pixel order; Pillow converts it to RGB. |
| Resize | Smaller width reduces bandwidth and encode time. |
| `ImageDraw` | Draws the cursor arrow on the frame. |
| JPEG | Lossy compression; good for photos/screen content at low latency. |
| Quality | Lower quality = smaller frames = less bandwidth. |
| Subsampling | `subsampling=2` reduces color detail for speed/size. |
| Thumbnail diff | A small grayscale copy detects whether the screen changed. |
| Heartbeat | A frame at least once per second keeps the viewer alive. |

### 13.8 Networking concepts

| Concept | Explanation |
| --- | --- |
| LAN | Local network; lowest latency; no internet needed. |
| Tunnel | Cloudflare forwards public HTTPS/WSS to the local server. |
| TLS | Encrypts traffic between phone and Cloudflare. |
| WSS | WebSocket over TLS. |
| Same-origin | Page and sockets share host/port; no CORS. |
| Quick Tunnel | Free, temporary Cloudflare URL; changes on restart. |
| Port forwarding | Not required with a tunnel. |
| Firewall | Must allow Python on private networks for LAN access. |

### 13.9 Performance concepts

| Concept | Explanation |
| --- | --- |
| Latency | Delay between finger movement and cursor movement. |
| Throughput | How much data can be sent per second. |
| FPS | Screen frames per second. |
| Backpressure | A queue is building faster than it can drain. |
| Head-of-line blocking | A large item delays small items behind it. |
| Batching | Combine many small updates into one send. |
| Frame dropping | Skip stale frames instead of queuing them. |
| Adaptive quality | Adjust stream settings to the network (future work). |

### 13.10 Security concepts

| Concept | Explanation |
| --- | --- |
| Authentication | Proving who may connect; currently missing. |
| Authorization | What an authenticated user may do. |
| Capability URL | The secret URL itself grants access. |
| TLS | Protects data in transit, not access control. |
| Rate limiting | Prevents abuse/flooding; not implemented. |
| Least privilege | Run only while needed; stop the tunnel afterward. |

---

## 14. Viva questions and answers

### Q1. What is the project?

A phone-based wireless touchpad and mouse remote. The phone runs a web page, sends touch deltas over WebSocket, and a Python server turns them into real mouse input on the computer. It also supports an optional live screen preview.

### Q2. Why did you build it instead of using an existing app?

It avoids installing a phone app, works through a browser, has no account or ads, and let us learn about touch gestures, binary WebSockets, async Python, and OS-level input. It is also tailored to low latency.

### Q3. How does the phone move the cursor?

The phone computes the change in finger position, applies an acceleration gain, accumulates it, and sends a 5-byte binary frame once per animation frame. The server unpacks the two 16-bit deltas and adds them to the current cursor position with `SetCursorPos`.

### Q4. Why relative movement instead of absolute coordinates?

The phone and computer have different resolutions and aspect ratios. Relative deltas need no calibration, do not jump when the finger touches down, and let the user lift and swipe repeatedly to cross a large screen.

### Q5. How does the acceleration work?

Slow movement uses a gain near 1.15 for precision. As speed increases, the gain approaches 2.9 using an exponential curve. The formula is:

```text
gain = 1.15 + 1.75 × (1 − e^(−speed / 14))
```

`dt` is normalized to 16 ms, and `dt` is clamped to at least 6 ms to avoid spikes.

### Q6. Why send only once per animation frame?

Raw touch events can fire 120–240 times per second. Batching reduces packet count, avoids socket flooding, and gives smoother movement. Only the accumulated delta matters, so intermediate sends are unnecessary.

### Q7. Why 5 bytes for movement?

One tag byte plus two bytes for `dx` and two bytes for `dy`. It is the minimum fixed format for two signed 16-bit values and avoids JSON overhead at high frequency.

### Q8. What is little-endian?

The least significant byte is stored first. The client writes with `setInt16(..., true)` and the server reads with `<hh`. Both must match or the numbers will be wrong.

### Q9. How do you distinguish a tap from a drag?

A tap must last less than 220 ms and move less than 16 px. Anything longer or farther is treated as movement, not a click.

### Q10. How does hold-to-drag work?

A 320 ms timer starts on touch down. If the finger is still and has moved no more than 8 px, the client sends `mousedown`. Movement then drags with the left button held. Releasing sends `mouseup`. Moving before the timer cancels the drag.

### Q11. How does two-finger scrolling work?

The code tracks the midpoint of two touches, accumulates its delta with a gain of 1.2, and locks to the dominant axis after 8 px. It sends a scroll frame with `dy` and `dx`; the server converts it to wheel and horizontal-wheel events.

### Q12. How does right-click work?

A two-finger tap that lasts less than 220 ms, moves less than 16 px, and has not scrolled sends a right-click JSON message.

### Q13. How does double-click work?

The first tap sends one left click. A second tap within 300 ms sends another left click, and the operating system interprets the pair as a double-click. The timer is then reset so a third tap starts a new sequence.

### Q14. What happens on a slow network?

The client checks `socket.bufferedAmount`. If more than 2048 bytes are queued, normal movement is skipped, but urgent clicks and drags still go through. The unsent movement remainder is preserved so the cursor does not get stuck.

### Q15. Why a separate screen socket?

Screen frames are large. On a shared socket they could queue ahead of input and make the pointer lag. A second socket isolates the two traffic types. The client can also drop screen frames without affecting input.

### Q16. How does screen streaming work?

The viewer opens a second WebSocket and sends a `stream` request with FPS, quality, width, and viewer width. The server captures the screen, resizes it, draws the cursor, encodes JPEG, and sends `[3][JPEG]` frames. The client decodes with `createImageBitmap` and draws to a canvas.

### Q17. Why skip unchanged frames?

If the screen is static, encoding and sending identical JPEGs wastes CPU and bandwidth. A 64 px grayscale thumbnail comparison detects changes. A one-second heartbeat keeps the stream alive.

### Q18. Why draw the cursor on the server?

Screen capture does not reliably include the mouse pointer. Drawing it from the real cursor position gives the phone a visible pointer. The size is scaled using `viewerWidth` so it stays about 12 CSS px on the phone.

### Q19. Why use `mss` and Pillow?

`mss` is a fast screen grabber. Pillow handles conversion, resizing, cursor drawing, and JPEG encoding. Both are lightweight and cross-platform.

### Q20. Why run capture in an executor?

Screen capture and JPEG encoding are blocking operations. Running them in a single-worker thread pool keeps the `asyncio` event loop free to handle WebSocket messages and input.

### Q21. How does one port serve both the page and WebSocket?

`websockets.serve` accepts a `process_request` callback. If the request is a normal HTTP GET for a known route, the server returns the file. If it has `Upgrade: websocket`, the callback returns `None` and the WebSocket handshake continues.

### Q22. How does the Cloudflare tunnel work?

`cloudflared tunnel --url http://localhost:8766` creates an outbound connection to Cloudflare. Cloudflare gives a public HTTPS URL and forwards requests and WebSocket upgrades to the local server. No router port forwarding is needed.

### Q23. What is the difference between LAN and tunnel mode?

LAN is local, faster, and unencrypted. Tunnel mode works from anywhere, uses HTTPS/WSS, and has higher latency and bandwidth limits. The client automatically uses a lighter stream profile over HTTPS.

### Q24. Why `TCP_NODELAY` and no WebSocket compression?

Nagle’s algorithm delays small packets to combine them, which adds latency to mouse movement. `TCP_NODELAY` disables that. Compression is disabled because 5-byte input frames do not benefit, and screen frames are already JPEG-compressed.

### Q25. How does the theme avoid a flash?

An inline script in `<head>` reads `localStorage` and sets `data-theme="dark"` before the stylesheet loads. The CSS variables then paint the correct theme on the first frame. The toggle updates the attribute and saves the choice.

### Q26. How do you prevent a stuck mouse button?

The client calls `endDrag()` on socket close, page hide, visibility change, and touch cancel. The server also tracks the held button and releases it in the connection handler’s `finally` block. Two layers of cleanup.

### Q27. How does reconnect work?

The input socket retries after 1 second. The screen socket retries after 1.2 seconds while the viewer is open. The status pill shows “Connecting,” “Connected,” or “Reconnecting.” On reconnect, the screen stream is requested again.

### Q28. What are the security risks?

There is no authentication. Anyone with the URL can control the mouse and view the screen. LAN traffic is unencrypted. The tunnel exposes the service to the internet. Use it only on trusted networks, stop it when done, and add a PIN/token for real deployment.

### Q29. What are the limitations?

Single-monitor screen capture, no keyboard input, no authentication, no adaptive bitrate, no multi-monitor selection, JPEG artifacts, no PWA install, and Windows has the lowest-latency input path. The screen preview is view-only.

### Q30. What did each builder do?

- Builder 1: frontend, theme, responsive layout, gesture state machine, movement batching.
- Builder 2: WebSocket server, static serving, binary protocol, Win32 input, cleanup.
- Builder 3: screen capture, JPEG stream, separate socket, tunnel, performance, testing, docs.

### Q31. What would you improve next?

Add PIN/token authentication and rate limiting, adaptive stream quality, multi-monitor selection, keyboard/text input, automated tests and CI, latency metrics, a PWA manifest, and a stable named tunnel.

### Q32. What was the hardest bug?

Good answers:

- Cursor lag from sending every touch event → fixed with rAF batching, binary frames, and a backpressure guard.
- Stuck drag after disconnect → fixed with client cleanup and server `finally` release.
- Screen frames making input lag → fixed with a dedicated screen socket and frame dropping.
- Theme flash → fixed with the inline pre-paint script.
- Accidental right-click after scrolling → fixed with `multiTapEligible` and axis lock.

### Q33. Why not use WebRTC for the screen?

WebRTC gives lower-latency video and built-in congestion control, but it needs signaling, STUN/TURN, and more complex code. For a simple 8–12 FPS preview, JPEG over WebSocket is much easier and good enough. WebRTC is a valid future improvement.

### Q34. Why not send JSON for everything?

JSON is readable and fine for rare actions like clicks. For movement at up to 120 frames per second, `JSON.stringify` and `JSON.parse` add CPU and bytes. Binary is smaller and faster.

### Q35. Why no framework or build step?

The UI is small and needs to load quickly on a phone. Plain HTML/CSS/JS avoids a build pipeline, dependencies, and bundle overhead. It also makes the project easy to run and demonstrate.

### Q36. How would you add a new gesture?

Add the detection logic in the touch handler, define a new message type or JSON action, handle it on the server, update the protocol table and tests, and verify that it does not conflict with tap/scroll/drag thresholds.

---

## 15. Demo script for the viva

### Before the demo

- [ ] Server is running on port 8766.
- [ ] Phone is on the same Wi-Fi.
- [ ] Firewall allows Python on private networks.
- [ ] A test window or file is ready for drag-and-drop.
- [ ] Phone brightness and volume are sensible.
- [ ] Theme is set to the one you want to show first.
- [ ] Tunnel is running if you plan to demonstrate remote access.
- [ ] Backup screenshots or a short video are available.

### Suggested 2-minute flow

| Time | Action | What to say |
| --- | --- | --- |
| 0:00 | Show the phone page | “This is a web page served by the Python server; no app install.” |
| 0:10 | Move the cursor slowly, then quickly | “Relative deltas with acceleration; slow is precise, fast covers distance.” |
| 0:25 | Tap and double-tap | “Tap thresholds are time and distance based.” |
| 0:35 | Hold and drag a window/file | “Hold for 320 ms sends mousedown; release sends mouseup.” |
| 0:45 | Two-finger scroll | “Midpoint delta, axis lock, separate scroll frame.” |
| 0:52 | Two-finger tap | “Right-click only if the gesture did not scroll.” |
| 1:00 | Toggle theme, reload | “Theme is saved in localStorage and applied before first paint.” |
| 1:10 | Open screen preview, fullscreen, close | “Separate socket; JPEG frames; input stays responsive.” |
| 1:25 | Show architecture or code snippets | “5-byte binary move, struct unpack, SetCursorPos.” |
| 1:40 | Show tunnel URL (optional) | “Same page and sockets through one Cloudflare tunnel.” |
| 1:50 | State limitations | “No auth; trusted networks only; single monitor preview.” |

### If the demo fails

| Problem | Quick fix |
| --- | --- |
| Page does not load | Check server window, same Wi-Fi, correct IP, firewall |
| Status stuck on “Connecting” | Reload page; check port 8766; check server log |
| Cursor does not move | Tap the pad once; reload; confirm socket is connected |
| No screen preview | `pip install mss pillow`; make sure a desktop session is active |
| Lag | Use LAN instead of tunnel; lower FPS/quality in `cursor.js` |
| Stuck mouse button | Restart server; the server releases held buttons on disconnect |
| Tunnel URL fails | Restart `cloudflared`; the Quick Tunnel URL changes |
| Theme looks wrong | Hard-refresh to load the latest CSS/JS |

---

## 16. Testing checklist

### Functional

- [ ] Move slowly and quickly.
- [ ] Tap once.
- [ ] Double-tap.
- [ ] Hold and drag.
- [ ] Two-finger vertical scroll.
- [ ] Two-finger horizontal scroll.
- [ ] Two-finger tap right-click.
- [ ] Lift one finger during a scroll.
- [ ] Touch cancel.
- [ ] Screen open/close.
- [ ] Fullscreen.
- [ ] Theme toggle.
- [ ] Theme persistence after reload.
- [ ] Reconnect after server restart.
- [ ] No stuck button after phone disconnect.

### Layout

- [ ] 390 px width.
- [ ] 360 px width.
- [ ] ≤370 px status pill collapses to a dot.
- [ ] Landscape.
- [ ] Short screen height.
- [ ] Notched phone safe areas.
- [ ] No horizontal overflow.

### Performance

- [ ] Input feels immediate on LAN.
- [ ] Screen stream does not block input.
- [ ] Static screen stops re-encoding.
- [ ] Tunnel profile is usable.
- [ ] No console errors.
- [ ] No server traceback.

### Static checks

```bash
node --check cursor.js
python -m py_compile cursor_server.py
```

### What was validated during development

The build was checked with:

- simulated touchpad gestures (tap, drag, scroll, right-click, theme);
- protocol tests for move, scroll, mousedown/up, and click;
- a live tunnel test for page load, WebSocket, screen frame, and stream stop;
- theme and responsive browser checks at 390 px and 360 px;
- syntax checks for JavaScript and Python;
- manual review of light/dark screenshots.

For reproducibility, these scripts should be moved into a `tests/` folder in the repository. That is a good future improvement.

---

## 17. Limitations and future work

### Current limitations

- No authentication or pairing.
- LAN traffic is not encrypted.
- Single-monitor screen capture.
- Screen preview is view-only.
- No keyboard or text input.
- No adaptive bitrate.
- JPEG artifacts at low quality.
- Quick Tunnel URL changes on restart.
- Windows has the most optimized input path; other platforms use PyAutoGUI.
- No formal automated test suite in the repository.
- No PWA/offline install.
- No multi-user session isolation; all connections control the same computer.

### Future improvements

1. **Pairing PIN/token** — require a short code before accepting input.
2. **Rate limiting** — protect against accidental or malicious floods.
3. **Named Cloudflare tunnel** — stable URL and optional access control.
4. **Adaptive stream quality** — adjust FPS/quality from measured latency or queue size.
5. **Multi-monitor support** — choose which monitor to capture.
6. **Keyboard/text input** — on-screen keyboard or text field.
7. **Touchpad settings** — sensitivity, natural scroll, tap-to-click toggles.
8. **PWA manifest** — add to home screen and open fullscreen.
9. **Automated tests + CI** — unit tests for protocol and gesture logic.
10. **Latency overlay** — show RTT and frame age for debugging.
11. **WebRTC screen streaming** — lower latency video with congestion control.
12. **Native macOS/Linux input** — reduce reliance on PyAutoGUI.
13. **Accessibility** — keyboard fallback and more screen-reader support.
14. **Localization** — multiple languages.

---

## 18. Glossary

| Term | Meaning |
| --- | --- |
| **Delta** | The change in position between two touch samples. |
| **Gain** | Multiplier applied to a delta. |
| **Acceleration** | Gain increases with finger speed. |
| **rAF** | `requestAnimationFrame`; runs before the next repaint. |
| **Backpressure** | Data is produced faster than the network can send it. |
| **Binary frame** | A WebSocket message containing raw bytes. |
| **Little-endian** | Least significant byte stored first. |
| **int16** | Signed 16-bit integer, −32768 to 32767. |
| **WebSocket** | Full-duplex protocol over a single TCP connection. |
| **WSS** | WebSocket over TLS. |
| **Tunnel** | A service that forwards public traffic to a local server. |
| **TLS** | Encryption for data in transit. |
| **DPI** | Dots per inch; Windows display scaling. |
| **mss** | Fast screen capture library. |
| **JPEG** | Lossy image compression format. |
| **FPS** | Frames per second. |
| **Latency** | Delay between action and result. |
| **Throughput** | Amount of data transferred per second. |
| **Axis lock** | Restricting a scroll gesture to one direction. |
| **Haptic** | Vibration feedback. |
| **Event loop** | The asyncio scheduler that runs async tasks. |
| **Executor** | A thread pool used to run blocking work off the event loop. |
| **Nagle’s algorithm** | TCP feature that delays small packets to combine them. |
| **TCP_NODELAY** | Socket option that disables Nagle’s algorithm. |

---

## 19. Quick reference

### Commands

```bash
# Install
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt

# Run server
python cursor_server.py

# One-click Windows
start_all.bat

# Tunnel
cloudflared tunnel --url http://localhost:8766

# Syntax checks
node --check cursor.js
python -m py_compile cursor_server.py
```

### URLs

```text
LAN:    http://<PC-IP>:8766/cursor.html
Tunnel: https://<tunnel-host>/cursor.html
```

### Ports and routes

| Item | Value |
| --- | --- |
| Server port | `8766` |
| Static routes | `/`, `/cursor.html`, `/cursor.js`, `/cursor.css` |
| Input WebSocket | same origin |
| Screen WebSocket | same origin, second connection |
| Theme key | `touchpad-theme` |

### Protocol

```text
Move:   [1][int16 LE dx][int16 LE dy]      (5 bytes)
Scroll: [2][int16 LE dy][int16 LE dx]      (5 bytes)
Screen: [3][JPEG bytes]                    (variable)
```

```json
{ "type": "mousedown", "button": "left" }
{ "type": "mouseup", "button": "left" }
{ "type": "click", "button": "right", "clicks": 1 }
{ "type": "stream", "active": true, "fps": 8, "quality": 42, "width": 760, "viewerWidth": 360 }
```

### Important constants

| Constant | Value |
| --- | --- |
| `MOVE_MIN_GAIN` | `1.15` |
| `MOVE_MAX_GAIN` | `2.9` |
| `MOVE_ACCEL_SPEED` | `14` |
| `MAX_MOVE_STEP` | `1200` |
| `SCROLL_GAIN` | `1.2` |
| `SCROLL_LOCK_PX` | `8` |
| `TAP_MAX_MS` | `220` |
| `TAP_MAX_MOVE` | `16` |
| `DOUBLE_TAP_MS` | `300` |
| `HOLD_DRAG_MS` | `320` |
| Input buffer limit | `2048` bytes |
| Screen stale timeout | `2500` ms |
| Input reconnect | `1000` ms |
| Screen reconnect | `1200` ms |

### One-line answers

- **Cursor:** relative deltas + acceleration + rAF + binary WebSocket + `SetCursorPos`.
- **Click:** time/distance threshold + JSON click.
- **Drag:** 320 ms hold + `mousedown` / `mouseup`.
- **Scroll:** two-finger midpoint + axis lock + wheel events.
- **Screen:** separate socket + `mss` + JPEG + cursor overlay + frame skipping.
- **Theme:** CSS variables + `data-theme` + `localStorage` + pre-paint script.
- **Network:** one port + static/WS sharing + Cloudflare tunnel.
- **Safety:** client cleanup + server `finally` release.

---

## 20. Final viva checklist

- [ ] I can give the 60-second explanation without notes.
- [ ] I can draw the architecture diagram.
- [ ] I can explain the full cursor path with the actual constants.
- [ ] I can explain tap, double-tap, hold-drag, scroll, and right-click.
- [ ] I can explain the 5-byte frame layout and little-endian.
- [ ] I can explain why the screen uses a separate socket.
- [ ] I can explain `bufferedAmount` and frame dropping.
- [ ] I can explain `TCP_NODELAY` and `compression=None`.
- [ ] I can explain the Win32 input calls and DPI awareness.
- [ ] I can explain the screen capture/JPEG/skip pipeline.
- [ ] I can explain the theme flash fix.
- [ ] I can explain the security limitations honestly.
- [ ] I can describe my own contribution and my teammates’ contributions.
- [ ] I can run the demo on LAN and through the tunnel.
- [ ] I have a backup plan if the network or phone fails.
- [ ] I know at least two bugs we fixed and how.
- [ ] I know the limitations and future improvements.

Good luck with the viva.
