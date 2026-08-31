import asyncio
import socket
import websockets


def get_local_ip():
    a=socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    a.connect(("8.8.8.8", 80))
    ip = a.getsockname()[0]
    print(ip)
    print(a)
    a.close()
    return ip


ip =get_local_ip()
async def handle_connection(websocket):
    print("Phone connected!")
    async for message in websocket:
        print(f"Received: {message}")

async def main():
    port = 8765
    print(f"Server starting on {ip}:{port}")
    async with websockets.serve(handle_connection, "0.0.0.0", port):
        await asyncio.Future()  # forever wait

if __name__ == "__main__":
    asyncio.run(main())