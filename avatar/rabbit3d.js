// rabbit3d.js — le lapin Sylvanian Families en 3D, FIDÈLE À LA PHOTO : chaque calque de la photo (corps, oreille gauche, oreille droite)
// est gonflé en volume à partir de sa silhouette (relief déduit de la distance au bord), la photo servant de texture :
// de face, c'est la peluche exacte ; elle tourne, danse et se penche pour de vrai. Le dos reçoit la couleur floutée de la face.
// Les oreilles sont des pièces séparées et articulées. Les caresses se détectent par lancer de rayon sur le volume.
// Même interface que rabbit.js : setState, setMouth, setListenLevel, nod, onPet, setDance, stop.
import * as THREE from './../vendor/three/three.module.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = (a, b) => a + Math.random() * (b - a);

// --- Repères relevés sur la photo (image de 1000 × 1541 px) ---
const IW = 1000, IH = 1541;
const BOX = [92, 5, 859, 1534];                         // cadre du lapin
const EYES = [[353.5, 601.5], [617.5, 602.5]], EYE_R = 37;
const MOUTH = [488, 748];
const PIVOT = { L: [320, 310], R: [655, 310] };         // base de chaque oreille
const FOREHEAD = { x: 490, y: 440, rx: 190, ry: 125 };
const CHEEKS = [{ x: 320, y: 705, rx: 105, ry: 85 }, { x: 665, y: 705, rx: 105, ry: 85 }];
const BELLY = { x: 490, y: 1085, rx: 225, ry: 185 };
const MODEL_H = 5.4, S = MODEL_H / (BOX[3] - BOX[1]);   // pixels de la photo → unités du monde
const CX = (BOX[0] + BOX[2]) / 2;
const wx = (px) => (px - CX) * S, wy = (py) => (BOX[3] - py) * S;
// Relief : épaisseur (px) = K × (distance au bord)^EXP. La tête atteint ≈ 250 px de profondeur, les bras restent minces.
const DEPTH_K = 6.4, DEPTH_EXP = 0.65, STEP = 4;
const inEllipse = (px, py, e) => ((px - e.x) / e.rx) ** 2 + ((py - e.y) / e.ry) ** 2 <= 1;

