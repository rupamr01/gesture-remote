import asyncio
import socket
import websockets


def get_local_ip():
    a=socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    a.connect(("8.8.8.8", 80))
    print(a)

ip = a.getsockname()[0]
print(ip)
get_local_ip()