"use strict";

/* =====================================================================
   CONFIGURATION
   Each puzzle: display name, image and cut layout (columns x rows).
   Classic cut with rounded tabs and blanks; pieces are never rotated.
   ===================================================================== */
const PUZZLES = [
    { id: "buburuza", name: "Buburuza", image: "img/buburuza.webp", cols: 3, rows: 2 },
    { id: "pisica",   name: "Pisica",   image: "img/pisica.webp",   cols: 3, rows: 3 },
    { id: "frunze",   name: "Frunze",   image: "img/frunze.webp",   cols: 3, rows: 4 },
    { id: "buburuze", name: "Buburuze", image: "img/buburuze.webp", cols: 4, rows: 4 },
];

// How close (as a fraction of a piece) a piece must be dropped to snap.
// Deliberately generous, for small hands that are just learning the mouse.
const SNAP_TOLERANCE = 0.32;

// Progress is kept ONLY in memory: every time the game is opened (page load)
// all check marks are cleared, so the next class starts from scratch.
const solved = new Set();

/* =====================================================================
   DOM ELEMENTS
   ===================================================================== */
const $ = id => document.getElementById(id);

const homeScreen = $("home-screen");
const gameScreen = $("game-screen");
const puzzleList = $("puzzle-list");
const progressStars = $("progress-stars");
const table = $("table");
const canvas = $("puzzle-canvas");
const ctx = canvas.getContext("2d");
const hitCtx = document.createElement("canvas").getContext("2d");
const gameName = $("game-name");
const previewOverlay = $("preview-overlay");
const previewBig = $("preview-big");
const successOverlay = $("success-overlay");
const successNext = $("success-next");
const confettiBox = $("confetti");

/* =====================================================================
   SOUNDS (synthesized in the browser, no external files)
   ===================================================================== */
let audio = null;

function ensureAudio() {
    if (!audio) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        audio = new AudioCtx();
    }
    if (audio.state === "suspended") audio.resume();
    return audio;
}

function tone(freq, start, duration, type = "sine", volume = 0.2) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain).connect(audio.destination);
    osc.start(start);
    osc.stop(start + duration + 0.05);
}

// Success jingle played when the puzzle is finished.
function playSuccess() {
    if (!ensureAudio()) return;
    const t = audio.currentTime + 0.05;
    const melody = [523.25, 659.25, 783.99, 1046.5];      // C E G C
    melody.forEach((f, i) => tone(f, t + i * 0.12, 0.35, "triangle", 0.28));
    [523.25, 659.25, 783.99].forEach(f => tone(f, t + 0.55, 1.1, "triangle", 0.18));
    tone(1046.5, t + 0.55, 1.1, "sine", 0.15);
    [1568, 2093, 2637, 3136].forEach((f, i) => tone(f, t + 0.7 + i * 0.08, 0.25, "sine", 0.06));
}

/* =====================================================================
   HOME SCREEN
   ===================================================================== */
function renderHome() {
    puzzleList.innerHTML = "";

    PUZZLES.forEach((puzzle, index) => {
        const total = puzzle.cols * puzzle.rows;
        const card = document.createElement("button");
        card.type = "button";
        card.className = "puzzle-card" + (solved.has(puzzle.id) ? " solved" : "");
        card.setAttribute("aria-label", `${puzzle.name}, ${total} piese` +
            (solved.has(puzzle.id) ? ", rezolvat" : ""));

        const dots = Array.from({ length: total }, () => '<span class="piece-dot"></span>').join("");

        card.innerHTML = `
            <div class="card-image"><img src="${puzzle.image}" alt="" draggable="false"></div>
            <div class="card-name">${puzzle.name}</div>
            <div class="card-pieces">${dots}<span class="piece-label">${total} piese</span></div>
            <div class="card-check" aria-hidden="true">✔</div>`;

        card.addEventListener("click", () => startGame(index));
        puzzleList.appendChild(card);
    });

    progressStars.innerHTML = PUZZLES
        .map(p => `<span class="${solved.has(p.id) ? "lit" : ""}">⭐</span>`)
        .join("");
    progressStars.setAttribute("aria-label",
        `Ai rezolvat ${solved.size} din ${PUZZLES.length} puzzle-uri`);
}

