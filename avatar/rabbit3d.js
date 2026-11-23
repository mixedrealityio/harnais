// rabbit3d.js — le lapin en peluche en vraie 3D (Three.js) : modèle construit en code, fourrure « peluche » (matériau à lustre velouté + grain),
// oreilles articulées, paupières, bouche qui s'ouvre avec la voix, balancement, danse avec tour sur lui-même en vrai 3D.
// Les caresses se détectent par lancer de rayon (oreilles : cœurs, front : étoiles, joues et ventre : gros cœurs).
// Même interface que rabbit.js : setState, setMouth, setListenLevel, nod, onPet, setDance, stop.
import * as THREE from './../vendor/three/three.module.js';
import { RoomEnvironment } from './../vendor/three/RoomEnvironment.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = (a, b) => a + Math.random() * (b - a);

// --- Textures fabriquées en code : grain de peluche et dentelle ---
function noiseTexture(size, grain, seedScale) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d');
    const small = document.createElement('canvas'); small.width = small.height = Math.round(size / grain);
    const sg = small.getContext('2d'), id = sg.createImageData(small.width, small.height);
    for (let i = 0; i < id.data.length; i += 4) { const v = 128 + (Math.random() - 0.5) * 255 * seedScale; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
    sg.putImageData(id, 0, 0);
    g.imageSmoothingEnabled = true; g.drawImage(small, 0, 0, size, size);
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}
function laceTexture() {
    // Carte de transparence (le vert fait foi) : motif blanc sur fond noir, sans frange sombre
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 512, 128);
    g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 5;
    for (let x = 0; x < 512; x += 32) {
        g.beginPath(); g.arc(x + 16, 64, 15, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.arc(x + 16, 64, 5, 0, Math.PI * 2); g.fill();
        for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; g.beginPath(); g.arc(x + 16 + Math.cos(a) * 15, 64 + Math.sin(a) * 15, 6, 0, Math.PI * 2); g.stroke(); }
    }
    g.lineWidth = 9; g.beginPath(); g.moveTo(0, 8); g.lineTo(512, 8); g.stroke();
    g.beginPath(); for (let x = 0; x <= 512; x += 16) { g.moveTo(x, 118); g.arc(x + 8, 118, 8, Math.PI, 0, true); } g.stroke();
    const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.repeat.set(2, 1); return t;
}

// Peluche : couleur douce, lustre velouté (sheen) et grain en relief
function plush(color, sheenColor, bump) {
    return new THREE.MeshPhysicalMaterial({ color, roughness: 0.92, metalness: 0, sheen: 1, sheenColor: new THREE.Color(sheenColor), sheenRoughness: 0.55, bumpMap: bump, bumpScale: 1.4 });
}