// Gonfle une image découpée : renvoie les deux demi-coques (face, dos) et une fonction donnant l'épaisseur en un point
function inflate(img) {
    const W = img.width, H = img.height;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
    const A = g.getImageData(0, 0, W, H).data;
    const gw = Math.ceil(W / STEP) + 1, gh = Math.ceil(H / STEP) + 1;
    const inside = new Uint8Array(gw * gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) inside[j * gw + i] = A[(Math.min(H - 1, j * STEP) * W + Math.min(W - 1, i * STEP)) * 4 + 3] > 100 ? 1 : 0;
    // Distance au bord (chanfrein, en cases) : deux passes
    const d = new Float32Array(gw * gh), INF = 1e9;
    for (let k = 0; k < d.length; k++) d[k] = inside[k] ? INF : 0;
    const at = (i, j) => (i < 0 || j < 0 || i >= gw || j >= gh ? 0 : d[j * gw + i]);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) { const k = j * gw + i; if (!inside[k]) continue; d[k] = Math.min(d[k], at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + 1.414, at(i + 1, j - 1) + 1.414); }
    for (let j = gh - 1; j >= 0; j--) for (let i = gw - 1; i >= 0; i--) { const k = j * gw + i; if (!inside[k]) continue; d[k] = Math.min(d[k], at(i + 1, j) + 1, at(i, j + 1) + 1, at(i + 1, j + 1) + 1.414, at(i - 1, j + 1) + 1.414); }
    // Sommets : les cases du lapin et leur voisinage (pour que le bord de la texture soit couvert)
    const idx = new Int32Array(gw * gh).fill(-1), pos = [], uv = [], zpx = [];
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
        let near = inside[j * gw + i];
        for (let dj = -1; dj <= 1 && !near; dj++) for (let di = -1; di <= 1 && !near; di++) { const ii = i + di, jj = j + dj; if (ii >= 0 && jj >= 0 && ii < gw && jj < gh && inside[jj * gw + ii]) near = 1; }
        if (!near) continue;
        const px = i * STEP, py = j * STEP, dd = d[j * gw + i], z = inside[j * gw + i] && dd > 1 ? DEPTH_K * Math.pow((dd - 1) * STEP, DEPTH_EXP) : 0;   // épaisseur nulle sur la couronne du bord : les deux coques se rejoignent sans fente
        idx[j * gw + i] = pos.length / 3; pos.push(wx(px), wy(py), z * S); uv.push(px / W, 1 - py / H); zpx.push(z);
    }
    const tri = [];
    for (let j = 0; j < gh - 1; j++) for (let i = 0; i < gw - 1; i++) {
        const a = idx[j * gw + i], b = idx[j * gw + i + 1], c = idx[(j + 1) * gw + i], e = idx[(j + 1) * gw + i + 1];
        if (a < 0 || b < 0 || c < 0 || e < 0) continue;
        tri.push(a, c, e, a, e, b);
    }
    const n = pos.length / 3;
    function shell(sign) {
        const geo = new THREE.BufferGeometry();
        const p = new Float32Array(pos); if (sign < 0) for (let k = 2; k < p.length; k += 3) p[k] = -p[k];
        geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
        let t = tri;
        if (sign < 0) { t = tri.slice(); for (let k = 0; k < t.length; k += 3) { const x = t[k + 1]; t[k + 1] = t[k + 2]; t[k + 2] = x; } }   // le dos a l'orientation inverse
        geo.setIndex(t);
        geo.computeVertexNormals();
        // Ombrage doux : lumière venant du haut à gauche, multiplié par la texture (matériau sans éclairage = couleurs exactes de la photo)
        const nr = geo.attributes.normal, col = new Float32Array(n * 3), L = new THREE.Vector3(-0.3, 0.5, 0.82).normalize();
        for (let k = 0; k < n; k++) { const dt = nr.getX(k) * L.x + nr.getY(k) * L.y + nr.getZ(k) * L.z * (sign > 0 ? 1 : -1); const sh = clamp(0.8 + 0.32 * dt, 0.6, 1.04); col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = sh; }
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        geo.computeBoundingSphere();
        return geo;
    }
    const zAt = (px, py) => { const i = Math.round(px / STEP), j = Math.round(py / STEP); const k = idx[Math.max(0, Math.min(gh - 1, j)) * gw + Math.max(0, Math.min(gw - 1, i))]; return k < 0 ? 0 : zpx[k]; };
    return { front: shell(1), back: shell(-1), zAt };
}

