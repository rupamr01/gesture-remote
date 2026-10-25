import asyncio, io, json, mss, websockets, pyautogui
from PIL import Image, ImageDraw

pyautogui.PAUSE = 0
pyautogui.FAILSAFE = False

# phone se sirf ye gestures allowed hain (safe)
GESTURES = {
    "swipe_up":    lambda: pyautogui.press("winleft"),                 # overview
    "swipe_down":  lambda: pyautogui.hotkey("winleft", "d"),           # show desktop
    "swipe_left":  lambda: pyautogui.hotkey("ctrl", "alt", "right"),   # next workspace
    "swipe_right": lambda: pyautogui.hotkey("ctrl", "alt", "left"),    # prev workspace
}

async def send_frames(ws):
    with mss.mss() as sct:
        mon = sct.monitors[1]
        while True:
            shot = sct.grab(mon)
            img = Image.frombytes("RGB", shot.size, shot.rgb)

            cx, cy = pyautogui.position()
            cx -= mon["left"]; cy -= mon["top"]
            d = ImageDraw.Draw(img)
            pts = [(cx, cy), (cx, cy + 28), (cx + 8, cy + 21),
                   (cx + 14, cy + 34), (cx + 20, cy + 31),
                   (cx + 14, cy + 19), (cx + 24, cy + 19)]
            d.polygon(pts, fill="white", outline="black")

            img = img.resize((img.width // 2, img.height // 2))
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=50)
            await ws.send(buf.getvalue())
            await asyncio.sleep(1 / 12)

def handle(d):
    t = d["type"]
    if t == "rel":
        pyautogui.moveRel(int(d["dx"]), int(d["dy"]))
    elif t == "click":
        pyautogui.click(button=d["button"])
    elif t == "down":
        pyautogui.mouseDown(button=d["button"])
    elif t == "up":
        pyautogui.mouseUp(button=d["button"])
    elif t == "scroll":
        if d.get("v"): pyautogui.scroll(int(d["v"]))
        if d.get("h"): pyautogui.hscroll(int(d["h"]))
    elif t == "zoom":
        pyautogui.keyDown("ctrl")
        pyautogui.scroll(int(d["amount"]))
        pyautogui.keyUp("ctrl")
    elif t == "gesture":
        fn = GESTURES.get(d["name"])
        if fn: fn()

async def handler(ws):
    print("phone connected")
    sender = asyncio.create_task(send_frames(ws))
    try:
        async for msg in ws:
            handle(json.loads(msg))
    except websockets.ConnectionClosed:
        pass
    finally:
        pyautogui.mouseUp(button="left")   # drag atka na rahe
        sender.cancel()
        print("phone disconnected")

async def main():
    async with websockets.serve(handler, "0.0.0.0", 8765):
        print("server on :8765")
        await asyncio.Future()

asyncio.run(main())