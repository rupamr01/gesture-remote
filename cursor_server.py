import asyncio
import json
import socket
import sys
import websockets
import pyautogui

# Disable default pause and safety boundaries for ultra-low latency
pyautogui.PAUSE = 0
pyautogui.FAILSAFE = False

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

async def handle_connection(websocket, path=None):
    print("Phone connected successfully!")
    try:
        async for message in websocket:
            data = json.loads(message)
            msg_type = data.get("type")
            
            if msg_type == "move":
                dx = data.get("dx", 0)
                dy = data.get("dy", 0)
                pyautogui.moveRel(dx, dy, _pause=False)
                
            elif msg_type == "scroll":
                dy = data.get("dy", 0)
                # Scroll multiplier tuned for Windows/Linux UI responsiveness
                scroll_amount = int(-dy * 4)
                if scroll_amount != 0:
                    pyautogui.scroll(scroll_amount, _pause=False)
                
            elif msg_type == "click":
                button = data.get("button", "left")
                clicks = data.get("clicks", 1)
                pyautogui.click(button=button, clicks=clicks, interval=0.08, _pause=False)
                
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        print(f"Connection event: {e}")
    finally:
        print("Phone disconnected!")

async def main():
    ip = get_local_ip()
    port = 8766
    print("===================================================")
    print(f" Remote Trackpad Server Live")
    print(f" WebSocket IP Target: ws://{ip}:{port}")
    print("===================================================")
    
    async with websockets.serve(handle_connection, "0.0.0.0", port):
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
