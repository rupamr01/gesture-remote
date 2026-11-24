# Gesture Remote

Turn your phone into a low-latency wireless touchpad, scroll wheel, and mouse for your computer. The mobile page and the WebSocket share one port, so a single Cloudflare tunnel exposes the whole remote.

![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-4B5563)
![Build](https://img.shields.io/badge/build-none-22C55E)

> New to the code or preparing for a viva? Read [PROJECT_GUIDE.md](PROJECT_GUIDE.md) for the full architecture, the 3-person work split, and the study checklist.
>
> Working with four builders? See [WORK_SPLIT_4_BUILDERS.md](WORK_SPLIT_4_BUILDERS.md) for the four-way ownership split.

## Features

- **Soft UI touchpad** with light and dark themes. The choice is saved on the phone.
- **Precise pointer control**: one-finger drag to move, tap to click, double-tap to double-click.
- **Hold to drag**: press and hold, then move to drag files or select text.
- **Two-finger scrolling** with axis lock, plus two-finger tap for right click.
- **Live screen preview** on demand, with a cursor overlay and fullscreen mode.
- **Low latency by design**: binary input frames, `requestAnimationFrame` batching, `TCP_NODELAY`, no compression, and a separate screen socket.
- **Works on LAN or remotely** through a Cloudflare Quick Tunnel.
- **Responsive** down to 360 px wide phones.

## Quick start

### Windows (one click)

Double-click `start_all.bat`. It starts the server on port `8766` and prints the phone URL.

### Manual setup

```powershell
git clone https://github.com/rupamr01/gesture-remote.git
cd gesture-remote
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python cursor_server.py
```

macOS / Linux:

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python cursor_server.py
```

Open the printed address on your phone:

```text
http://<YOUR-PC-IP>:8766/cursor.html
```

The phone and computer must be on the same Wi-Fi. On Windows, allow Python through the firewall for **private networks** the first time.

## Remote access

Start a free Cloudflare Quick Tunnel on the same computer:

```bash
cloudflared tunnel --url http://localhost:8766
```

Open the generated URL with `/cursor.html`:

```text
https://something.trycloudflare.com/cursor.html
```

The URL changes every time `cloudflared` restarts. No Cloudflare account is required.

> **Security:** the tunnel has no login. Anyone who has the URL can move your mouse, click, and view your screen. Share it only with people you trust, and stop the server/tunnel when you are done.

## Controls

| Gesture | Action |
| --- | --- |
| One-finger drag | Move the pointer |
| Tap | Left click |
| Double-tap | Double-click |
| Hold, then drag | Hold the left button and drag |
| Two-finger drag | Scroll vertically or horizontally (axis lock) |
| Two-finger tap | Right click |
| Screen button | Show or hide the live screen |
| Theme button | Switch light / dark mode |

The screen preview is view-only. Tapping it toggles fullscreen instead of sending a click.

## How it works

```text
Phone browser
  ├─ HTTPS  ──> static page (cursor.html / css / js)
  ├─ WSS    ──> input socket  (binary move + scroll, JSON clicks)
  └─ WSS    ──> screen socket (JPEG frames)
                    │
          cursor_server.py :8766
                    │
        Windows native input / PyAutoGUI fallback
```

- `websockets` serves the page and both sockets from **one port**, so one tunnel covers everything.
- Windows input uses the native Win32 API (`SetCursorPos`, `mouse_event`) directly, with no PyAutoGUI delay.
- Input and screen use **separate WebSocket connections**, so a busy screen stream never blocks the pointer.
- Screen capture runs in one worker thread. Frames are resized, JPEG-encoded, and unchanged frames are skipped with a one-second heartbeat.
- The client batches movement with `requestAnimationFrame` and only sends the latest delta.

## Project layout

| File | Purpose |
| --- | --- |
| `cursor.html` | Mobile page, theme bootstrap, screen viewer |
| `cursor.css` | Self-contained Soft UI styles and light/dark palettes |
| `cursor.js` | Touch gestures, theme persistence, input and screen sockets |
| `cursor_server.py` | Static server, WebSocket server, input backend, screen stream |
| `start_all.bat` | Windows launcher for port `8766` |
| `requirements.txt` | Python dependencies |

## Performance tuning

Stream profiles live in `cursor.js`:

| Network | FPS | JPEG quality | Width |
| --- | --- | --- | --- |
| Cloudflare tunnel | 8 | 42 | 760 px |
| LAN | 12 | 55 | 960 px |

The server clamps values to safe ranges: **1–20 FPS**, **30–80 quality**, **480–1280 px width**. Lower values reduce bandwidth and latency; higher values look sharper.

The theme is stored in `localStorage` under `touchpad-theme`. An inline script applies dark mode before the first paint to avoid a flash.

## WebSocket protocol

Client to server:

| Frame | Meaning |
| --- | --- |
| `[1][int16 LE dx][int16 LE dy]` | Relative pointer move |
| `[2][int16 LE dy][int16 LE dx]` | Scroll |
| `{"type":"mousedown","button":"left"}` | Press a button |
| `{"type":"mouseup","button":"left"}` | Release a button |
| `{"type":"click","button":"right","clicks":1}` | Click |
| `{"type":"stream","active":true,...}` | Start/configure the screen stream |

Server to client:

| Frame | Meaning |
| --- | --- |
| `[3][JPEG bytes]` | Screen frame |

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Phone cannot open the page | Same Wi-Fi, correct PC IP, Windows firewall allows Python on private networks |
| Page loads but pointer does not move | Check the status pill; reload the page; make sure the server window is still running |
| No screen preview | `pip install mss pillow`; screen capture must be available on the desktop |
| Laggy screen | Use LAN instead of the tunnel, or lower FPS/quality/width in `cursor.js` |
| Port already in use | Change `8766` in `cursor_server.py` and `start_all.bat` |
| Theme did not change | Hard-refresh the page to load the latest `cursor.css` / `cursor.js` |

## Limitations

- No authentication; use only on trusted networks or with a private tunnel.
- The remote controls the active desktop only. UAC secure-desktop prompts cannot be controlled.
- Cloudflare Quick Tunnels are best-effort and not meant for permanent hosting.
- macOS/Linux input uses the PyAutoGUI fallback; Windows has the lowest latency.

## License

No license has been added yet. All rights reserved by the author.