function Rabbit3D(overlay) {
    // --- Rendu : canvas WebGL transparent placé juste derrière le canevas 2D (cœurs, étoiles, caresses) ---
    const gl = document.createElement('canvas');
    gl.className = 'face3d';
    overlay.parentNode.insertBefore(gl, overlay);
    const renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.55;
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
    const key = new THREE.DirectionalLight(0xfff0dc, 2.2); key.position.set(-3, 6, 6); scene.add(key);
    const rim = new THREE.DirectionalLight(0xffb070, 1.3); rim.position.set(4, 3, -5); scene.add(rim);
    scene.add(new THREE.HemisphereLight(0xdbe6ff, 0x3a2a20, 0.55));

    // --- Matériaux ---
    const bumpFur = noiseTexture(256, 2, 0.9); bumpFur.repeat.set(5, 5);
    const bumpKnit = noiseTexture(256, 2, 0.8); bumpKnit.repeat.set(6, 6);
    const M = {
        fur: plush(0xd0c2a8, 0xfff1de, bumpFur),
        cream: plush(0xe6d29e, 0xfff4d6, bumpFur),
        blue: plush(0x78b0d4, 0xd6f0ff, bumpKnit),
        pink: plush(0xe9a39a, 0xffd9d2, bumpFur),
        black: new THREE.MeshPhysicalMaterial({ color: 0x050506, roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05 }),
        nose: new THREE.MeshStandardMaterial({ color: 0xe8a0a0, roughness: 0.6 }),
        mouth: new THREE.MeshBasicMaterial({ color: 0x3a1418, transparent: true, opacity: 0.92 }),
        lace: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide, alphaTest: 0.5, alphaMap: laceTexture() })
    };

    // --- Modèle : proportions relevées sur la photo (hauteur totale ≈ 5,4) ---
    const root = new THREE.Group(); scene.add(root);                      // pivot aux pieds
    const pickables = [];
    function mesh(geo, mat, parent, zone) { const m = new THREE.Mesh(geo, mat); (parent || root).add(m); if (zone) { m.userData.zone = zone; pickables.push(m); } return m; }

    // Corps : salopette bleue (surface de révolution), pieds crème, collerette de dentelle
    const bodyProfile = [[0.0, 0.12], [0.55, 0.12], [0.82, 0.4], [0.92, 0.85], [0.9, 1.35], [0.8, 1.8], [0.62, 2.12], [0.48, 2.32], [0.0, 2.4]].map(([r, y]) => new THREE.Vector2(r, y));
    const body = mesh(new THREE.LatheGeometry(bodyProfile, 56), M.blue, root, 'ventre'); body.scale.z = 0.82;
    const bib = mesh(new THREE.SphereGeometry(0.6, 32, 24), M.blue, root); bib.scale.set(1.0, 0.8, 0.35); bib.position.set(0, 1.55, 0.62);
    [-1, 1].forEach((s) => { const f = mesh(new THREE.SphereGeometry(1, 28, 20), M.cream, root); f.scale.set(0.45, 0.24, 0.6); f.position.set(s * 0.4, 0.26, 0.28); f.rotation.y = s * 0.12; });
    const collar = mesh(new THREE.LatheGeometry([[0.5, 2.44], [0.85, 2.36], [1.12, 2.14], [1.2, 2.0]].map(([r, y]) => new THREE.Vector2(r, y)), 64), M.lace, root);
    collar.scale.z = 0.85;
    const neckRing = mesh(new THREE.TorusGeometry(0.62, 0.07, 12, 48), M.blue, root); neckRing.rotation.x = Math.PI / 2; neckRing.position.y = 2.38; neckRing.scale.y = 0.9;

    // Bras : de petites capsules crème articulées aux épaules
    const arms = [-1, 1].map((s) => {
        const g = new THREE.Group(); g.position.set(s * 0.95, 2.0, 0.05); root.add(g);
        const a = mesh(new THREE.CapsuleGeometry(0.25, 0.4, 8, 16), M.cream, g); a.position.set(s * 0.08, -0.36, 0.2); a.rotation.set(0.35, 0, s * 0.14);
        g.userData.base = { z: s * 0.1, x: 0 }; return g;
    });

    // Tête : œuf légèrement pointu en haut, groupe pivotant au cou
    const head = new THREE.Group(); head.position.set(0, 2.3, 0); root.add(head);
    const HC = { y: 3.3 - 2.3, rx: 1.06, ry: 1.13, rz: 0.98 };            // centre et rayons de la tête, relatifs au cou
    const hg = new THREE.SphereGeometry(1, 64, 48);
    { const p = hg.attributes.position; for (let i = 0; i < p.count; i++) { const y = p.getY(i); p.setX(i, p.getX(i) * (1 - 0.1 * Math.max(0, y))); p.setZ(i, p.getZ(i) * (1 - 0.06 * Math.max(0, y))); } hg.computeVertexNormals(); }
    const headMesh = mesh(hg, M.fur, head, 'tete'); headMesh.scale.set(HC.rx, HC.ry, HC.rz); headMesh.position.y = HC.y;
    const surfZ = (x, y) => HC.rz * Math.sqrt(Math.max(0.05, 1 - (x / HC.rx) ** 2 - ((y - HC.y) / HC.ry) ** 2));   // profondeur de la surface en (x, y)
    // Yeux (billes noires brillantes) et paupières de la couleur du pelage
    const eyes = [-1, 1].map((s) => { const e = mesh(new THREE.SphereGeometry(0.125, 32, 24), M.black, head); e.position.set(s * 0.47, HC.y, surfZ(0.47, HC.y) - 0.02); e.scale.z = 0.9; return e; });
    const lids = eyes.map((e) => { const l = mesh(new THREE.SphereGeometry(0.15, 24, 18), M.fur, head); l.position.copy(e.position); l.position.z += 0.015; l.visible = false; return l; });
    const nose = mesh(new THREE.SphereGeometry(0.085, 20, 16), M.nose, head); nose.scale.set(1.15, 0.8, 0.8); nose.position.set(0, HC.y - 0.26, surfZ(0, HC.y - 0.26) + 0.0);
    // Bouche : seulement visible quand il parle
    const mouth = mesh(new THREE.SphereGeometry(1, 24, 16), M.mouth, head); mouth.position.set(0, HC.y - 0.53, surfZ(0, HC.y - 0.53) - 0.02); mouth.scale.set(0.1, 0.02, 0.03); mouth.visible = false;
    // Oreilles : longues, articulées à leur base, creux rose à l'intérieur
    const ears = [-1, 1].map((s) => {
        const g = new THREE.Group(); g.position.set(s * 0.52, HC.y + 0.86, -0.02); head.add(g);
        const o = mesh(new THREE.SphereGeometry(1, 40, 32), M.fur, g, 'oreille'); o.scale.set(0.42, 0.98, 0.26); o.position.y = 0.9;
        const inner = mesh(new THREE.SphereGeometry(1, 32, 24), M.pink, g); inner.scale.set(0.24, 0.72, 0.08); inner.position.set(0, 0.9, 0.2);
        g.userData = { base: -s * 0.3, side: s }; return g;
    });
    head.userData.ears = ears;

    // Cadrage : hauteur du modèle mesurée
    const box = new THREE.Box3().setFromObject(root); const MODEL_H = box.max.y - box.min.y, MODEL_CY = (box.max.y + box.min.y) / 2;

    // --- État d'animation (même logique que la version photo) ---
    const s = {
        state: 'idle', mouthOpen: 0, mouthWide: 0.5, mOpen: 0, pulse: 0, blink: 0, blinkT: rnd(0.8, 2.2), blinkPhase: -1, squint: 0,
        tilt: 0, nod: 0, nodV: 0, bounce: 0, listenLevel: 0, t: 0, swayPhase: rnd(0, 6), swayEnergy: 0, bodyRot: 0, bodyRotPrev: 0,
        ear: { L: { a: 0, v: 0 }, R: { a: 0, v: 0 } }, earTwitchT: rnd(3, 7), pet: 0, hearts: [], heartT: 0, stars: [], starT: 0, big: [], bigT: 0,
        dance: false, danceE: 0, bpm: 112, clock: null, lastBeat: -1, beat: 0, yaw: 0
    };
    let dpr = 1, last = performance.now(), running = true, petCb = null, W = 1, H = 1;
    const ctx = overlay.getContext('2d');
    const rc = new THREE.Raycaster(), ndc = new THREE.Vector2();

    function resize() {
        const r = overlay.getBoundingClientRect();
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        W = Math.max(1, Math.round(r.width * dpr)); H = Math.max(1, Math.round(r.height * dpr));
        overlay.width = W; overlay.height = H;
        renderer.setPixelRatio(dpr); renderer.setSize(r.width, r.height, false);
        gl.style.width = r.width + 'px'; gl.style.height = r.height + 'px';
        camera.aspect = r.width / r.height; frame3d();
    }
    // Place la caméra pour que le lapin entier tienne entre les énigmes (haut) et les boutons (bas)
    function frame3d() {
        const topCss = parseFloat(overlay.dataset.top) || 0, botCss = parseFloat(overlay.dataset.bottom) || 210, hCss = H / dpr;
        const region = Math.max(120, hCss - topCss - botCss), frac = region / hCss;
        const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        let d = (MODEL_H * 1.1) / (frac * 2 * tanH);
        const needW = 3.0 * 1.15, dW = needW / (2 * tanH * camera.aspect); d = Math.max(d, dW);   // et jamais plus large que l'écran
        const visH = 2 * d * tanH, shift = ((topCss + region / 2) - hCss / 2) / hCss * visH;       // recentre dans la zone libre
        camera.position.set(0, MODEL_CY + shift, d); camera.lookAt(0, MODEL_CY + shift, 0); camera.updateProjectionMatrix();
    }
    window.addEventListener('resize', resize);
    let ro = null; if (window.ResizeObserver) { ro = new ResizeObserver(resize); ro.observe(overlay); }
    resize();

    // --- Particules en surimpression (2D) : cœurs, étoiles, gros cœurs ---
    const HEART_COLS = [['#ff8fb1', '#ff2e6e'], ['#ffb3c8', '#ff5c8a'], ['#ff6b8b', '#d90f4a'], ['#ff9ecd', '#e0338a'], ['#ffc1d6', '#ff4d7d']];
    function spawnHearts(X, Y, gain) {
        if (s.t < s.heartT) return; s.heartT = s.t + clamp(0.16 - gain * 0.06, 0.07, 0.16); if (s.hearts.length > 40) return;
        const cols = ['#ff5c8a', '#ff8fab', '#ff3b6b', '#ffb3c6', '#ff7aa2'];
        s.hearts.push({ x: X + rnd(-18, 18) * dpr, y: Y - rnd(6, 24) * dpr, age: 0, life: rnd(1.3, 2.1), size: rnd(9, 19) * dpr, vy: rnd(55, 95) * dpr, wob: rnd(10, 26) * dpr, ph: rnd(0, 6.3), col: cols[Math.floor(Math.random() * cols.length)], rot: rnd(-0.35, 0.35) });
    }
    function burst(X, Y, n) {
        const cols = ['#ffd84a', '#fff3a6', '#ffffff', '#8fe3ff', '#ff9ad5', '#ffb347'];
        for (let i = 0; i < n && s.stars.length < 90; i++) { const a = rnd(0, 6.283), v = rnd(70, 260) * dpr; s.stars.push({ x: X, y: Y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40 * dpr, age: 0, life: rnd(0.7, 1.3), size: rnd(7, 17) * dpr, rot: rnd(0, 6.3), spin: rnd(-6, 6), col: cols[Math.floor(Math.random() * cols.length)], spark: Math.random() < 0.35 }); }
    }
    function spawnStars(X, Y, gain) { if (s.t < s.starT) return; s.starT = s.t + clamp(0.2 - gain * 0.06, 0.09, 0.2); burst(X, Y, 5 + Math.round(gain * 5)); }
    function bigBurst(X, Y, n, rain) {
        for (let i = 0; i < n && s.big.length < 80; i++) { const a = rnd(-Math.PI * 0.95, -Math.PI * 0.05), v = rnd(180, 520) * dpr; s.big.push({ x: X + rnd(-12, 12) * dpr, y: Y, vx: Math.cos(a) * v * 0.9, vy: Math.sin(a) * v, g: rnd(520, 760) * dpr, age: 0, life: rnd(1.6, 2.6), size: rnd(28, 52) * dpr, rot: rnd(0, 6.3), spin: rnd(-5, 5), col: HEART_COLS[Math.floor(Math.random() * HEART_COLS.length)] }); }
        for (let i = 0; i < rain && s.big.length < 80; i++) { s.big.push({ x: rnd(0.04, 0.96) * W, y: -rnd(10, 90) * dpr, vx: rnd(-40, 40) * dpr, vy: rnd(60, 220) * dpr, g: rnd(380, 620) * dpr, age: 0, life: rnd(1.8, 3), size: rnd(26, 48) * dpr, rot: rnd(0, 6.3), spin: rnd(-4, 4), col: HEART_COLS[Math.floor(Math.random() * HEART_COLS.length)] }); }
    }
    function spawnBig(X, Y, gain) { if (s.t < s.bigT) return; s.bigT = s.t + clamp(0.22 - gain * 0.06, 0.1, 0.22); bigBurst(X, Y, 3 + Math.round(gain * 3), 2 + Math.round(gain * 2)); }

    // --- Caresses : lancer de rayon sur le modèle ---
    function pick(ev) {
        const r = overlay.getBoundingClientRect();
        ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
        rc.setFromCamera(ndc, camera);
        const hit = rc.intersectObjects(pickables, false)[0];
        if (!hit) return null;
        const z = hit.object.userData.zone;
        if (z === 'oreille') return 'oreilles';
        if (z === 'ventre') return 'ventre';
        if (z === 'tete') {
            const p = headMesh.worldToLocal(hit.point.clone());    // coordonnées locales (unités de la sphère avant mise à l'échelle)
            if (p.y > 0.25) return 'front';
            if (Math.abs(p.x) > 0.38 && p.y < 0.05 && p.y > -0.65) return 'joues';
        }
        return null;
    }
    const zoneAcc = {};
    function petAcc(zone, gain) { zoneAcc[zone] = (zoneAcc[zone] || 0) + gain * 0.16; if (petCb && zoneAcc[zone] > 1.6) { petCb(zoneAcc[zone], zone); zoneAcc[zone] = 0; } }
    let pressed = false, lastPt = null;
    function toDev(ev) { const r = overlay.getBoundingClientRect(); return [(ev.clientX - r.left) * dpr, (ev.clientY - r.top) * dpr]; }
    function react(zone, ev, gain) {
        const [X, Y] = toDev(ev);
        s.pet = clamp(s.pet + gain * (zone === 'oreilles' ? 0.5 : 0.3), 0, 1);
        if (zone === 'oreilles') { spawnHearts(X, Y, gain); s.ear[ev.clientX < overlay.getBoundingClientRect().width / 2 ? 'L' : 'R'].v += (ev.clientX - lastPt[0] >= 0 ? 1 : -1) * gain * 1.0; }
        else if (zone === 'front') spawnStars(X, Y, gain);
        else spawnBig(X, Y, gain);
        petAcc(zone, gain);
    }
    overlay.addEventListener('pointerdown', (ev) => {
        const z = pick(ev);
        if (z) { const [X, Y] = toDev(ev); if (z === 'front') burst(X, Y, 12); else if (z !== 'oreilles') bigBurst(X, Y, 8, 9); else spawnHearts(X, Y, 1); s.nodV = -3; if (petCb) petCb(2, z); }
        pressed = true; lastPt = [ev.clientX, ev.clientY]; try { overlay.setPointerCapture(ev.pointerId); } catch (e) { /* non pris en charge */ }
    });
    overlay.addEventListener('pointermove', (ev) => {
        const active = pressed || ev.pointerType === 'mouse';
        if (active && lastPt) { const z = pick(ev); if (z) react(z, ev, clamp(Math.hypot(ev.clientX - lastPt[0], ev.clientY - lastPt[1]) / 40, 0, 1.2)); }
        lastPt = [ev.clientX, ev.clientY];
    });
    const release = () => { pressed = false; lastPt = null; };
    overlay.addEventListener('pointerup', release); overlay.addEventListener('pointercancel', release);
    overlay.addEventListener('pointerleave', () => { if (!pressed) lastPt = null; });
    overlay.style.touchAction = 'none';

    // --- Animation ---
    function update(dt) {
        s.t += dt; const st = s.state, k = (r) => 1 - Math.exp(-r * dt);
        const ttilt = st === 'thinking' ? -0.12 : st === 'user' ? 0.08 + s.listenLevel * 0.06 : 0;
        s.tilt = lerp(s.tilt, ttilt, k(3.5));
        s.pulse = Math.max(0, s.pulse - dt * 3.2);
        s.mOpen = lerp(s.mOpen, s.mouthOpen, k(34));
        s.bounce = lerp(s.bounce, st === 'speaking' ? s.mOpen : 0, k(18));
        s.nodV += (-s.nod * 80 - s.nodV * 10) * dt; s.nod += s.nodV * dt;
        s.pet = Math.max(0, s.pet - dt * 0.45);
        s.squint = lerp(s.squint, s.pet > 0.12 ? 0.6 + 0.2 * Math.sin(s.t * 6) : 0, k(9));
        const want = st === 'speaking' ? 0.45 + s.mOpen * 0.6 : st === 'user' ? 0.35 : st === 'thinking' ? 0.2 : 0.25;
        s.swayEnergy = lerp(s.swayEnergy, clamp(want + s.pet * 1.1, 0, 1.6), k(2.5));
        s.swayPhase += dt * (1.55 + s.swayEnergy * 0.9 + s.pet * 3.2);
        s.bodyRotPrev = s.bodyRot;
        s.bodyRot = Math.sin(s.swayPhase) * (0.03 + 0.04 * s.swayEnergy) + Math.sin(s.swayPhase * 2.3 + 1) * 0.008 * s.swayEnergy;
        // Danse
        s.danceE = lerp(s.danceE, s.dance ? 1 : 0, k(s.dance ? 3 : 2));
        s.beat = s.clock ? s.clock() : s.t * (s.bpm / 60);
        if (s.danceE > 0.05) {
            const b0 = Math.floor(s.beat);
            if (b0 !== s.lastBeat) { s.lastBeat = b0; s.nodV -= 3.2 * s.danceE; if (b0 % 4 === 0 && s.stars.length < 40) for (let i = 0; i < 2; i++) burst(rnd(0.1, 0.9) * W, rnd(0.08, 0.5) * H, 3); }
        }
        // Oreilles : ressorts
        s.earTwitchT -= dt;
        if (s.earTwitchT <= 0) { s.earTwitchT = rnd(3.5, 8); const side = Math.random() < 0.5 ? 'L' : 'R'; s.ear[side].v += (side === 'L' ? -1 : 1) * rnd(1.4, 2.4); }
        const bodyVel = (s.bodyRot - s.bodyRotPrev) / Math.max(dt, 1e-3);
        ['L', 'R'].forEach((side) => {
            const e = s.ear[side], out = side === 'L' ? -1 : 1;
            let pose = st === 'user' ? out * 0.07 : st === 'thinking' ? (side === 'L' ? -0.05 : 0.16) : out * 0.015;
            pose += out * s.pet * 0.05;
            const wiggle = s.pet * 0.05 * Math.sin(s.t * 17 + (side === 'L' ? 0 : 1.7)) + s.danceE * 0.16 * Math.sin(Math.PI * s.beat + (side === 'L' ? 0 : 1.2));
            const acc = -150 * (e.a - pose) - 11 * e.v - bodyVel * 0.9 + wiggle * 40 + (st === 'speaking' ? Math.sin(s.t * 9 + (side === 'L' ? 0 : 2)) * s.mOpen * 4 : 0);
            e.v += acc * dt; e.a += e.v * dt; e.a = clamp(e.a, -0.11 - 0.2 * s.danceE, 0.11 + 0.2 * s.danceE);
        });
        s.blinkT -= dt;
        if (s.blinkT <= 0 && s.blinkPhase < 0) s.blinkPhase = 0;
        if (s.blinkPhase >= 0) { s.blinkPhase += dt / 0.10; s.blink = s.blinkPhase < 0.5 ? s.blinkPhase * 2 : Math.max(0, 2 - s.blinkPhase * 2); if (s.blinkPhase >= 1) { s.blinkPhase = -1; s.blink = 0; s.blinkT = Math.random() < 0.25 ? 0.09 : rnd(1.1, 3.0); } }
        for (const h of s.hearts) { h.age += dt; h.y -= h.vy * dt; h.x += Math.cos(h.age * 3.2 + h.ph) * h.wob * dt; } s.hearts = s.hearts.filter(h => h.age < h.life);
        for (const q of s.stars) { q.age += dt; q.x += q.vx * dt; q.y += q.vy * dt; const d = Math.exp(-2.4 * dt); q.vx *= d; q.vy = q.vy * d + 90 * dpr * dt; q.rot += q.spin * dt; } s.stars = s.stars.filter(q => q.age < q.life);
        for (const c of s.big) { c.age += dt; c.x += c.vx * dt; c.y += c.vy * dt; c.vy += c.g * dt; c.vx *= Math.exp(-0.5 * dt); c.rot += c.spin * dt; } s.big = s.big.filter(c => c.age < c.life && c.y < H + 80 * dpr);
    }

    function pose() {
        const dn = s.danceE, bt = s.beat || 0, ph = bt - Math.floor(bt), t = s.t;
        const breath = Math.sin(t * 1.8) * 0.006;
        // Corps entier : pivot aux pieds
        const hop = dn * Math.abs(Math.sin(Math.PI * bt)) * 0.45 + s.bounce * 0.05;
        const squash = dn * 0.08 * Math.exp(-ph * 5);
        root.position.set(Math.sin(s.swayPhase + 1.2) * (0.05 + 0.07 * s.swayEnergy) + dn * Math.sin(Math.PI * bt) * 0.4, hop, 0);
        const m8 = bt % 8, spin = dn > 0.5 && m8 < 1 ? m8 * Math.PI * 2 : 0;
        s.yaw = Math.sin(t * 0.45) * 0.16 + (st3() === 'user' ? 0.12 : 0) + spin;
        root.rotation.set(0, s.yaw, s.bodyRot + s.tilt * 0.4 + dn * Math.sin(Math.PI * bt + Math.PI / 2) * 0.12);
        root.scale.set(1 + breath + squash * 0.6, 1 + breath * 1.3 - squash + s.bounce * 0.012, 1 + breath + squash * 0.6);
        // Tête : hochement, inclinaison, regard
        head.rotation.set(-s.nod * 0.05 + (st3() === 'thinking' ? -0.1 : 0) + Math.sin(t * 0.8) * 0.02, Math.sin(t * 0.6 + 1) * 0.08, s.tilt);
        head.scale.set(1, 1 + s.mOpen * 0.012, 1);
        // Oreilles
        ears.forEach((g) => { const e = s.ear[g.userData.side === -1 ? 'L' : 'R']; g.rotation.z = g.userData.base * (1 - 0.0) * 1 - e.a * 1; g.rotation.x = -0.05 + Math.sin(t * 1.3 + g.userData.side) * 0.015; });
        ears[0].rotation.z = ears[0].userData.base - s.ear.L.a; ears[1].rotation.z = ears[1].userData.base - s.ear.R.a;
        // Bras : balancier, danse
        arms.forEach((g, i) => { const sd = i === 0 ? -1 : 1; g.rotation.z = -sd * (0.1 + 0.15 * s.swayEnergy * Math.sin(s.swayPhase + i * 1.6)) - sd * dn * (0.55 + 0.45 * Math.sin(Math.PI * bt + (i ? Math.PI : 0))); g.rotation.x = -dn * 0.2 * Math.sin(Math.PI * bt * 2 + i) + s.pet * 0.1; });
        // Paupières : descendent sur les billes ; sourient sous les caresses
        const lid = Math.max(s.blink, s.squint);
        lids.forEach((l, i) => { l.visible = lid > 0.03; if (l.visible) { const e = eyes[i]; l.scale.set(1.05, clamp(lid * 1.05, 0, 1), 1.0); l.position.set(e.position.x, e.position.y + 0.12 * (1 - clamp(lid * 1.05, 0, 1)) + 0.005, e.position.z + 0.02); } });
        // Bouche : visible seulement quand il parle
        const o = s.mOpen;
        mouth.visible = o > 0.08;
        if (mouth.visible) { mouth.scale.set(0.09 + 0.06 * s.mouthWide + 0.03 * o, 0.02 + 0.16 * o, 0.04); mouth.position.y = HC.y - 0.53 - o * 0.05; }
    }
    const st3 = () => s.state;

    function drawParticles() {
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, overlay.width, overlay.height);
        for (const c of s.big) {
            const u = c.age / c.life, al = clamp(Math.min(c.age / 0.08, 1) * (1 - Math.max(0, u - 0.7) / 0.3), 0, 1), z = c.size * 1.25;
            ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.rot * 0.25 + Math.sin(c.age * 3 + c.spin) * 0.25); ctx.globalAlpha = al;
            const gr = ctx.createRadialGradient(-z * 0.25, -z * 0.3, z * 0.1, 0, 0, z * 1.1); gr.addColorStop(0, c.col[0]); gr.addColorStop(1, c.col[1]);
            ctx.fillStyle = gr; ctx.shadowColor = c.col[1]; ctx.shadowBlur = z * 0.5;
            ctx.beginPath(); ctx.moveTo(0, z * 0.42); ctx.bezierCurveTo(z * 1.05, -z * 0.15, z * 0.62, -z * 1.0, 0, -z * 0.45); ctx.bezierCurveTo(-z * 0.62, -z * 1.0, -z * 1.05, -z * 0.15, 0, z * 0.42); ctx.fill();
            ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.beginPath(); ctx.ellipse(-z * 0.38, -z * 0.42, z * 0.17, z * 0.1, -0.6, 0, Math.PI * 2); ctx.fill(); ctx.restore();
        }
        for (const q of s.stars) {
            const u = q.age / q.life, al = clamp(Math.min(q.age / 0.05, 1) * (1 - u * u), 0, 1), z = q.size * (1.15 - 0.55 * u);
            ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.rot); ctx.globalAlpha = al; ctx.fillStyle = q.col; ctx.shadowColor = q.col; ctx.shadowBlur = z * 0.9; ctx.beginPath();
            if (q.spark) ctx.arc(0, 0, z * 0.28, 0, Math.PI * 2);
            else { for (let i = 0; i < 10; i++) { const rr = i % 2 === 0 ? z : z * 0.42, an = -Math.PI / 2 + i * Math.PI / 5; if (i === 0) ctx.moveTo(Math.cos(an) * rr, Math.sin(an) * rr); else ctx.lineTo(Math.cos(an) * rr, Math.sin(an) * rr); } ctx.closePath(); }
            ctx.fill(); ctx.restore();
        }
        for (const hh of s.hearts) {
            const u = hh.age / hh.life, al = clamp(Math.min(hh.age / 0.15, 1) * (1 - u * u), 0, 1), z = hh.size * (0.7 + 0.5 * Math.min(u * 2, 1));
            ctx.save(); ctx.translate(hh.x, hh.y); ctx.rotate(hh.rot + Math.sin(hh.age * 3 + hh.ph) * 0.2); ctx.globalAlpha = al; ctx.fillStyle = hh.col; ctx.shadowColor = 'rgba(255,90,140,0.6)'; ctx.shadowBlur = z * 0.6;
            ctx.beginPath(); ctx.moveTo(0, z * 0.38); ctx.bezierCurveTo(z * 0.95, -z * 0.15, z * 0.55, -z * 0.95, 0, -z * 0.42); ctx.bezierCurveTo(-z * 0.55, -z * 0.95, -z * 0.95, -z * 0.15, 0, z * 0.38); ctx.fill(); ctx.restore();
        }
    }

    function frame(now) {
        if (!running) return;
        const dt = clamp((now - last) / 1000, 0, 0.05); last = now;
        update(dt); pose(); frame3d(); renderer.render(scene, camera); drawParticles();
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    return {
        setState(st) { s.state = st; },
        setMouth(open, wide) { s.mouthOpen = clamp(open * 1.2, 0, 1); s.mouthWide = clamp(wide, 0, 1); },
        setListenLevel(v) { s.listenLevel = lerp(s.listenLevel, clamp(v, 0, 1), 0.25); },
        nod(strength) { s.nodV = -(strength || 1) * 6; s.pulse = 1; },
        onPet(cb) { petCb = cb; },
        setDance(on, bpm, clock) { s.dance = !!on; if (bpm) s.bpm = bpm; s.clock = clock || null; s.lastBeat = -1; },
        _pet(side) { s.pet = 1; s.ear[side].v += 3; spawnHearts(W * (side === 'L' ? 0.3 : 0.7), H * 0.22, 1); },
        _state: s,
        _three: { scene, camera, renderer, root, head, ears },
        stop() {
            running = false; window.removeEventListener('resize', resize); if (ro) ro.disconnect();
            renderer.dispose(); pm.dispose(); if (gl.parentNode) gl.parentNode.removeChild(gl);
            ctx.clearRect(0, 0, overlay.width, overlay.height);
        }
    };
}

window.AvatarRabbit3D = Rabbit3D;
window.dispatchEvent(new Event('avatar3d-ready'));