// --- Textures : couleurs « débordantes » (sans frange noire au bord), carte de transparence à part, dos flou sans yeux ---
const FUR = 'rgb(214,203,184)';
function opaquePadded(drawSource, w, h, base) {
    // Fond de la couleur du pelage, puis la source à des échelles de plus en plus fines : les couleurs de la silhouette débordent au-delà de son bord
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = base || FUR; g.fillRect(0, 0, w, h); g.imageSmoothingEnabled = true;
    for (const k of [10, 20, 40, 80, 160, 320]) {
        const sm = document.createElement('canvas'); sm.width = k; sm.height = Math.max(1, Math.round(k * h / w));
        sm.getContext('2d').drawImage(drawSource, 0, 0, sm.width, sm.height);
        g.drawImage(sm, 0, 0, w, h);
    }
    g.drawImage(drawSource, 0, 0, w, h);
    return c;
}
function alphaCanvas(img) {
    const t = document.createElement('canvas'); t.width = img.width; t.height = img.height;
    const tg = t.getContext('2d'); tg.drawImage(img, 0, 0); tg.globalCompositeOperation = 'source-in'; tg.fillStyle = '#fff'; tg.fillRect(0, 0, t.width, t.height);
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); g.drawImage(t, 0, 0);
    return c;
}
function makeTextures(img, ear, aniso) {
    const W = img.width, H = img.height;
    const front = new THREE.CanvasTexture(opaquePadded(img, W, H)); front.colorSpace = THREE.SRGBColorSpace; front.anisotropy = aniso;
    const alpha = new THREE.CanvasTexture(alphaCanvas(img)); alpha.anisotropy = aniso;
    let backCv;
    if (ear) { backCv = document.createElement('canvas'); backCv.width = backCv.height = 8; const g = backCv.getContext('2d'); g.fillStyle = 'rgb(205,193,174)'; g.fillRect(0, 0, 8, 8); }   // dos des oreilles : pelage uni
    else {
        // Dos du corps : la photo sans yeux ni nez (repeints à la couleur du pelage), très floue
        const c0 = document.createElement('canvas'); c0.width = W; c0.height = H;
        const g0 = c0.getContext('2d'); g0.drawImage(img, 0, 0); g0.fillStyle = FUR;
        for (const [x, y, r] of [[EYES[0][0], EYES[0][1], 70], [EYES[1][0], EYES[1][1], 70], [488, 672, 60], [488, 748, 70]]) { g0.beginPath(); g0.arc(x, y, r, 0, 6.283); g0.fill(); }
        const sm = document.createElement('canvas'); sm.width = 20; sm.height = Math.round(20 * H / W); sm.getContext('2d').drawImage(c0, 0, 0, sm.width, sm.height);
        backCv = opaquePadded(sm, 256, Math.round(256 * H / W));
    }
    const back = new THREE.CanvasTexture(backCv); back.colorSpace = THREE.SRGBColorSpace;
    return { front, alpha, back };
}

