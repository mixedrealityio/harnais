// rabbit.js — tête « photo » vivante : le lapin en peluche se balance, respire, cligne des yeux, bouge la mâchoire avec la voix,
// et réagit aux caresses sur ses oreilles (glisser le doigt ou la souris dessus : elles frétillent, il plisse les yeux et sourit).
// Photo découpée en trois calques : le corps et chaque oreille, pour que les oreilles bougent indépendamment.
// Même interface que face.js : setState, setMouth, setListenLevel, nod, stop ; en plus onPet(callback).
(function () {
    'use strict';
    const SRC = { body: 'lapin_corps.png', earL: 'oreille_g.png', earR: 'oreille_d.png' };
    const K = 5.8;                                  // échelle des détails dessinés (paupières, bouche)
    const IW = 1000, IH = 1541;                     // taille des images
    const BOX = [92, 5, 859, 1534];                 // cadre du lapin dans l'image
    const EYES = [[353.5, 601.5], [617.5, 602.5]];  // billes noires
    const EYE_R = 37;
    const MOUTH = [488, 748];                       // sous le museau, sur l'axe du visage (milieu des yeux ≈ 485, nez ≈ 490)
    const PIVOT = { L: [320, 310], R: [655, 310] }; // base de chaque oreille
    const JAW = { x: 373, y: 700, w: 230, h: 105 }; // bas du museau, qui descend quand la bouche s'ouvre
    const RESERVE_CSS = 210;                        // hauteur gardée en bas pour le texte et les boutons
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const lerp = (a, b, t) => a + (b - a) * t;
    const rnd = (a, b) => a + Math.random() * (b - a);

    function Rabbit(canvas) {
        const ctx = canvas.getContext('2d');
        const img = {};
        let loaded = 0, ready = false, jawPatch = null;
        const earAlpha = { L: null, R: null };
        const furEyes = ['rgb(214,204,190)', 'rgb(214,204,190)'];
        Object.entries(SRC).forEach(([k, url]) => {
            const im = new Image();
            im.onload = () => { if (++loaded === 3) prepare(); };
            im.src = url;
            img[k] = im;
        });
        function prepare() {
            try {
                // Bas du museau détaché, bords fondus : il descend avec la voix sans laisser de contour
                jawPatch = document.createElement('canvas'); jawPatch.width = JAW.w; jawPatch.height = JAW.h;
                const g = jawPatch.getContext('2d');
                g.drawImage(img.body, JAW.x, JAW.y, JAW.w, JAW.h, 0, 0, JAW.w, JAW.h);
                g.globalCompositeOperation = 'destination-in';
                g.save(); g.translate(JAW.w / 2, JAW.h / 2); g.scale(JAW.w / JAW.h, 1);
                const m = g.createRadialGradient(0, 0, JAW.h * 0.18, 0, 0, JAW.h * 0.62);
                m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)');
                g.fillStyle = m; g.fillRect(-JAW.w, -JAW.h, JAW.w * 2, JAW.h * 2); g.restore();
                // Masques des oreilles (1/4 de taille) pour savoir si un doigt les touche
                ['L', 'R'].forEach((side) => {
                    const c = document.createElement('canvas'); c.width = IW / 4; c.height = Math.round(IH / 4);
                    const cg = c.getContext('2d');
                    cg.drawImage(img[side === 'L' ? 'earL' : 'earR'], 0, 0, c.width, c.height);
                    earAlpha[side] = cg.getImageData(0, 0, c.width, c.height);
                });
                // Pelage au-dessus de chaque œil
                const c1 = document.createElement('canvas'); c1.width = c1.height = 1;
                const g1 = c1.getContext('2d');
                EYES.forEach(([x, y], i) => {
                    g1.clearRect(0, 0, 1, 1);
                    g1.drawImage(img.body, x - 14, y - EYE_R * 1.9, 28, 20, 0, 0, 1, 1);
                    const d = g1.getImageData(0, 0, 1, 1).data;
                    furEyes[i] = `rgb(${d[0]},${d[1]},${d[2]})`;
                });
            } catch (e) { /* sans canvas lisible : pas de caresses, le reste fonctionne */ }
            ready = true;
        }

        const s = {
            state: 'idle', mouthOpen: 0, mouthWide: 0.5, mOpen: 0, mWide: 0.5, pulse: 0,
            blink: 0, blinkT: rnd(1.5, 4), blinkPhase: -1, squint: 0,
            tilt: 0, ttilt: 0, nod: 0, nodV: 0, bounce: 0, listenLevel: 0, t: 0,
            swayPhase: rnd(0, 6), swayEnergy: 0, bodyRot: 0, bodyRotPrev: 0,
            ear: { L: { a: 0, v: 0 }, R: { a: 0, v: 0 } }, earTwitchT: rnd(3, 7),
            pet: 0, petTotal: 0, hearts: [], heartT: 0
        };
        let dpr = 1, last = performance.now(), running = true, petCb = null;
        let view = { cx0: 0, cy0: 0, sc: 1, cx: 0, cy: 0 };   // pour convertir un point de l'écran en point de l'image

        function resize() {
            const r = canvas.getBoundingClientRect();
            dpr = Math.min(window.devicePixelRatio || 1, 3);
            canvas.width = Math.max(1, Math.round(r.width * dpr));
            canvas.height = Math.max(1, Math.round(r.height * dpr));
        }
        window.addEventListener('resize', resize);
        let ro = null;
        if (window.ResizeObserver) { ro = new ResizeObserver(resize); ro.observe(canvas); }
        resize();

        // --- Caresses : le doigt (ou la souris) glisse sur une oreille ---
        function toImage(ev) {
            const r = canvas.getBoundingClientRect();
            const X = (ev.clientX - r.left) * dpr, Y = (ev.clientY - r.top) * dpr;
            return [(X - view.cx0) / view.sc + view.cx, (Y - view.cy0) / view.sc + view.cy];
        }
        function earAt(ix, iy) {
            for (const side of ['L', 'R']) {
                const d = earAlpha[side];
                if (!d) continue;
                const qx = Math.round(ix / 4), qy = Math.round(iy / 4);
                for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {   // marge : un doigt est plus large qu'un pixel
                    const x = qx + dx, y = qy + dy;
                    if (x >= 0 && y >= 0 && x < d.width && y < d.height && d.data[(y * d.width + x) * 4 + 3] > 40) return side;
                }
            }
            return null;
        }
        function spawnHearts(X, Y, gain) {
            if (s.t < s.heartT) return;
            s.heartT = s.t + clamp(0.16 - gain * 0.06, 0.07, 0.16);
            if (s.hearts.length > 40) return;
            const cols = ['#ff5c8a', '#ff8fab', '#ff3b6b', '#ffb3c6', '#ff7aa2'];
            s.hearts.push({ x: X + rnd(-18, 18) * dpr, y: Y - rnd(6, 24) * dpr, age: 0, life: rnd(1.3, 2.1), size: rnd(9, 19) * dpr,
                vy: rnd(55, 95) * dpr, wob: rnd(10, 26) * dpr, ph: rnd(0, 6.3), col: cols[Math.floor(Math.random() * cols.length)], rot: rnd(-0.35, 0.35) });
        }
        let pressed = false, lastPt = null;
        function onMove(ev) {
            if (!ready) return;
            const [ix, iy] = toImage(ev);
            const side = earAt(ix, iy);
            const active = pressed || ev.pointerType === 'mouse';
            if (side && active && lastPt) {
                const dist = Math.hypot(ev.clientX - lastPt[0], ev.clientY - lastPt[1]);
                const gain = clamp(dist / 40, 0, 1.2);
                s.pet = clamp(s.pet + gain * 0.5, 0, 1);
                s.petTotal += gain * 0.16;
                const r0 = canvas.getBoundingClientRect();
                spawnHearts((ev.clientX - r0.left) * dpr, (ev.clientY - r0.top) * dpr, gain);
                s.ear[side].v += (ev.clientX - lastPt[0] >= 0 ? 1 : -1) * gain * 1.0;   // le poil suit le doigt
                if (petCb && s.petTotal > 1.6) { petCb(s.petTotal); s.petTotal = 0; }
            }
            lastPt = [ev.clientX, ev.clientY];
        }
        canvas.addEventListener('pointerdown', (ev) => { pressed = true; lastPt = [ev.clientX, ev.clientY]; try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* non pris en charge */ } });
        canvas.addEventListener('pointermove', onMove);
        const release = () => { pressed = false; lastPt = null; };
        canvas.addEventListener('pointerup', release);
        canvas.addEventListener('pointercancel', release);
        canvas.addEventListener('pointerleave', () => { if (!pressed) lastPt = null; });
        canvas.style.touchAction = 'none';

        // --- Comportement ---
        function update(dt) {
            s.t += dt;
            const st = s.state;
            const k = (r) => 1 - Math.exp(-r * dt);
            s.ttilt = st === 'thinking' ? -0.07 : st === 'user' ? 0.05 + s.listenLevel * 0.04 : 0;
            s.tilt = lerp(s.tilt, s.ttilt, k(3.5));
            // Bouche : voix, petite respiration des lèvres à l'écoute, pulsation sur les « hm »
            s.pulse = Math.max(0, s.pulse - dt * 3.2);
            const target = s.mouthOpen;   // seulement la voix : rien n'est visible quand il ne parle pas
            s.mOpen = lerp(s.mOpen, target, k(34));
            s.mWide = lerp(s.mWide, s.mouthWide, k(20));
            s.bounce = lerp(s.bounce, st === 'speaking' ? s.mOpen : 0, k(18));
            // Hochement
            s.nodV += (-s.nod * 80 - s.nodV * 10) * dt;
            s.nod += s.nodV * dt;
            // Caresses : montent vite, retombent doucement
            s.pet = Math.max(0, s.pet - dt * 0.45);
            s.squint = lerp(s.squint, s.pet > 0.12 ? 0.6 + 0.2 * Math.sin(s.t * 6) : 0, k(9));
            // Balancement : l'énergie monte avec la parole et les caresses
            const want = st === 'speaking' ? 0.45 + s.mOpen * 0.6 : st === 'user' ? 0.35 : st === 'thinking' ? 0.2 : 0.25;
            s.swayEnergy = lerp(s.swayEnergy, clamp(want + s.pet * 1.1, 0, 1.6), k(2.5));
            s.swayPhase += dt * (1.55 + s.swayEnergy * 0.9 + s.pet * 3.2);
            const w = s.swayPhase;
            s.bodyRotPrev = s.bodyRot;
            s.bodyRot = Math.sin(w) * (0.02 + 0.026 * s.swayEnergy) + Math.sin(w * 2.3 + 1) * 0.006 * s.swayEnergy;
            // Oreilles : ressort vers une pose (dressées à l'écoute, penchées en réflexion), retard sur le balancement, frétillement
            s.earTwitchT -= dt;
            if (s.earTwitchT <= 0) {
                s.earTwitchT = rnd(3.5, 8);
                const side = Math.random() < 0.5 ? 'L' : 'R';
                s.ear[side].v += (side === 'L' ? -1 : 1) * rnd(1.4, 2.4);
            }
            const bodyVel = (s.bodyRot - s.bodyRotPrev) / Math.max(dt, 1e-3);
            ['L', 'R'].forEach((side) => {
                const e = s.ear[side], out = side === 'L' ? -1 : 1;
                let pose = st === 'user' ? out * 0.07 : st === 'thinking' ? (side === 'L' ? -0.05 : 0.16) : out * 0.015;
                pose += out * s.pet * 0.05;                                   // caresse : oreilles un peu en arrière, détendues
                const wiggle = s.pet * 0.05 * Math.sin(s.t * 17 + (side === 'L' ? 0 : 1.7));
                const acc = -150 * (e.a - pose) - 11 * e.v - bodyVel * 1.1 + wiggle * 40 + (st === 'speaking' ? Math.sin(s.t * 9 + (side === 'L' ? 0 : 2)) * s.mOpen * 4 : 0);
                e.v += acc * dt; e.a += e.v * dt;
                e.a = clamp(e.a, -0.11, 0.11);   // amplitude limitée : l'oreille reste attachée à la tête
            });
            // Cœurs qui s'envolent
            for (const hh of s.hearts) { hh.age += dt; hh.y -= hh.vy * dt; hh.x += Math.cos(hh.age * 3.2 + hh.ph) * hh.wob * dt; }
            s.hearts = s.hearts.filter(hh => hh.age < hh.life);
            // Clignements
            s.blinkT -= dt;
            if (s.blinkT <= 0 && s.blinkPhase < 0) s.blinkPhase = 0;
            if (s.blinkPhase >= 0) {
                s.blinkPhase += dt / 0.17;
                s.blink = s.blinkPhase < 0.5 ? s.blinkPhase * 2 : Math.max(0, 2 - s.blinkPhase * 2);
                if (s.blinkPhase >= 1) { s.blinkPhase = -1; s.blink = 0; s.blinkT = Math.random() < 0.2 ? 0.13 : rnd(2.2, 5.2); }
            }
        }

        function draw() {
            const w = canvas.width, h = canvas.height;
            ctx.globalCompositeOperation = 'source-over';
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, w, h);
            const breath = Math.sin(s.t * 1.8) * 0.004;
            if (!ready) return;

            const reserve = Math.min(RESERVE_CSS * dpr, h * 0.34);
            const rh = h - reserve;
            const bw = BOX[2] - BOX[0], bh = BOX[3] - BOX[1];
            const sc = Math.min(rh * 0.92 / bh, w * 0.86 / bw);
            const cx = (BOX[0] + BOX[2]) / 2, cy = (BOX[1] + BOX[3]) / 2;
            const px = cx, py = BOX[3] - 10;
            const ox = w / 2, oy = rh / 2 + rh * 0.03;
            view = { cx0: ox, cy0: oy, sc, cx, cy };

            // Halo derrière lui, qui réagit à la voix et aux caresses
            const gl = ctx.createRadialGradient(w / 2, rh / 2, 10, w / 2, rh / 2, Math.min(w, rh) * 0.62);
            gl.addColorStop(0, `rgba(217,117,48,${0.16 + s.listenLevel * 0.2 + s.mOpen * 0.12 + s.pet * 0.14})`);
            gl.addColorStop(1, 'rgba(217,117,48,0)');
            ctx.fillStyle = gl; ctx.fillRect(0, 0, w, h);

            // Le lapin pivote autour de ses pieds et se déplace un peu d'un pied sur l'autre
            const shift = Math.sin(s.swayPhase + 1.2) * (6 + 9 * s.swayEnergy);
            const bob = -Math.abs(Math.sin(s.swayPhase)) * (2 + 4 * s.swayEnergy) - s.bounce * 6;
            ctx.save();
            ctx.translate(ox + shift * sc, oy + bob * sc);
            ctx.scale(sc, sc);
            ctx.translate(-cx, -cy);
            ctx.translate(px, py);
            ctx.rotate(s.tilt + s.bodyRot);
            ctx.scale(1 + breath, 1 + breath * 1.5 - s.nod * 0.012 + s.bounce * 0.016);
            ctx.translate(-px, -py);

            // Corps, puis oreilles (chacune pivote à sa base)
            ctx.drawImage(img.body, 0, 0, IW, IH);
            ['L', 'R'].forEach((side) => {
                const [ex, ey] = PIVOT[side];
                ctx.save();
                ctx.translate(ex, ey); ctx.rotate(s.ear[side].a); ctx.translate(-ex, -ey);
                ctx.drawImage(img[side === 'L' ? 'earL' : 'earR'], 0, 0, IW, IH);
                ctx.restore();
            });

            // Paupières : le pelage descend sur chaque bille ; yeux plissés sous les caresses
            const lid = Math.max(s.blink, s.squint);
            if (lid > 0.02) {
                EYES.forEach(([x, y], i) => {
                    const rx = EYE_R * 1.18, ry = EYE_R * 1.28;
                    ctx.save();
                    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.clip();
                    const cover = clamp(lid * 1.1, 0, 1) * ry * 2;
                    ctx.fillStyle = furEyes[i];
                    ctx.fillRect(x - rx, y - ry - 1, rx * 2, cover + 1);
                    if (cover > 2) ctx.drawImage(img.body, x - rx, y + ry + 10, rx * 2, cover, x - rx, y - ry, rx * 2, cover);
                    ctx.restore();
                    if (lid > 0.5) {
                        ctx.strokeStyle = 'rgba(95,80,68,0.75)'; ctx.lineWidth = 1.2 * K; ctx.lineCap = 'round';
                        const ly = y - ry + cover, up = s.squint > 0.3 ? 1.6 : -0.7;   // yeux souriants quand on le caresse
                        ctx.beginPath(); ctx.moveTo(x - EYE_R * 0.95, ly - 1); ctx.quadraticCurveTo(x, ly - up * K, x + EYE_R * 0.95, ly - 1); ctx.stroke();
                    }
                });
            }

            // Mâchoire : le bas du museau descend et s'étire avec la voix
            const open = s.mOpen;
            if (jawPatch && open > 0.08) {
                ctx.save();
                ctx.translate(JAW.x + JAW.w / 2, JAW.y + JAW.h * 0.3);
                ctx.scale(1 + open * 0.015, 1 + open * 0.07);
                ctx.translate(0, open * 9);
                ctx.globalAlpha = clamp(open * 3, 0, 1);
                ctx.drawImage(jawPatch, -JAW.w / 2, -JAW.h * 0.3);
                ctx.restore();
            }
            // Ombre de la bouche : s'ouvre et s'élargit avec la voix, suit la mâchoire
            if (open > 0.08) {
                const [mx, my0] = MOUTH;
                const my = my0 + open * 8;
                const rx = (2.2 + s.mWide * 1.9 + open * 0.8) * K, ry = (0.8 + open * 4.6) * K;
                const cyy = my + ry * 0.35;
                ctx.save();
                ctx.translate(mx, cyy); ctx.scale(rx * 1.7, ry * 1.7);
                const outer = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
                outer.addColorStop(0, `rgba(78,36,38,${0.38 + open * 0.42})`);
                outer.addColorStop(0.55, `rgba(110,64,60,${0.24 + open * 0.24})`);
                outer.addColorStop(1, 'rgba(120,80,70,0)');
                ctx.fillStyle = outer; ctx.fillRect(-1.1, -1.1, 2.2, 2.2);
                if (open > 0.3) {
                    ctx.scale(0.55, 0.55);
                    const inner = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
                    inner.addColorStop(0, `rgba(48,18,22,${0.5 + open * 0.4})`);
                    inner.addColorStop(0.7, 'rgba(60,26,28,0.35)');
                    inner.addColorStop(1, 'rgba(60,26,28,0)');
                    ctx.fillStyle = inner; ctx.fillRect(-1.1, -1.1, 2.2, 2.2);
                }
                ctx.restore();
            }
            ctx.restore();
            // Cœurs : légèrement penchés, grossissent un peu en montant, s'effacent à la fin
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            for (const hh of s.hearts) {
                const u = hh.age / hh.life;
                const al = clamp(Math.min(hh.age / 0.15, 1) * (1 - u * u), 0, 1);
                const z = hh.size * (0.7 + 0.5 * Math.min(u * 2, 1));
                ctx.save();
                ctx.translate(hh.x, hh.y); ctx.rotate(hh.rot + Math.sin(hh.age * 3 + hh.ph) * 0.2);
                ctx.globalAlpha = al; ctx.fillStyle = hh.col; ctx.shadowColor = 'rgba(255,90,140,0.6)'; ctx.shadowBlur = z * 0.6;
                ctx.beginPath();
                ctx.moveTo(0, z * 0.38);
                ctx.bezierCurveTo(z * 0.95, -z * 0.15, z * 0.55, -z * 0.95, 0, -z * 0.42);
                ctx.bezierCurveTo(-z * 0.55, -z * 0.95, -z * 0.95, -z * 0.15, 0, z * 0.38);
                ctx.fill();
                ctx.restore();
            }
        }

        function frame(now) {
            if (!running) return;
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            update(dt);
            draw();
            requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);

        return {
            setState(st) { s.state = st; },
            setMouth(open, wide) { s.mouthOpen = clamp(open * 1.2, 0, 1); s.mouthWide = clamp(wide, 0, 1); },
            setListenLevel(v) { s.listenLevel = lerp(s.listenLevel, clamp(v, 0, 1), 0.25); },
            nod(strength) { s.nodV = -(strength || 1) * 6; s.pulse = 1; },
            onPet(cb) { petCb = cb; },
            _pet(side) { s.pet = 1; s.ear[side].v += 3; const ix = side === 'L' ? 230 : 730, iy = 170; for (let i = 0; i < 6; i++) { s.heartT = 0; spawnHearts(view.cx0 + (ix - view.cx) * view.sc, view.cy0 + (iy - view.cy) * view.sc, 1); s.hearts[s.hearts.length - 1].age = i * 0.2; } },   // essais : simule une caresse
            _state: s,
            stop() { running = false; window.removeEventListener('resize', resize); if (ro) ro.disconnect(); }
        };
    }
    window.AvatarRabbit = Rabbit;
})();