function showHome() {
    game = null;
    successOverlay.hidden = true;
    gameScreen.hidden = true;
    homeScreen.hidden = false;
    renderHome();
}

/* =====================================================================
   PIECE SHAPES
   Every inner edge gets a tab (pointing out or in). Border edges are
   straight. Both neighbouring pieces share the same edge geometry, so
   they always fit perfectly.
   ===================================================================== */
const rand = (a, b) => a + Math.random() * (b - a);

function randomEdge() {
    return {
        sign: Math.random() < 0.5 ? -1 : 1,
        center: rand(-0.04, 0.04),
        width: rand(0.94, 1.08),
        height: rand(0.95, 1.1),
    };
}

function makeEdges(cols, rows) {
    const h = [];
    for (let r = 0; r <= rows; r++) {
        h.push([]);
        for (let c = 0; c < cols; c++) {
            h[r].push(r === 0 || r === rows ? null : randomEdge());
        }
    }
    const v = [];
    for (let r = 0; r < rows; r++) {
        v.push([]);
        for (let c = 0; c <= cols; c++) {
            v[r].push(c === 0 || c === cols ? null : randomEdge());
        }
    }
    return { h, v };
}

// Builds the geometry of one edge (in pixels) between two corners.
function buildEdge(x0, y0, x1, y1, params, knob) {
    if (!params) {
        return { start: [x0, y0], segs: [[x0, y0, x1, y1, x1, y1]] };
    }
    const len = Math.hypot(x1 - x0, y1 - y0);
    const dx = (x1 - x0) / len;
    const dy = (y1 - y0) / len;
    const nx = -dy;
    const ny = dx;
    const { sign, center, width, height } = params;

    // (u, v): u runs along the edge (0..1), v is perpendicular (tab height)
    const raw = (u, w) => [
        x0 + dx * u * len + nx * w * knob * sign,
        y0 + dy * u * len + ny * w * knob * sign,
    ];
    const tab = (u, w) => raw(0.5 + center + (u - 0.5) * width, w * height);

    const curves = [
        [raw(0.2, 0), tab(0.35, 0), tab(0.40, 0)],
        [tab(0.44, 0), tab(0.45, 0.05), tab(0.41, 0.10)],
        [tab(0.35, 0.18), tab(0.41, 0.28), tab(0.50, 0.28)],
        [tab(0.59, 0.28), tab(0.65, 0.18), tab(0.59, 0.10)],
        [tab(0.55, 0.05), tab(0.56, 0), tab(0.60, 0)],
        [tab(0.65, 0), raw(0.8, 0), raw(1, 0)],
    ];
    return { start: [x0, y0], segs: curves.map(([a, b, e]) => [...a, ...b, ...e]) };
}

function reverseEdge(edge) {
    const segs = edge.segs;
    const out = [];
    for (let i = segs.length - 1; i >= 0; i--) {
        const [c1x, c1y, c2x, c2y] = segs[i];
        const prev = i === 0 ? edge.start : segs[i - 1].slice(4, 6);
        out.push([c2x, c2y, c1x, c1y, prev[0], prev[1]]);
    }
    const last = segs[segs.length - 1];
    return { start: [last[4], last[5]], segs: out };
}

function piecePath(piece) {
    const { cw, ch, knob } = layout;
    const { h, v } = game.edges;
    const { r, c } = piece;
    const X = i => i * cw;
    const Y = i => i * ch;

    const top = buildEdge(X(c), Y(r), X(c + 1), Y(r), h[r][c], knob);
    const right = buildEdge(X(c + 1), Y(r), X(c + 1), Y(r + 1), v[r][c + 1], knob);
    const bottom = reverseEdge(buildEdge(X(c), Y(r + 1), X(c + 1), Y(r + 1), h[r + 1][c], knob));
    const left = reverseEdge(buildEdge(X(c), Y(r), X(c), Y(r + 1), v[r][c], knob));

    // Local coordinates: the piece's top-left corner is (0, 0).
    const ox = X(c);
    const oy = Y(r);
    const path = new Path2D();
    path.moveTo(top.start[0] - ox, top.start[1] - oy);
    [top, right, bottom, left].forEach(edge => {
        edge.segs.forEach(s => {
            path.bezierCurveTo(s[0] - ox, s[1] - oy, s[2] - ox, s[3] - oy, s[4] - ox, s[5] - oy);
        });
    });
    path.closePath();
    return path;
}