function Rabbit3D(overlay) {
    // --- Rendu : canvas WebGL transparent juste derrière le canevas 2D (cœurs, étoiles, caresses) ---
    const gl = document.createElement('canvas');
    gl.className = 'face3d';
    overlay.parentNode.insertBefore(gl, overlay);
    const renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.NoToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
    const root = new THREE.Group(); scene.add(root);               // pivot aux pieds
    const pickables = [], parts = {};
    let ready = false, zBody = null, eyeLids = [], mouthMesh = null, jawBase = 0, bodyCanvas = null;

    // --- Chargement de la photo découpée en trois calques, puis gonflage ---
    const SRC = { body: 'lapin_corps.png', earL: 'oreille_g.png', earR: 'oreille_d.png' };
    const imgs = {}; let loaded = 0, failed = false;
    Object.entries(SRC).forEach(([k, url]) => {
        const im = new Image(); im.onerror = () => { failed = true; };
        im.onload = () => { if (++loaded === 3 && !failed) build(); };
        im.src = url; imgs[k] = im;
    });
    function build() {
        const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        for (const [key, ear] of [['body', false], ['earL', true], ['earR', true]]) {
            const inf = inflate(imgs[key]);
            const T = makeTextures(imgs[key], ear, aniso);
            if (!ear) bodyCanvas = T.front.image;
            const matF = new THREE.MeshBasicMaterial({ map: T.front, alphaMap: T.alpha, vertexColors: true, alphaTest: ear ? 0.03 : 0.5, transparent: ear });
            const matB = new THREE.MeshBasicMaterial({ map: T.back, alphaMap: T.alpha, vertexColors: true, alphaTest: ear ? 0.03 : 0.5, transparent: ear });
            const f = new THREE.Mesh(inf.front, matF), b = new THREE.Mesh(inf.back, matB);
            const g = new THREE.Group(); g.add(f, b);
            if (ear) {
                const side = key === 'earL' ? 'L' : 'R', [px, py] = PIVOT[side];
                const pivot = new THREE.Group(); pivot.position.set(wx(px), wy(py), 0); g.position.set(-wx(px), -wy(py), 0); pivot.add(g); root.add(pivot);
                parts[key] = pivot; f.userData.zone = b.userData.zone = 'oreilles';
            } else { root.add(g); zBody = inf.zAt; parts.body = g; f.userData.zone = b.userData.zone = 'corps'; }
            pickables.push(f, b);
        }
        // Paupières naturelles : une « décalcomanie » de vrai pelage (copié juste sous chaque œil, donc même grain et même teinte),
        // collée à la surface du visage, bords adoucis, avec un pli ombré et un trait de cils sur le bord. Elle descend depuis le haut de l'œil.
        const LWpx = EYE_R * 2.8, LHpx = EYE_R * 3.1, TOP = EYE_R * 1.4;
        EYES.forEach(([ex, ey]) => {
            const cw = 160, ch = 140, c = document.createElement('canvas'); c.width = cw; c.height = ch;
            const g = c.getContext('2d');
            g.drawImage(bodyCanvas, ex - LWpx / 2, ey + EYE_R * 1.5, LWpx, LHpx, 0, 0, cw, ch);          // pelage voisin
            const sh = g.createLinearGradient(0, ch * 0.45, 0, ch * 0.9); sh.addColorStop(0, 'rgba(110,88,68,0)'); sh.addColorStop(1, 'rgba(110,88,68,0.32)');
            g.fillStyle = sh; g.fillRect(0, 0, cw, ch);                                                      // pli : un peu d'ombre vers le bord
            g.strokeStyle = 'rgba(72,54,42,0.9)'; g.lineWidth = 5; g.lineCap = 'round';
            g.beginPath(); g.moveTo(cw * 0.13, ch * 0.78); g.quadraticCurveTo(cw * 0.5, ch * 0.93, cw * 0.87, ch * 0.78); g.stroke();      // bord de la paupière
            g.lineWidth = 2.2; g.strokeStyle = 'rgba(72,54,42,0.55)';
            for (let k = 0; k < 7; k++) { const t = 0.2 + k * 0.1, x = cw * t, y = ch * (0.78 + 0.15 * 4 * t * (1 - t) * 0.9); g.beginPath(); g.moveTo(x, y); g.lineTo(x + (t - 0.5) * 6, y + 7); g.stroke(); }   // quelques cils
            const ac = document.createElement('canvas'); ac.width = cw; ac.height = ch;
            const ag = ac.getContext('2d'); ag.fillStyle = '#000'; ag.fillRect(0, 0, cw, ch);
            ag.shadowColor = '#fff'; ag.shadowBlur = 14; ag.fillStyle = '#fff'; ag.beginPath(); ag.ellipse(cw / 2, ch * 0.5, cw * 0.38, ch * 0.4, 0, 0, 6.283); ag.fill();
            const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; const alpha = new THREE.CanvasTexture(ac);
            const wW = LWpx * S, hW = LHpx * S, pyTop = ey - TOP;
            const geo = new THREE.PlaneGeometry(wW, hW, 12, 10); geo.translate(0, -hW / 2, 0);
            const z0 = zBody(ex, pyTop) * S, pos = geo.attributes.position;
            for (let i = 0; i < pos.count; i++) {   // chaque sommet épouse la surface du visage
                const px = ex + pos.getX(i) / S, py = pyTop - pos.getY(i) / S;
                pos.setZ(i, Math.max(zBody(px, py) * S - z0, -0.25) + 0.022);
            }
            geo.computeBoundingSphere();
            const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map, alphaMap: alpha, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
            m.position.set(wx(ex), wy(pyTop), z0); m.scale.y = 0.0001; m.visible = false; m.renderOrder = 5;
            root.add(m); eyeLids.push(m);
        });
        // Bouche : visible seulement quand il parle
        mouthMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0x3a1418 }));
        mouthMesh.position.set(wx(MOUTH[0]), wy(MOUTH[1]), zBody(MOUTH[0], MOUTH[1]) * S + 0.02); mouthMesh.visible = false; jawBase = mouthMesh.position.y;
        root.add(mouthMesh);
        ready = true;
    }

    // --- État d'animation (même logique que la version 2D) ---
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
    // La caméra place le lapin entier entre les énigmes (haut) et les boutons (bas)
    function frame3d() {
        const topCss = parseFloat(overlay.dataset.top) || 0, botCss = parseFloat(overlay.dataset.bottom) || 210, hCss = H / dpr;
        const region = Math.max(120, hCss - topCss - botCss), frac = region / hCss;
        const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        let d = (MODEL_H * 1.1) / (frac * 2 * tanH);
        const dW = (3.6 * 1.15) / (2 * tanH * camera.aspect); d = Math.max(d, dW);
        const visH = 2 * d * tanH, shift = ((topCss + region / 2) - hCss / 2) / hCss * visH, cy = MODEL_H / 2;
        camera.position.set(0, cy + shift, d); camera.lookAt(0, cy + shift, 0); camera.updateProjectionMatrix();
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

    // --- Caresses : lancer de rayon ; la zone se lit sur la photo grâce aux coordonnées de texture du point touché ---
    function pick(ev) {
        if (!ready) return null;
        const r = overlay.getBoundingClientRect();
        ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
        rc.setFromCamera(ndc, camera); rc.firstHitOnly = true;
        root.updateMatrixWorld(true);
        const hit = rc.intersectObjects(pickables, false)[0];
        if (!hit) return null;
        if (hit.object.userData.zone === 'oreilles') return 'oreilles';
        const px = hit.uv.x * IW, py = (1 - hit.uv.y) * IH;
        if (inEllipse(px, py, FOREHEAD)) return 'front';
        if (CHEEKS.some(c => inEllipse(px, py, c))) return 'joues';
        if (inEllipse(px, py, BELLY)) return 'ventre';
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
        const ttilt = st === 'thinking' ? -0.07 : st === 'user' ? 0.05 + s.listenLevel * 0.04 : 0;
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
        s.bodyRot = Math.sin(s.swayPhase) * (0.025 + 0.03 * s.swayEnergy) + Math.sin(s.swayPhase * 2.3 + 1) * 0.006 * s.swayEnergy;
        s.danceE = lerp(s.danceE, s.dance ? 1 : 0, k(s.dance ? 3 : 2));
        s.beat = s.clock ? s.clock() : s.t * (s.bpm / 60);
        if (s.danceE > 0.05) {
            const b0 = Math.floor(s.beat);
            if (b0 !== s.lastBeat) { s.lastBeat = b0; s.nodV -= 3.2 * s.danceE; if (b0 % 4 === 0 && s.stars.length < 40) for (let i = 0; i < 2; i++) burst(rnd(0.1, 0.9) * W, rnd(0.08, 0.5) * H, 3); }
        }
        s.earTwitchT -= dt;
        if (s.earTwitchT <= 0) { s.earTwitchT = rnd(3.5, 8); const side = Math.random() < 0.5 ? 'L' : 'R'; s.ear[side].v += (side === 'L' ? -1 : 1) * rnd(1.4, 2.4); }
        const bodyVel = (s.bodyRot - s.bodyRotPrev) / Math.max(dt, 1e-3);
        ['L', 'R'].forEach((side) => {
            const e = s.ear[side], out = side === 'L' ? -1 : 1;
            let pose = st === 'user' ? out * 0.07 : st === 'thinking' ? (side === 'L' ? -0.05 : 0.16) : out * 0.015;
            pose += out * s.pet * 0.05;
            const wiggle = s.pet * 0.05 * Math.sin(s.t * 17 + (side === 'L' ? 0 : 1.7)) + s.danceE * 0.16 * Math.sin(Math.PI * s.beat + (side === 'L' ? 0 : 1.2));
            const acc = -150 * (e.a - pose) - 11 * e.v - bodyVel * 0.9 + wiggle * 40 + (st === 'speaking' ? Math.sin(s.t * 9 + (side === 'L' ? 0 : 2)) * s.mOpen * 4 : 0);
            e.v += acc * dt; e.a += e.v * dt; e.a = clamp(e.a, -0.14 - 0.2 * s.danceE, 0.14 + 0.2 * s.danceE);
        });
        s.blinkT -= dt;
        if (s.blinkT <= 0 && s.blinkPhase < 0) s.blinkPhase = 0;
        if (s.blinkPhase >= 0) { s.blinkPhase += dt / 0.10; s.blink = s.blinkPhase < 0.5 ? s.blinkPhase * 2 : Math.max(0, 2 - s.blinkPhase * 2); if (s.blinkPhase >= 1) { s.blinkPhase = -1; s.blink = 0; s.blinkT = Math.random() < 0.25 ? 0.09 : rnd(1.1, 3.0); } }
        for (const h of s.hearts) { h.age += dt; h.y -= h.vy * dt; h.x += Math.cos(h.age * 3.2 + h.ph) * h.wob * dt; } s.hearts = s.hearts.filter(h => h.age < h.life);
        for (const q of s.stars) { q.age += dt; q.x += q.vx * dt; q.y += q.vy * dt; const d = Math.exp(-2.4 * dt); q.vx *= d; q.vy = q.vy * d + 90 * dpr * dt; q.rot += q.spin * dt; } s.stars = s.stars.filter(q => q.age < q.life);
        for (const c of s.big) { c.age += dt; c.x += c.vx * dt; c.y += c.vy * dt; c.vy += c.g * dt; c.vx *= Math.exp(-0.5 * dt); c.rot += c.spin * dt; } s.big = s.big.filter(c => c.age < c.life && c.y < H + 80 * dpr);
    }

    function pose() {
        if (!ready) return;
        const dn = s.danceE, bt = s.beat || 0, ph = bt - Math.floor(bt), t = s.t, breath = Math.sin(t * 1.8) * 0.006;
        const hop = dn * Math.abs(Math.sin(Math.PI * bt)) * 0.45 + s.bounce * 0.05, squash = dn * 0.08 * Math.exp(-ph * 5);
        root.position.set(Math.sin(s.swayPhase + 1.2) * (0.05 + 0.07 * s.swayEnergy) + dn * Math.sin(Math.PI * bt) * 0.4, hop, 0);
        const m8 = bt % 8, spin = dn > 0.5 && m8 < 1 ? m8 * Math.PI * 2 : 0;
        // Petit mouvement de tête-corps : un léger pivot, pour que le volume vive même de face
        s.yaw = Math.sin(t * 0.45) * 0.22 + (s.state === 'user' ? 0.14 : 0) + Math.sin(s.swayPhase) * 0.05 * s.swayEnergy + spin;
        root.rotation.set(-s.nod * 0.05 + (s.state === 'thinking' ? -0.05 : 0), s.yaw, s.bodyRot + s.tilt * 0.5 + dn * Math.sin(Math.PI * bt + Math.PI / 2) * 0.12);
        root.scale.set(1 + breath + squash * 0.6, 1 + breath * 1.3 - squash + s.bounce * 0.012, 1 + breath + squash * 0.6);
        // Oreilles articulées à leur base
        if (parts.earL) parts.earL.rotation.z = -s.ear.L.a;
        if (parts.earR) parts.earR.rotation.z = -s.ear.R.a;
        // Paupières : descendent sur les billes ; yeux plissés sous les caresses
        const lid = clamp(Math.max(s.blink, s.squint) * 1.05, 0, 1);
        eyeLids.forEach((l) => { l.visible = lid > 0.06; if (l.visible) l.scale.y = lid; });
        // Bouche
        const o = s.mOpen;
        if (mouthMesh) { mouthMesh.visible = o > 0.08; if (mouthMesh.visible) { mouthMesh.scale.set((0.1 + 0.07 * s.mouthWide + 0.03 * o) * 0.9, 0.03 + 0.17 * o, 0.04); mouthMesh.position.y = jawBase - o * 0.05; } }
    }

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
        _three: { scene, camera, renderer, root, parts, isReady: () => ready },
        stop() {
            running = false; window.removeEventListener('resize', resize); if (ro) ro.disconnect();
            scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
            renderer.dispose(); if (gl.parentNode) gl.parentNode.removeChild(gl);
            ctx.clearRect(0, 0, overlay.width, overlay.height);
        }
    };
}

window.AvatarRabbit3D = Rabbit3D;
window.dispatchEvent(new Event('avatar3d-ready'));
