(() => {
    "use strict";

    const pad = document.getElementById("pad");
    const statusEl = document.getElementById("status");
    const statusText = document.getElementById("status-text");
    const glowEl = document.getElementById("glow");
    const viewer = document.getElementById("viewer");
    const screenCanvas = document.getElementById("screen");
    const screenCtx = screenCanvas.getContext("2d", { alpha: false });
    const screenToggle = document.getElementById("screen-toggle");
    const viewerStateText = document.getElementById("viewer-state-text");
    const fullscreenBtn = document.getElementById("viewer-fullscreen");
    const themeToggle = document.getElementById("theme-toggle");
    const themeColorMeta = document.getElementById("theme-color");

    /* ---------- Theme ---------- */

    const THEME_KEY = "touchpad-theme";

    function applyTheme(theme, persist) {
        const dark = theme === "dark";

        document.documentElement.dataset.theme = dark ? "dark" : "light";
        themeToggle.setAttribute("aria-pressed", dark ? "true" : "false");

        const label = dark ? "Switch to light mode" : "Switch to dark mode";
        themeToggle.setAttribute("aria-label", label);
        themeToggle.title = label;

        if (themeColorMeta) {
            themeColorMeta.content = dark ? "#20232a" : "#e9edf4";
        }

        if (persist) {
            try {
                localStorage.setItem(THEME_KEY, theme);
            } catch (error) {
                // Storage can be blocked; the current session still switches.
            }
        }
    }

    if (themeToggle) {
        applyTheme(
            document.documentElement.dataset.theme === "dark" ? "dark" : "light",
            false
        );

        themeToggle.addEventListener("click", () => {
            applyTheme(
                document.documentElement.dataset.theme === "dark" ? "light" : "dark",
                true
            );
        });
    }

    // Same-origin socket when the page is served by the Python server (also
    // through a tunnel). The LAN fallback keeps the old two-port setup working.
    const wsOverride = new URLSearchParams(window.location.search).get("ws");
    const WS_URL = wsOverride
        ? wsOverride
        : window.location.protocol === "https:"
            ? "wss://" + window.location.host
            : window.location.port === "8766"
                ? "ws://" + window.location.host
                : "ws://" + window.location.hostname + ":8766";

    let socket = null;
    let reconnectTimer = null;

    function setStatus(state, label) {
        statusEl.dataset.state = state;
        statusText.textContent = label;
        statusEl.title = label;
    }

    function connect() {
        clearTimeout(reconnectTimer);
        setStatus("connecting", "Connecting");

        socket = new WebSocket(WS_URL);
        socket.binaryType = "arraybuffer";

        socket.addEventListener("open", () => {
            setStatus("connected", "Connected");
        });

        socket.addEventListener("error", () => {
            setStatus("offline", "Reconnecting");
        });

        socket.addEventListener("close", () => {
            setStatus("offline", "Reconnecting");
            clearDragTimer();
            endDrag();
            resetMovement();
            reconnectTimer = setTimeout(connect, 1000);
        });
    }

    function canSend(urgent) {
        if (!socket || socket.readyState !== WebSocket.OPEN) return false;
        return urgent || socket.bufferedAmount <= 2048;
    }

    function send(payload, urgent = false) {
        if (!canSend(urgent)) return false;
        socket.send(JSON.stringify(payload));
        return true;
    }

    function sendFrame(frame, urgent = false) {
        if (!canSend(urgent)) return false;
        socket.send(frame);
        return true;
    }

    connect();

    window.addEventListener("pagehide", () => {
        clearDragTimer();
        endDrag();
    });

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            glowEl.style.opacity = "0";
            clearDragTimer();
            endDrag();
            if (viewerOpen) stopScreen();
            return;
        }

        if (!socket || socket.readyState === WebSocket.CLOSED) {
            connect();
        }

        if (viewerOpen) startScreen();
    });

    function haptic(ms) {
        if (navigator.vibrate) {
            navigator.vibrate(ms);
        }
    }

    /* ---------- Live screen ---------- */

    // Screen frames use a dedicated socket, so a burst of large JPEGs can
    // never queue in front of touch input. The server only sends frames while
    // the viewer is open, and a tunnel gets a lighter stream by default.
    const IS_TUNNEL = window.location.protocol === "https:";
    const SCREEN_STALE_MS = 2500;
    const STREAM_SETTINGS = IS_TUNNEL
        ? { fps: 8, quality: 42, width: 760 }
        : { fps: 12, quality: 55, width: 960 };

    let screenSocket = null;
    let screenReconnectTimer = null;
    let viewerOpen = false;
    let viewerStateName = "";
    let screenRequested = false;
    let screenDecoding = false;
    let screenLastFrame = 0;

    function setViewerState(state, label) {
        viewerStateName = state;
        viewer.dataset.state = state;
        viewerStateText.textContent = label;
    }

    function viewerWidthCss() {
        const width = screenCanvas.getBoundingClientRect().width;
        return Math.max(120, Math.round(width || 360));
    }

    function sendStream(active) {
        if (!screenSocket || screenSocket.readyState !== WebSocket.OPEN) {
            return false;
        }

        screenSocket.send(
            JSON.stringify({
                type: "stream",
                active: active,
                fps: STREAM_SETTINGS.fps,
                quality: STREAM_SETTINGS.quality,
                width: STREAM_SETTINGS.width,
                viewerWidth: viewerWidthCss(),
            })
        );
        return true;
    }

    function connectScreen() {
        if (!viewerOpen) return;

        if (
            screenSocket &&
            (screenSocket.readyState === WebSocket.OPEN ||
                screenSocket.readyState === WebSocket.CONNECTING)
        ) {
            return;
        }

        clearTimeout(screenReconnectTimer);

        const ws = new WebSocket(WS_URL);
        ws.binaryType = "arraybuffer";
        screenSocket = ws;

        ws.addEventListener("message", (event) => {
            if (typeof event.data === "string") return;
            if (event.data.byteLength < 2) return;
            if (new Uint8Array(event.data, 0, 1)[0] !== 3) return;
            handleScreenFrame(event.data);
        });

        ws.addEventListener("open", () => {
            if (screenSocket !== ws || !viewerOpen) return;
            screenLastFrame = performance.now();
            screenRequested = sendStream(true);
        });

        ws.addEventListener("close", () => {
            if (screenSocket !== ws) return;

            screenSocket = null;
            screenRequested = false;
            screenDecoding = false;

            if (!viewerOpen) return;

            setViewerState("connecting", "Reconnecting screen");
            screenReconnectTimer = setTimeout(connectScreen, 1200);
        });

        ws.addEventListener("error", () => {});
    }

    function startScreen() {
        if (!viewerOpen) return;

        screenLastFrame = performance.now();
        setViewerState("connecting", "Connecting");

        if (screenSocket && screenSocket.readyState === WebSocket.OPEN) {
            screenRequested = sendStream(true);
        } else {
            connectScreen();
        }
    }

    function stopScreen() {
        clearTimeout(screenReconnectTimer);
        clearTimeout(viewerSizeTimer);
        screenReconnectTimer = null;
        viewerSizeTimer = 0;

        if (screenRequested) sendStream(false);

        screenRequested = false;
        screenDecoding = false;
        screenLastFrame = 0;

        const ws = screenSocket;
        screenSocket = null;

        if (ws && ws.readyState <= WebSocket.OPEN) {
            try {
                ws.close();
            } catch (error) {
                // ignore
            }
        }

        if (viewerOpen) setViewerState("connecting", "Connecting");
    }

    // Keep the drawn pointer a normal size when the viewer is resized or
    // rotated, by telling the server the rendered width.
    let viewerSizeTimer = 0;

    function refreshViewerSize() {
        if (!viewerOpen || !screenRequested) return;

        clearTimeout(viewerSizeTimer);
        viewerSizeTimer = setTimeout(() => {
            if (viewerOpen && screenRequested) sendStream(true);
        }, 250);
    }

    if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(refreshViewerSize).observe(screenCanvas);
    }

    function handleScreenFrame(buffer) {
        if (!viewerOpen || !screenRequested) return;
        if (buffer.byteLength < 2) return;

        screenLastFrame = performance.now();
        if (viewerStateName !== "live") setViewerState("live", "Live");

        // If decoding is still busy, drop this frame rather than queueing it.
        // The next frame is always fresher than a backlog.
        if (screenDecoding) return;

        screenDecoding = true;

        createImageBitmap(new Blob([buffer.slice(1)], { type: "image/jpeg" }))
            .then((bitmap) => {
                if (
                    screenCanvas.width !== bitmap.width ||
                    screenCanvas.height !== bitmap.height
                ) {
                    screenCanvas.width = bitmap.width;
                    screenCanvas.height = bitmap.height;
                }

                screenCtx.drawImage(bitmap, 0, 0);
                bitmap.close();
            })
            .catch(() => {})
            .finally(() => {
                screenDecoding = false;
            });
    }

    function openViewer() {
        if (viewerOpen) return;

        viewerOpen = true;
        viewer.hidden = false;
        document.body.classList.add("viewing");
        screenToggle.setAttribute("aria-pressed", "true");
        screenToggle.setAttribute("aria-label", "Hide laptop screen");
        startScreen();
    }

    function closeViewer() {
        if (!viewerOpen) return;

        viewerOpen = false;
        stopScreen();

        if (document.fullscreenElement === viewer && document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
        }

        viewer.hidden = true;
        document.body.classList.remove("viewing");
        screenToggle.setAttribute("aria-pressed", "false");
        screenToggle.setAttribute("aria-label", "Show laptop screen");
    }

    async function toggleFullscreen() {
        if (document.fullscreenElement === viewer) {
            try {
                await document.exitFullscreen();
            } catch (error) {
                // ignore
            }
            return;
        }

        try {
            await viewer.requestFullscreen();
            if (screen.orientation && screen.orientation.lock) {
                await screen.orientation.lock("landscape");
            }
        } catch (error) {
            // fullscreen or orientation lock is not available
        }
    }

    screenToggle.addEventListener("click", () => {
        if (viewerOpen) closeViewer();
        else openViewer();
    });

    fullscreenBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleFullscreen();
    });

    screenCanvas.addEventListener("click", toggleFullscreen);

    document.addEventListener("fullscreenchange", () => {
        const full = document.fullscreenElement === viewer;
        fullscreenBtn.setAttribute(
            "aria-label",
            full ? "Exit fullscreen" : "Enter fullscreen"
        );

        if (!full && screen.orientation && screen.orientation.unlock) {
            try {
                screen.orientation.unlock();
            } catch (error) {
                // ignore
            }
        }
    });

    setInterval(() => {
        if (!viewerOpen || !screenRequested) return;
        if (!screenSocket || screenSocket.readyState !== WebSocket.OPEN) return;

        if (performance.now() - screenLastFrame > SCREEN_STALE_MS) {
            setViewerState("offline", "No signal");
        }
    }, 1000);

    /* ---------- Movement ---------- */

    // Moves are accumulated and sent once per animation frame. That caps the
    // packet rate at ~60 Hz even on 120 Hz phones, and it gives the pointer a
    // stable acceleration curve. Fewer packets over a tunnel means less
    // queueing and a snappier cursor.
    //
    //   move:   [1][int16 dx][int16 dy]
    //   scroll: [2][int16 dy][int16 dx]
    const MOVE_MIN_GAIN = 1.15;
    const MOVE_MAX_GAIN = 2.9;
    const MOVE_ACCEL_SPEED = 14;       // CSS px per 16 ms
    const MAX_MOVE_STEP = 1200;
    const SCROLL_GAIN = 1.2;
    const SCROLL_LOCK_PX = 8;

    let moveAccX = 0;
    let moveAccY = 0;
    let scrollAccX = 0;
    let scrollAccY = 0;
    let inputScheduled = false;

    const moveFrame = new ArrayBuffer(5);
    const moveView = new DataView(moveFrame);
    moveView.setUint8(0, 1);

    const scrollFrame = new ArrayBuffer(5);
    const scrollView = new DataView(scrollFrame);
    scrollView.setUint8(0, 2);

    function clamp(value, limit) {
        return Math.max(-limit, Math.min(limit, value));
    }

    function flushMove() {
        const dx = clamp(Math.round(moveAccX), MAX_MOVE_STEP);
        const dy = clamp(Math.round(moveAccY), MAX_MOVE_STEP);

        if (dx === 0 && dy === 0) return;

        moveView.setInt16(1, dx, true);
        moveView.setInt16(3, dy, true);

        // Keep the unsent remainder while the socket is backed up. Dropping it
        // here is what makes a laggy link feel like the cursor is stuck.
        if (!sendFrame(moveFrame)) return;

        moveAccX -= dx;
        moveAccY -= dy;
    }

    function flushScroll() {
        const dy = clamp(Math.trunc(scrollAccY), MAX_MOVE_STEP);
        const dx = clamp(Math.trunc(scrollAccX), MAX_MOVE_STEP);

        if (dy === 0 && dx === 0) return;

        scrollView.setInt16(1, dy, true);
        scrollView.setInt16(3, dx, true);

        if (!sendFrame(scrollFrame)) return;

        scrollAccY -= dy;
        scrollAccX -= dx;
    }

    function scheduleFlush() {
        if (inputScheduled) return;
        inputScheduled = true;
        requestAnimationFrame(() => {
            inputScheduled = false;
            flushMove();
            flushScroll();
        });
    }

    function resetMovement() {
        moveAccX = 0;
        moveAccY = 0;
        scrollAccX = 0;
        scrollAccY = 0;
    }

    /* ---------- Touch state ---------- */

    const TAP_MAX_MS = 220;
    const TAP_MAX_MOVE = 16;
    const DOUBLE_TAP_MS = 300;
    const HOLD_DRAG_MS = 320;

    let lastX = 0;
    let lastY = 0;
    let lastTwoFingerX = 0;
    let lastTwoFingerY = 0;
    let lastTouchCount = 0;
    let lastTapTime = 0;
    let touchStartTime = 0;
    let gestureHadMulti = false;
    let multiTapEligible = false;
    let movedDistance = 0;
    let startX = 0;
    let startY = 0;
    let lastMoveSample = 0;
    let scrollAxis = null;
    let scrollTravel = 0;
    let dragTimer = 0;
    let dragging = false;
    let padRect = null;
    let padUsed = false;

    function setGlow(x, y) {
        if (!padRect) return;
        glowEl.style.transform =
            "translate3d(" +
            (x - padRect.left) +
            "px, " +
            (y - padRect.top) +
            "px, 0) translate(-50%, -50%)";
    }

    function clearDragTimer() {
        if (dragTimer) {
            clearTimeout(dragTimer);
            dragTimer = 0;
        }
    }

    function startDrag() {
        dragTimer = 0;
        if (dragging || gestureHadMulti || lastTouchCount !== 1) return;
        if (!send({ type: "mousedown", button: "left" }, true)) return;

        dragging = true;
        pad.classList.add("is-dragging");
        haptic(14);
    }

    function endDrag() {
        if (!dragging) return;

        send({ type: "mouseup", button: "left" }, true);
        dragging = false;
        pad.classList.remove("is-dragging");
    }

    function beginGesture(x, y) {
        gestureHadMulti = false;
        multiTapEligible = false;
        movedDistance = 0;
        startX = x;
        startY = y;
        lastX = x;
        lastY = y;
        touchStartTime = performance.now();
        lastMoveSample = touchStartTime;
        scrollAxis = null;
        scrollTravel = 0;
        resetMovement();
    }

    pad.addEventListener("touchstart", (event) => {
        event.preventDefault();

        // One layout read per gesture, not per movement event.
        padRect = pad.getBoundingClientRect();

        const count = event.touches.length;

        if (count === 1 && lastTouchCount === 0) {
            beginGesture(event.touches[0].clientX, event.touches[0].clientY);
            clearDragTimer();
            dragTimer = setTimeout(startDrag, HOLD_DRAG_MS);
        } else if (count >= 2) {
            // Second finger: cancel any pending press-drag and start scrolling.
            clearDragTimer();
            endDrag();

            const midX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
            const midY = (event.touches[0].clientY + event.touches[1].clientY) / 2;

            gestureHadMulti = true;
            multiTapEligible = true;
            movedDistance = 0;
            startX = midX;
            startY = midY;
            lastTwoFingerX = midX;
            lastTwoFingerY = midY;
            touchStartTime = performance.now();
            scrollAxis = null;
            scrollTravel = 0;
            resetMovement();
        }

        if (count === 1) {
            lastX = event.touches[0].clientX;
            lastY = event.touches[0].clientY;
            setGlow(lastX, lastY);
        } else {
            setGlow(event.touches[0].clientX, event.touches[0].clientY);
        }

        glowEl.style.opacity = "1";

        if (!padUsed) {
            padUsed = true;
            pad.classList.add("is-used");
        }

        lastTouchCount = count;
    }, { passive: false });

    pad.addEventListener("touchmove", (event) => {
        event.preventDefault();

        const now = performance.now();

        if (event.touches.length === 1) {
            const x = event.touches[0].clientX;
            const y = event.touches[0].clientY;
            const dx = x - lastX;
            const dy = y - lastY;

            if (gestureHadMulti) {
                // Lifted one finger after a scroll: let the remaining finger
                // keep moving the cursor, but never turn this into a click.
                if (Math.hypot(dx, dy) > 3) multiTapEligible = false;
            } else {
                const travel = Math.hypot(x - startX, y - startY);
                movedDistance = Math.max(movedDistance, travel);

                // Any real movement means this is a pointer gesture, not a hold.
                if (travel > 8) clearDragTimer();
            }

            const dt = Math.max(6, now - lastMoveSample);
            const speed = Math.hypot(dx, dy) * (16 / dt);
            const gain =
                MOVE_MIN_GAIN +
                (MOVE_MAX_GAIN - MOVE_MIN_GAIN) *
                    (1 - Math.exp(-speed / MOVE_ACCEL_SPEED));

            moveAccX = clamp(moveAccX + dx * gain, MAX_MOVE_STEP);
            moveAccY = clamp(moveAccY + dy * gain, MAX_MOVE_STEP);

            lastX = x;
            lastY = y;
            lastMoveSample = now;
            setGlow(x, y);
            scheduleFlush();
        } else if (event.touches.length >= 2) {
            const currentX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
            const currentY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
            const dx = currentX - lastTwoFingerX;
            const dy = currentY - lastTwoFingerY;

            lastTwoFingerX = currentX;
            lastTwoFingerY = currentY;

            scrollAccX += dx * SCROLL_GAIN;
            scrollAccY += dy * SCROLL_GAIN;
            scrollTravel += Math.hypot(dx, dy);
            movedDistance = Math.max(
                movedDistance,
                Math.hypot(currentX - startX, currentY - startY)
            );

            // Lock to one axis so a slightly diagonal swipe does not wobble
            // between vertical and horizontal scrolling.
            if (!scrollAxis && scrollTravel > SCROLL_LOCK_PX) {
                scrollAxis =
                    Math.abs(scrollAccY) >= Math.abs(scrollAccX) ? "y" : "x";
                multiTapEligible = false;

                if (scrollAxis === "y") scrollAccX = 0;
                else scrollAccY = 0;
            }

            if (scrollAxis) scheduleFlush();
            setGlow(event.touches[0].clientX, event.touches[0].clientY);
        }
    }, { passive: false });

    function endTouch(allowTap) {
        glowEl.style.opacity = "0";

        if (!allowTap) return;

        const duration = performance.now() - touchStartTime;
        const isTap = duration < TAP_MAX_MS && movedDistance < TAP_MAX_MOVE;

        if (!isTap) return;

        if (gestureHadMulti) {
            if (multiTapEligible) {
                send({ type: "click", button: "right", clicks: 1 }, true);
                lastTapTime = 0;
                haptic(12);
            }
            return;
        }

        if (lastTouchCount === 1) {
            const now = performance.now();
            const isDouble = now - lastTapTime < DOUBLE_TAP_MS;

            // The first tap already clicked; this second one completes the
            // double-click without adding a third click.
            send({ type: "click", button: "left", clicks: 1 }, true);
            lastTapTime = isDouble ? 0 : now;
            haptic(8);
        }
    }

    pad.addEventListener("touchend", (event) => {
        event.preventDefault();

        clearDragTimer();
        flushMove();
        flushScroll();

        if (event.touches.length === 1) {
            // One finger lifted from a scroll. Continue with the other finger,
            // but treat the gesture as multi-touch for tap purposes.
            gestureHadMulti = true;
            scrollAxis = null;
            resetMovement();
            lastX = event.touches[0].clientX;
            lastY = event.touches[0].clientY;
            lastMoveSample = performance.now();
            lastTouchCount = 1;
            return;
        }

        if (event.touches.length > 0) return;

        if (dragging) {
            endDrag();
            lastTapTime = 0;
            glowEl.style.opacity = "0";
            lastTouchCount = 0;
            return;
        }

        endTouch(true);
        lastTouchCount = 0;
    }, { passive: false });

    pad.addEventListener("touchcancel", (event) => {
        event.preventDefault();

        clearDragTimer();
        endDrag();
        glowEl.style.opacity = "0";
        resetMovement();
        lastTouchCount = 0;
    }, { passive: false });

    pad.addEventListener("contextmenu", (event) => {
        event.preventDefault();
    });
})();