// Pre-renders each piece once into its own bitmap (faster drawing).
function renderPieceBitmap(piece) {
    const { cw, ch, pad, fw, fh, dpr } = layout;
    const bmp = document.createElement("canvas");
    bmp.width = Math.ceil((cw + pad * 2) * dpr);
    bmp.height = Math.ceil((ch + pad * 2) * dpr);
    const b = bmp.getContext("2d");
    b.scale(dpr, dpr);
    b.translate(pad, pad);

    b.save();
    b.clip(piece.path);
    b.drawImage(game.img, -piece.c * cw, -piece.r * ch, fw, fh);

    // Bevelled edges: shadow bottom-right, highlight top-left.
    b.lineWidth = 3;
    b.strokeStyle = "rgba(0, 0, 0, 0.35)";
    b.translate(-1.2, -1.2);
    b.stroke(piece.path);
    b.strokeStyle = "rgba(255, 255, 255, 0.55)";
    b.translate(2.4, 2.4);
    b.stroke(piece.path);
    b.restore();

    b.lineWidth = 1;
    b.strokeStyle = "rgba(0, 0, 0, 0.25)";
    b.stroke(piece.path);

    piece.bmp = bmp;
}

/* =====================================================================
   GAME STATE
   Piece positions are stored in "piece units" relative to an invisible
   reference point, so everything scales nicely when the window resizes.
   There is no target frame: the puzzle can be assembled anywhere.
   ===================================================================== */
let game = null;
let layout = null;
let drag = null;
let hovered = null;
let animating = false;

function startGame(index) {
    const puzzle = PUZZLES[index];
    ensureAudio();

    homeScreen.hidden = true;
    gameScreen.hidden = false;
    successOverlay.hidden = true;

    gameName.textContent = puzzle.name;
    previewBig.src = puzzle.image;

    const img = new Image();
    const current = { index, puzzle, img, ready: false };
    game = current;
    img.onload = () => {
        if (game !== current) return;
        setupPuzzle(current);
    };
    img.src = puzzle.image;
    render();
}

function setupPuzzle(g) {
    const { cols, rows } = g.puzzle;
    g.cols = cols;
    g.rows = rows;
    g.aspect = g.img.naturalWidth / g.img.naturalHeight;
    g.edges = makeEdges(cols, rows);
    g.pieces = [];
    g.complete = false;

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const piece = { r, c, ux: 0, uy: 0, flash: 0 };
            piece.group = [piece];
            g.pieces.push(piece);
        }
    }
    g.order = g.pieces.slice();
    g.ready = true;

    computeLayout(true);
    scatterPieces();
    render();
}

function pieceAt(c, r) {
    if (c < 0 || r < 0 || c >= game.cols || r >= game.rows) return null;
    return game.pieces[r * game.cols + c];
}

/* ---------- Piece layout on the table ---------- */
function computeLayout(fresh) {
    const rect = table.getBoundingClientRect();
    const W = Math.max(200, rect.width);
    const H = Math.max(200, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);

    if (!game || !game.ready) {
        layout = { W, H, dpr };
        return;
    }

    const margin = 14;
    const n = game.pieces.length;
    let best = null;

    if (!fresh && layout && layout.f !== undefined) {
        // On resize, keep the same piece proportion.
        best = layoutFor(W, H, layout.f, margin, dpr);
    } else {
        // Find the largest piece size that still lets every piece start in its
        // own spot, while the finished picture still fits on the table.
        for (let f = 0.75; f >= 0.3; f -= 0.02) {
            const L = layoutFor(W, H, f, margin, dpr);
            L.slots = freeSlots(L, margin);
            if (!best || L.slots.length > best.slots.length) best = L;
            if (L.slots.length >= n) { best = L; break; }
        }
    }
    layout = best;

    game.pieces.forEach(p => {
        p.path = piecePath(p);
        renderPieceBitmap(p);
    });

    if (!fresh) game.pieces.forEach(p => clampGroup(p.group));
}

