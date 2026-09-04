import socket

UDP_IP = "0.0.0.0"
UDP_PORT = 6060

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind((UDP_IP, UDP_PORT))

print(f"Listening on UDP port {UDP_PORT}...")

while True:
    data, addr = sock.recvfrom(65535)

    print(
        f"Received {len(data)} bytes "
        f"from {addr[0]}:{addr[1]}"
    )