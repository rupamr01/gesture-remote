const statusEl = document.getElementById("status");
// Dynamic Host IP Resolution
const wsUrl = "ws://" + window.location.hostname + ":8766";
const socket = new WebSocket(wsUrl);

socket.onopen = () => { statusEl.textContent = "Connected"; statusEl.style.color = "#4ade80"; };
socket.onerror = () => { statusEl.textContent = "Connection error"; statusEl.style.color = "#f87171"; };
socket.onclose = () => { statusEl.textContent = "Disconnected"; statusEl.style.color = "#fbbf24"; };

let pendingDX = 0, pendingDY = 0, pendingScrollDY = 0;
let lastX = 0, lastY = 0, lastTwoFingerY = 0;
let lastTouchCount = 0, lastTapTime = 0, touchStartTime = 0;
let isMultiTouch = false;

// 60FPS Frame Batch Loop
function frameLoop() {
    if (socket.readyState === WebSocket.OPEN) {
        if (Math.abs(pendingDX) > 0.1 || Math.abs(pendingDY) > 0.1) {
            socket.send(JSON.stringify({ type: "move", dx: pendingDX, dy: pendingDY }));
            pendingDX = 0; pendingDY = 0;
        }
        if (Math.abs(pendingScrollDY) > 0.2) {
            socket.send(JSON.stringify({ type: "scroll", dy: pendingScrollDY }));
            pendingScrollDY = 0;
        }
    }
    requestAnimationFrame(frameLoop);
}
requestAnimationFrame(frameLoop);

document.addEventListener("touchstart", (e) => {
    touchStartTime = Date.now();
    lastTouchCount = e.touches.length;

    if (e.touches.length === 1) {
        isMultiTouch = false;
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
    } else if (e.touches.length >= 2) {
        isMultiTouch = true;
        lastTwoFingerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    }
}, { passive: false });

document.addEventListener("touchmove", (e) => {
    e.preventDefault();

    if (e.touches.length === 1 && !isMultiTouch) {
        const x = e.touches[0].clientX;
        const y = e.touches[0].clientY;
        pendingDX += (x - lastX) * 1.6;
        pendingDY += (y - lastY) * 1.6;
        lastX = x; lastY = y;
    }
    else if (e.touches.length >= 2) {
        const currentY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        pendingScrollDY += (currentY - lastTwoFingerY);
        lastTwoFingerY = currentY;
    }
}, { passive: false });

document.addEventListener("touchend", (e) => {
    const duration = Date.now() - touchStartTime;
    const now = Date.now();

    if (duration < 170) {
        if (lastTouchCount === 1 && !isMultiTouch) {
            if (now - lastTapTime < 280) {
                socket.send(JSON.stringify({ type: "click", button: "left", clicks: 2 }));
                lastTapTime = 0;
            } else {
                socket.send(JSON.stringify({ type: "click", button: "left", clicks: 1 }));
                lastTapTime = now;
            }
        } else if (lastTouchCount >= 2 || isMultiTouch) {
            socket.send(JSON.stringify({ type: "click", button: "right", clicks: 1 }));
        }
    }
});