function layoutFor(W, H, f, margin, dpr) {
    let fw = (W - margin * 2) * f;
    let fh = fw / game.aspect;
    if (fh > (H - margin * 2) * f) {
        fh = (H - margin * 2) * f;
        fw = fh * game.aspect;
    }
    const cw = fw / game.cols;
    const ch = fh / game.rows;
    const knob = Math.min(cw, ch);
    return {
        W, H, dpr, f, fw, fh, cw, ch, knob,
        pad: knob * 0.32,
        fx: (W - fw) / 2,
        fy: (H - fh) / 2,
    };
}

function freeSlots(L, margin) {
    const sw = L.cw * 1.3;
    const sh = L.ch * 1.3;
    const nx = Math.floor((L.W - margin * 2) / sw);
    const ny = Math.floor((L.H - margin * 2) / sh);
    const offX = (L.W - nx * sw) / 2;
    const offY = (L.H - ny * sh) / 2;
    const slots = [];
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            slots.push({ x: offX + (i + 0.5) * sw, y: offY + (j + 0.5) * sh, sw, sh });
        }
    }
    return slots;
}

function shuffle(items) {
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}

function scatterPieces() {
    const { cw, ch, fx, fy, W, H } = layout;
    const slots = shuffle(layout.slots.slice());
    const pieces = shuffle(game.pieces.slice());

    pieces.forEach((p, i) => {
        let cx, cy;
        if (slots.length) {
            const s = slots[i % slots.length];
            cx = s.x + rand(-0.08, 0.08) * s.sw;
            cy = s.y + rand(-0.08, 0.08) * s.sh;
        } else {
            cx = rand(cw, W - cw);
            cy = rand(ch, H - ch);
        }
        p.ux = (cx - cw / 2 - fx) / cw;
        p.uy = (cy - ch / 2 - fy) / ch;
    });
    game.order = pieces;
}

/* ---------- Position helpers ---------- */
const px = p => layout.fx + p.ux * layout.cw;
const py = p => layout.fy + p.uy * layout.ch;

function moveGroup(group, du, dv) {
    group.forEach(p => { p.ux += du; p.uy += dv; });
}

function clampGroup(group) {
    const { cw, ch, W, H } = layout;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    group.forEach(p => {
        minX = Math.min(minX, px(p));
        minY = Math.min(minY, py(p));
        maxX = Math.max(maxX, px(p) + cw);
        maxY = Math.max(maxY, py(p) + ch);
    });
    let dx = 0, dy = 0;
    const m = 6;
    if (maxX > W - m) dx = W - m - maxX;
    if (minX + dx < m) dx = m - minX;
    if (maxY > H - m) dy = H - m - maxY;
    if (minY + dy < m) dy = m - minY;
    moveGroup(group, dx / cw, dy / ch);
}

function bringToFront(group) {
    game.order = game.order.filter(p => p.group !== group).concat(group);
}

function mergeInto(target, other) {
    other.forEach(p => { p.group = target; target.push(p); });
}

function flashGroup(group) {
    const now = performance.now();
    group.forEach(p => { p.flash = now; });
    startAnimation();
}

/* =====================================================================
   JOINING PIECES
   A dropped group snaps to any nearby correct neighbour, anywhere on the
   table; joined pieces form a group that moves together. The puzzle is
   finished when all pieces belong to a single group.
   ===================================================================== */
