import asyncio
import contextlib
import ctypes
import io
import json
import socket
import struct
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

import websockets
from websockets.asyncio.server import ServerConnection
from websockets.datastructures import Headers
from websockets.http11 import Response

try:
    import mss
    from PIL import Image, ImageChops, ImageDraw

    SCREEN_AVAILABLE = True
except ImportError:
    SCREEN_AVAILABLE = False


# ---------------------------------------------------------------------------
# Input backend
#
# Windows uses the native API directly: no PyAutoGUI wrapper, no extra Python
# work between the WebSocket frame and the cursor movement. PyAutoGUI remains
# the fallback on other platforms.
# ---------------------------------------------------------------------------

IS_WINDOWS = sys.platform == "win32"

if IS_WINDOWS:
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)

    # Match PyAutoGUI: keep cursor coordinates in physical screen pixels.
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass

    _cursor = wintypes.POINT()

    user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
    user32.GetCursorPos.restype = wintypes.BOOL
    user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
    user32.SetCursorPos.restype = wintypes.BOOL
    user32.mouse_event.argtypes = [
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_size_t,
    ]
    user32.mouse_event.restype = None

    MOUSEEVENTF_LEFTDOWN = 0x0002
    MOUSEEVENTF_LEFTUP = 0x0004
    MOUSEEVENTF_RIGHTDOWN = 0x0008
    MOUSEEVENTF_RIGHTUP = 0x0010
    MOUSEEVENTF_MIDDLEDOWN = 0x0020
    MOUSEEVENTF_MIDDLEUP = 0x0040
    MOUSEEVENTF_WHEEL = 0x0800
    MOUSEEVENTF_HWHEEL = 0x1000

    BUTTON_FLAGS = {
        "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    }

    def move_rel(dx, dy):
        dx = int(dx)
        dy = int(dy)
        if dx == 0 and dy == 0:
            return
        if user32.GetCursorPos(ctypes.byref(_cursor)):
            user32.SetCursorPos(_cursor.x + dx, _cursor.y + dy)

    def scroll(dy, dx=0):
        vertical = int(-dy * 4)
        if vertical:
            user32.mouse_event(
                MOUSEEVENTF_WHEEL, 0, 0, ctypes.c_uint32(vertical).value, 0
            )

        horizontal = int(dx * 4)
        if horizontal:
            user32.mouse_event(
                MOUSEEVENTF_HWHEEL, 0, 0, ctypes.c_uint32(horizontal).value, 0
            )

    def click(button, clicks):
        down, up = BUTTON_FLAGS.get(button, BUTTON_FLAGS["left"])
        for _ in range(max(1, min(int(clicks), 5))):
            user32.mouse_event(down, 0, 0, 0, 0)
            user32.mouse_event(up, 0, 0, 0, 0)

    def mouse_down(button="left"):
        down, _ = BUTTON_FLAGS.get(button, BUTTON_FLAGS["left"])
        user32.mouse_event(down, 0, 0, 0, 0)

    def mouse_up(button="left"):
        _, up = BUTTON_FLAGS.get(button, BUTTON_FLAGS["left"])
        user32.mouse_event(up, 0, 0, 0, 0)

    def cursor_position():
        if user32.GetCursorPos(ctypes.byref(_cursor)):
            return _cursor.x, _cursor.y
        return None

else:
    import pyautogui

    pyautogui.PAUSE = 0
    pyautogui.FAILSAFE = False

    def move_rel(dx, dy):
        pyautogui.moveRel(dx, dy, _pause=False)

    def scroll(dy, dx=0):
        if dy:
            pyautogui.scroll(int(-dy * 4), _pause=False)
        if dx:
            pyautogui.hscroll(int(dx * 4), _pause=False)

    def click(button, clicks):
        pyautogui.click(
            button=button, clicks=clicks, interval=0.08, _pause=False
        )

    def mouse_down(button="left"):
        pyautogui.mouseDown(button=button, _pause=False)

    def mouse_up(button="left"):
        pyautogui.mouseUp(button=button, _pause=False)

    def cursor_position():
        return None


# ---------------------------------------------------------------------------
# Screen capture (streamed on demand over the same WebSocket)
# ---------------------------------------------------------------------------

DEFAULT_FPS = 12
DEFAULT_QUALITY = 55
DEFAULT_WIDTH = 960
CURSOR_CSS_PX = 12

MIN_FPS, MAX_FPS = 1, 20
MIN_QUALITY, MAX_QUALITY = 30, 80
MIN_WIDTH, MAX_WIDTH = 480, 1280

# Client -> server binary events.
EVENT_MOVE = 1
EVENT_SCROLL = 2
# Server -> client binary event: [3][JPEG bytes].
EVENT_SCREEN = 3

if SCREEN_AVAILABLE:
    _SCREEN_THREAD = threading.local()
    _SCREEN_EXECUTOR = ThreadPoolExecutor(max_workers=1)

    # Mouse pointer shape, in output pixels at its natural size.
    _ARROW = (
        (0.0, 0.0),
        (0.0, 18.0),
        (4.6, 13.8),
        (7.8, 21.2),
        (11.0, 19.7),
        (7.8, 12.7),
        (13.8, 11.7),
    )

    def _screen():
        sct = getattr(_SCREEN_THREAD, "sct", None)
        if sct is None:
            # mss 10 renamed the factory; support both spellings.
            factory = getattr(mss, "MSS", None) or mss.mss
            sct = factory()
            _SCREEN_THREAD.sct = sct
        return sct

    def _draw_cursor(image, x, y, scale):
        draw = ImageDraw.Draw(image)
        points = [(x + px * scale, y + py * scale) for px, py in _ARROW]
        draw.polygon(points, fill=(255, 255, 255))
        draw.line(
            points + [points[0]],
            fill=(0, 0, 0),
            width=max(1, round(scale * 1.4)),
            joint="curve",
        )

    def capture_jpeg(width, quality, state=None, cursor_px=0.0):
        sct = _screen()
        monitor = sct.monitors[1]
        shot = sct.grab(monitor)

        image = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")

        if width < image.width:
            height = max(1, round(image.height * width / image.width))
            image = image.resize((width, height), Image.Resampling.BILINEAR)

        position = cursor_position()

        if state is not None:
            # While the screen is idle, skip JPEG encoding entirely. A small
            # grayscale thumbnail is enough to detect changes; a heartbeat
            # frame goes out once a second so the client stays "live".
            thumb = image.resize(
                (64, max(1, round(image.height * 64 / image.width))),
                Image.Resampling.BILINEAR,
            ).convert("L")
            now = time.perf_counter()
            previous = state.get("thumb")
            changed = (
                previous is None
                or previous.size != thumb.size
                or ImageChops.difference(thumb, previous).getbbox() is not None
            )
            moved = position != state.get("cursor")
            state["thumb"] = thumb
            state["cursor"] = position

            if not changed and not moved and now - state.get("sent", 0.0) < 1.0:
                return None

            state["sent"] = now

        if position is not None:
            # The captured frame can be smaller than the physical monitor.
            scale_x = image.width / monitor["width"]
            scale_y = image.height / monitor["height"]
            x = (position[0] - monitor["left"]) * scale_x
            y = (position[1] - monitor["top"]) * scale_y
            if 0 <= x < image.width and 0 <= y < image.height:
                if cursor_px <= 0:
                    cursor_px = width * 0.02
                pointer_scale = max(0.3, min(3.0, cursor_px / 21.2))
                _draw_cursor(image, x, y, pointer_scale)

        buffer = io.BytesIO()
        image.save(
            buffer,
            "JPEG",
            quality=quality,
            optimize=False,
            progressive=False,
            subsampling=2,
        )
        return buffer.getvalue()

    async def send_screen(websocket, config):
        loop = asyncio.get_running_loop()
        frames = 0
        total_bytes = 0
        started = time.perf_counter()
        last_error = 0.0
        state = {}

        try:
            while True:
                frame_started = time.perf_counter()
                fps = config["fps"]
                quality = config["quality"]
                width = config["width"]

                # Size the drawn pointer in real display pixels: a 14 CSS px
                # pointer on the phone, whatever size the viewer is rendered at.
                viewer_width = config.get("viewer_width", 0)
                if viewer_width:
                    cursor_px = max(
                        8.0, min(48.0, CURSOR_CSS_PX * width / viewer_width)
                    )
                else:
                    cursor_px = 0.0

                try:
                    jpeg = await loop.run_in_executor(
                        _SCREEN_EXECUTOR,
                        capture_jpeg,
                        width,
                        quality,
                        state,
                        cursor_px,
                    )
                except Exception as exc:
                    now = time.perf_counter()
                    if now - last_error > 5:
                        print(f"Screen capture failed: {exc}", flush=True)
                        last_error = now
                    await asyncio.sleep(0.5)
                    continue

                if jpeg is not None:
                    frame = bytearray(len(jpeg) + 1)
                    frame[0] = EVENT_SCREEN
                    frame[1:] = jpeg
                    await websocket.send(frame)

                    frames += 1
                    total_bytes += len(frame)

                delay = (1.0 / fps) - (time.perf_counter() - frame_started)
                if delay > 0:
                    await asyncio.sleep(delay)

                if frames and frames % 120 == 0:
                    elapsed = time.perf_counter() - started
                    print(
                        f"Screen: {frames / elapsed:.1f} fps, "
                        f"{total_bytes / frames / 1024:.0f} KB/frame",
                        flush=True,
                    )
        except websockets.exceptions.ConnectionClosed:
            return
        except Exception as exc:
            print(f"Screen stream stopped: {exc}", flush=True)


def update_stream_config(message, config):
    config["active"] = bool(message.get("active", config["active"]))

    try:
        if "fps" in message:
            config["fps"] = max(MIN_FPS, min(MAX_FPS, int(message["fps"])))
        if "quality" in message:
            config["quality"] = max(
                MIN_QUALITY, min(MAX_QUALITY, int(message["quality"]))
            )
        if "width" in message:
            config["width"] = max(
                MIN_WIDTH, min(MAX_WIDTH, int(message["width"]))
            )
        if "viewerWidth" in message:
            config["viewer_width"] = max(
                100, min(4000, int(message["viewerWidth"]))
            )
    except (TypeError, ValueError):
        pass


# ---------------------------------------------------------------------------
# WebSocket server
# ---------------------------------------------------------------------------


class LowLatencyConnection(ServerConnection):
    """Disable Nagle's algorithm on accepted connections."""

    def connection_made(self, transport):
        try:
            sock = transport.get_extra_info("socket")
            if sock is not None:
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        super().connection_made(transport)


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


BASE_DIR = Path(__file__).resolve().parent

STATIC_ROUTES = {
    "/": ("cursor.html", "text/html; charset=utf-8"),
    "/cursor.html": ("cursor.html", "text/html; charset=utf-8"),
    "/cursor.js": ("cursor.js", "text/javascript; charset=utf-8"),
    "/cursor.css": ("cursor.css", "text/css; charset=utf-8"),
}


def serve_static(connection, request):
    """Serve the remote's page on the same port as the WebSocket.

    That way a single tunnel (one public URL) covers both the page and the
    input/screen socket.
    """
    path = urlsplit(request.path).path

    # Let the WebSocket handshake through instead of serving a page for it.
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return None

    route = STATIC_ROUTES.get(path)
    if route is None:
        if path == "/favicon.ico":
            return connection.respond(204, "")
        return connection.respond(404, "Not found\n")

    filename, content_type = route
    try:
        body = (BASE_DIR / filename).read_bytes()
    except OSError:
        return connection.respond(500, "Missing file\n")

    headers = Headers(
        {
            "Content-Type": content_type,
            "Content-Length": str(len(body)),
            "Cache-Control": "no-store",
        }
    )
    return Response(200, "OK", headers, body)


def process_message(message, state=None):
    """Decode and dispatch one input packet.

    Move and scroll events arrive as compact binary frames. Clicks, drags and
    legacy clients use JSON text.
    """
    if isinstance(message, (bytes, bytearray, memoryview)):
        if len(message) >= 5 and message[0] == EVENT_MOVE:
            dx, dy = struct.unpack_from("<hh", message, 1)
            move_rel(dx, dy)
        elif len(message) >= 5 and message[0] == EVENT_SCROLL:
            dy, dx = struct.unpack_from("<hh", message, 1)
            scroll(dy, dx)
        elif len(message) >= 3 and message[0] == EVENT_SCROLL:
            (dy,) = struct.unpack_from("<h", message, 1)
            scroll(dy)
        return

    data = json.loads(message)
    if not isinstance(data, dict):
        return

    msg_type = data.get("type")

    if msg_type == "move":                     # legacy text fallback
        move_rel(data.get("dx", 0), data.get("dy", 0))
    elif msg_type == "scroll":                 # legacy text fallback
        scroll(data.get("dy", 0), data.get("dx", 0))
    elif msg_type == "mousedown":
        button = data.get("button", "left")
        mouse_down(button)
        if state is not None:
            state["held"] = button
    elif msg_type == "mouseup":
        button = data.get("button", "left")
        mouse_up(button)
        if state is not None and state.get("held") == button:
            state["held"] = None
    elif msg_type == "click":
        click(
            data.get("button", "left"),
            data.get("clicks", 1),
        )


async def handle_connection(websocket):
    print("Phone connected", flush=True)

    stream_config = {
        "active": False,
        "fps": DEFAULT_FPS,
        "quality": DEFAULT_QUALITY,
        "width": DEFAULT_WIDTH,
        "viewer_width": 0,
    }
    screen_task = None
    state = {"held": None}

    async def stop_screen():
        nonlocal screen_task
        if screen_task is not None:
            screen_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await screen_task
            screen_task = None
            print("Screen stream stopped", flush=True)

    try:
        async for message in websocket:
            if isinstance(message, (bytes, bytearray, memoryview)):
                try:
                    process_message(message, state)
                except (AttributeError, TypeError, ValueError, KeyError, OverflowError):
                    continue
                continue

            try:
                data = json.loads(message)
            except (TypeError, ValueError):
                continue

            if not isinstance(data, dict):
                continue

            if data.get("type") == "stream":
                update_stream_config(data, stream_config)

                if stream_config["active"]:
                    if not SCREEN_AVAILABLE:
                        print(
                            "Screen capture unavailable: pip install mss pillow",
                            flush=True,
                        )
                        continue

                    if screen_task is None or screen_task.done():
                        screen_task = asyncio.create_task(
                            send_screen(websocket, stream_config)
                        )
                        print("Screen stream started", flush=True)
                else:
                    await stop_screen()
                continue

            try:
                process_message(message, state)
            except (AttributeError, TypeError, ValueError, KeyError, OverflowError):
                continue
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as exc:
        print(f"Connection event: {exc}", flush=True)
    finally:
        if state["held"] is not None:
            with contextlib.suppress(Exception):
                mouse_up(state["held"])
            state["held"] = None

        if screen_task is not None:
            screen_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await screen_task
        print("Phone disconnected", flush=True)


async def main():
    ip = get_local_ip()
    port = 8766

    print("===================================================")
    print(" Touchpad + Screen Server Live")
    print(f" Phone:     http://{ip}:{port}/cursor.html")
    print(f" WebSocket: ws://{ip}:{port}")
    print(" Tunnel:    cloudflared tunnel --url http://localhost:8766")
    print(" Screen:    on demand over a separate connection")
    if not SCREEN_AVAILABLE:
        print(" Screen capture off: pip install mss pillow")
    print("===================================================", flush=True)

    async with websockets.serve(
        handle_connection,
        "0.0.0.0",
        port,
        compression=None,          # tiny input frames don't need deflate
        create_connection=LowLatencyConnection,
        process_request=serve_static,
        ping_interval=20,
        ping_timeout=20,
    ):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
