const socket = new WebSocket("ws://10.246.64.175:8766");
const pad = document.getElementById("pad");

socket.onopen = () => {
    pad.textContent = "Connected - drag now";
};

socket.onerror = (err) => {
    pad.textContent = "WebSocket ERROR";
};

socket.onclose = () => {
    pad.textContent = "Disconnected";
};

let lastX = 0;
let lastY = 0;

pad.addEventListener("touchstart", (e) => {
    lastX = e.touches[0].clientX;
    lastY = e.touches[0].clientY;
    pad.textContent = "touchstart fired";
});

pad.addEventListener("touchmove", (e) => {
    e.preventDefault();
    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;

    const dx = x - lastX;
    const dy = y - lastY;

    pad.textContent = "dx:" + dx + " dy:" + dy;

    socket.send(JSON.stringify({ dx: dx, dy: dy }));

    lastX = x;
    lastY = y;
});