function dropGroup(group) {
    let snapped = false;
    let changed = true;

    while (changed) {
        changed = false;
        for (const p of group) {
            for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const q = pieceAt(p.c + dc, p.r + dr);
                if (!q || q.group === group) continue;
                const du = (q.ux - dc) - p.ux;
                const dv = (q.uy - dr) - p.uy;
                if (Math.abs(du) < SNAP_TOLERANCE && Math.abs(dv) < SNAP_TOLERANCE) {
                    moveGroup(group, du, dv);
                    mergeInto(group, q.group);
                    bringToFront(group);
                    snapped = changed = true;
                    break;
                }
            }
            if (changed) break;
        }
    }

    clampGroup(group);
    if (snapped) flashGroup(group);
    if (group.length === game.pieces.length) finishGame();
}

function finishGame() {
    if (game.complete) return;
    game.complete = true;
    game.revealStart = performance.now();
    solved.add(game.puzzle.id);
    hovered = null;
    canvas.classList.remove("can-grab", "grabbing");
    startAnimation();
    playSuccess();
    launchConfetti();

    const finished = game;
    setTimeout(() => {
        if (game !== finished) return;
        const next = nextUnsolved(finished.index);
        successNext.hidden = next === -1;
        successOverlay.hidden = false;
    }, 1300);
}

function nextUnsolved(fromIndex) {
    for (let k = 1; k <= PUZZLES.length; k++) {
        const i = (fromIndex + k) % PUZZLES.length;
        if (!solved.has(PUZZLES[i].id)) return i;
    }
    return -1;
}

/* =====================================================================
   RENDERING
   ===================================================================== */
function render(now = performance.now()) {
    const L = layout;
    if (!L) return;
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    ctx.clearRect(0, 0, L.W, L.H);

    if (!game || !game.ready) {
        ctx.fillStyle = "#8a84a8";
        ctx.font = "600 28px 'Baloo 2', sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Se încarcă…", L.W / 2, L.H / 2);
        return;
    }

    const { fw, fh, cw, ch, pad } = L;

    // Pieces in stacking order. Each group is drawn in two passes (with shadow,
    // then without) so shadows never fall between joined pieces.
    const order = game.order;
    let i = 0;
    while (i < order.length) {
        const group = order[i].group;
        let j = i;
        while (j < order.length && order[j].group === group) j++;
        const run = order.slice(i, j);
        const isDragged = drag && drag.group === group;
        const isHovered = !drag && hovered && hovered.group === group && !game.complete;
        const lift = isDragged ? 4 : 0;

        const drawRun = () => run.forEach(p => {
            ctx.drawImage(p.bmp, px(p) - pad, py(p) - pad - lift, cw + pad * 2, ch + pad * 2);
        });

        ctx.save();
        if (isHovered) {
            ctx.shadowColor = "rgba(255, 200, 40, 1)";
            ctx.shadowBlur = 22;
        } else {
            ctx.shadowColor = "rgba(30, 40, 60, 0.35)";
            ctx.shadowBlur = isDragged ? 22 : 8;
            ctx.shadowOffsetY = isDragged ? 12 : 4;
        }
        drawRun();
        ctx.restore();
        drawRun();
        i = j;
    }

    // Short glow when pieces join.
    let active = false;
    order.forEach(p => {
        if (!p.flash) return;
        const t = (now - p.flash) / 380;
        if (t >= 1) { p.flash = 0; return; }
        active = true;
        ctx.save();
        ctx.translate(px(p), py(p));
        ctx.fillStyle = `rgba(255, 255, 255, ${0.6 * (1 - t)})`;
        ctx.fill(p.path);
        ctx.restore();
    });

    // When finished, the whole seamless image fades in over the pieces.
    if (game.complete) {
        const t = Math.min(1, (now - game.revealStart) / 700);
        const first = game.pieces[0];
        const fx = px(first);
        const fy = py(first);
        ctx.save();
        ctx.globalAlpha = t;
        ctx.drawImage(game.img, fx, fy, fw, fh);
        ctx.globalAlpha = 1;
        ctx.lineWidth = 6;
        ctx.strokeStyle = `rgba(255, 210, 63, ${t})`;
        ctx.strokeRect(fx - 3, fy - 3, fw + 6, fh + 6);
        ctx.restore();
        if (t < 1) active = true;
    }

    return active;
}

