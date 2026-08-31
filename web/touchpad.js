// Connect to your PC server — replace IP if it changes
const socket = new WebSocket("ws://10.246.64.175:8765");

const statusDiv = document.getElementById("status");
const touchpad = document.getElementById("touchpad");

// Runs when connection succeeds
socket.onopen = () => {
    statusDiv.textContent = "Connected";
};

// Runs if connection drops
socket.onclose = () => {
    statusDiv.textContent = "Disconnected";
};

// Runs when finger lifts off the touchpad — for now, just send "hello"
touchpad.addEventListener("touchend", () => {
    socket.send("hello");
});