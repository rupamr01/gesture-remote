import asyncio
import json
import socket
import websockets
import pyautogui

pyautogui.FAILSAFE = True

def get_local_ip():
    a = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    a.connect(("8.8.8.8", 80))
    ip = a.getsockname()[0]
    a.close()
    return ip

async def handle_connection(websocket):
    print("Phone connected!")
    async for message in websocket:
        data = json.loads(message)
        dx = data["dx"]
        dy = data["dy"]
        pyautogui.moveRel(dx, dy, duration=0)

async def main():
    ip = get_local_ip()
    port = 8766
    print(f"Cursor test server running: http://{ip}:8766 (websocket)")
    async with websockets.serve(handle_connection, "0.0.0.0", port):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