function startAnimation() {
    if (animating) return;
    animating = true;
    const step = now => {
        const more = render(now);
        if (more) {
            requestAnimationFrame(step);
        } else {
            animating = false;
        }
    };
    requestAnimationFrame(step);
}

/* =====================================================================
   MOUSE / TOUCH INPUT
   ===================================================================== */
function pointerPos(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function pieceUnder(x, y) {
    if (!game || !game.ready || game.complete) return null;
    const { cw, ch } = layout;
    for (let k = game.order.length - 1; k >= 0; k--) {
        const p = game.order[k];
        const lx = x - px(p);
        const ly = y - py(p);
        const inCore = lx >= 0 && ly >= 0 && lx <= cw && ly <= ch;
        if (inCore || hitCtx.isPointInPath(p.path, lx, ly)) return p;
    }
    return null;
}

canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    const { x, y } = pointerPos(event);
    const piece = pieceUnder(x, y);
    if (!piece) return;

    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    drag = { group: piece.group, x, y, id: event.pointerId };
    bringToFront(piece.group);
    canvas.classList.add("grabbing");
    render();
});

canvas.addEventListener("pointermove", event => {
    const { x, y } = pointerPos(event);

    if (drag && event.pointerId === drag.id) {
        moveGroup(drag.group, (x - drag.x) / layout.cw, (y - drag.y) / layout.ch);
        drag.x = x;
        drag.y = y;
        render();
        return;
    }

    const piece = pieceUnder(x, y);
    if (piece !== hovered) {
        hovered = piece;
        canvas.classList.toggle("can-grab", !!piece);
        render();
    }
});

function endDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const group = drag.group;
    drag = null;
    canvas.classList.remove("grabbing");
    dropGroup(group);
    render();
}

canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("pointerleave", () => {
    if (!drag && hovered) {
        hovered = null;
        canvas.classList.remove("can-grab");
        render();
    }
});
canvas.addEventListener("contextmenu", event => event.preventDefault());
document.addEventListener("dragstart", event => event.preventDefault());

/* =====================================================================
   BUTTONS
   ===================================================================== */
$("home-button").addEventListener("click", showHome);
$("success-home").addEventListener("click", showHome);

successNext.addEventListener("click", () => {
    const next = game ? nextUnsolved(game.index) : -1;
    if (next === -1) showHome();
    else startGame(next);
});

$("preview-button").addEventListener("click", () => { previewOverlay.hidden = false; });
previewOverlay.addEventListener("click", () => { previewOverlay.hidden = true; });

$("reset-button").addEventListener("click", () => {
    solved.clear();
    renderHome();
});

$("fullscreen-button").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
});

document.addEventListener("keydown", event => {
    if (event.key === "Escape") previewOverlay.hidden = true;
});

/* =====================================================================
   CONFETTI
   ===================================================================== */
function launchConfetti() {
    const colors = ["#ff5a5f", "#ffd23f", "#3ccf7a", "#4cb8f5", "#9b7bf0", "#ff9eb5"];
    for (let k = 0; k < 90; k++) {
        const bit = document.createElement("i");
        bit.style.left = `${Math.random() * 100}vw`;
        bit.style.background = colors[k % colors.length];
        bit.style.animationDuration = `${rand(2.2, 4)}s`;
        bit.style.animationDelay = `${rand(0, 0.6)}s`;
        bit.style.setProperty("--drift", `${rand(-120, 120)}px`);
        bit.style.setProperty("--spin", `${rand(-720, 720)}deg`);
        confettiBox.appendChild(bit);
        setTimeout(() => bit.remove(), 5000);
    }
}

/* =====================================================================
   STARTUP
   ===================================================================== */
new ResizeObserver(() => {
    if (gameScreen.hidden) return;
    computeLayout(false);
    render();
}).observe(table);

renderHome();
