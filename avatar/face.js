// face.js — visage 2D animé dessiné sur un canvas : bouche calée sur la voix, clignements, regard,
// hochements, sourcils et expression selon l'état (écoute, réflexion, parole).
(function () {
    'use strict';
    const W = 400, H = 520;                 // repère logique du dessin
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const lerp = (a, b, t) => a + (b - a) * t;
    const rnd = (a, b) => a + Math.random() * (b - a);

    function Face(canvas) {
        const ctx = canvas.getContext('2d');
        const s = {
            state: 'idle',
            mouthOpen: 0, mouthWide: 0.5,           // cibles posées par la voix
            mOpen: 0, mWide: 0.5,                   // valeurs lissées
            blink: 0, blinkT: rnd(1.5, 4), blinkPhase: -1,
            gx: 0, gy: 0, tgx: 0, tgy: 0, gazeT: 0,
            brow: 0, tbrow: 0, tilt: 0, ttilt: 0,
            smile: 0.25, tsmile: 0.25,
            nod: 0, nodV: 0,                        // hochement (ressort)
            listenLevel: 0,
            t: 0
        };
        let dpr = 1, last = performance.now(), running = true;

        function resize() {
            const r = canvas.getBoundingClientRect();
            dpr = Math.min(window.devicePixelRatio || 1, 3);
            canvas.width = Math.max(1, Math.round(r.width * dpr));
            canvas.height = Math.max(1, Math.round(r.height * dpr));
        }
        window.addEventListener('resize', resize);
        resize();

        // --- Comportement ---
        function pickGaze(dt) {
            s.gazeT -= dt;
            if (s.gazeT > 0) return;
            if (s.state === 'thinking') { s.tgx = rnd(-0.55, -0.2); s.tgy = rnd(-0.7, -0.35); s.gazeT = rnd(0.8, 1.6); }
            else if (s.state === 'speaking') {
                if (Math.random() < 0.28) { s.tgx = rnd(-0.45, 0.45); s.tgy = rnd(-0.35, 0.1); s.gazeT = rnd(0.5, 1.1); }
                else { s.tgx = rnd(-0.06, 0.06); s.tgy = rnd(-0.05, 0.05); s.gazeT = rnd(1.5, 3.5); }
            } else { s.tgx = rnd(-0.1, 0.1); s.tgy = rnd(-0.08, 0.08); s.gazeT = rnd(0.9, 2.4); }
        }
        function update(dt) {
            s.t += dt;
            // Cible d'expression selon l'état
            const st = s.state;
            s.tbrow = st === 'thinking' ? 0.55 : st === 'user' ? 0.28 + s.listenLevel * 0.3 : st === 'speaking' ? 0.05 + s.mOpen * 0.35 : 0.1;
            s.ttilt = st === 'thinking' ? -0.045 : st === 'user' ? 0.03 : 0;
            s.tsmile = st === 'speaking' ? 0.3 : st === 'user' ? 0.32 : 0.22;
            pickGaze(dt);
            // Lissage
            const k = (r) => 1 - Math.exp(-r * dt);
            s.mOpen = lerp(s.mOpen, s.mouthOpen, k(st === 'speaking' || s.mouthOpen > 0.05 ? 28 : 14));
            s.mWide = lerp(s.mWide, s.mouthWide, k(20));
            s.gx = lerp(s.gx, s.tgx, k(14)); s.gy = lerp(s.gy, s.tgy, k(14));
            s.brow = lerp(s.brow, s.tbrow, k(8));
            s.tilt = lerp(s.tilt, s.ttilt, k(4));
            s.smile = lerp(s.smile, s.tsmile, k(5));
            // Hochement : ressort amorti
            s.nodV += (-s.nod * 90 - s.nodV * 11) * dt;
            s.nod += s.nodV * dt;
            // Clignements (parfois doubles)
            s.blinkT -= dt;
            if (s.blinkT <= 0 && s.blinkPhase < 0) { s.blinkPhase = 0; }
            if (s.blinkPhase >= 0) {
                s.blinkPhase += dt / 0.16;
                s.blink = s.blinkPhase < 0.5 ? s.blinkPhase * 2 : Math.max(0, 2 - s.blinkPhase * 2);
                if (s.blinkPhase >= 1) { s.blinkPhase = -1; s.blink = 0; s.blinkT = Math.random() < 0.18 ? 0.12 : rnd(2.2, 5.5); }
            }
        }

        // --- Dessin ---
        function draw() {
            const w = canvas.width, h = canvas.height;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, w, h);
            const sc = Math.min(w / W, h / H);
            const breath = Math.sin(s.t * 1.7) * 2;
            ctx.setTransform(sc, 0, 0, sc, (w - W * sc) / 2, (h - H * sc) / 2);

            // Halo d'ambiance qui réagit à la voix de l'utilisateur
            const glow = ctx.createRadialGradient(200, 230, 40, 200, 230, 195);
            glow.addColorStop(0, `rgba(217,117,48,${0.10 + s.listenLevel * 0.18 + s.mOpen * 0.1})`);
            glow.addColorStop(1, 'rgba(217,117,48,0)');
            ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

            // Corps (épaules, cou) : bouge peu
            ctx.save();
            ctx.translate(0, breath * 0.6);
            ctx.fillStyle = '#1b2233';
            ctx.beginPath(); ctx.moveTo(30, H); ctx.bezierCurveTo(40, 420, 120, 385, 200, 385);
            ctx.bezierCurveTo(280, 385, 360, 420, 370, H); ctx.closePath(); ctx.fill();
            const neck = ctx.createLinearGradient(0, 330, 0, 400);
            neck.addColorStop(0, '#d9a98a'); neck.addColorStop(1, '#c58f70');
            ctx.fillStyle = neck;
            ctx.beginPath(); ctx.moveTo(165, 320); ctx.lineTo(165, 392); ctx.quadraticCurveTo(200, 412, 235, 392); ctx.lineTo(235, 320); ctx.closePath(); ctx.fill();
            ctx.restore();

            // Tête : hochement, inclinaison, respiration
            ctx.save();
            ctx.translate(200, 330);
            ctx.rotate(s.tilt + Math.sin(s.t * 0.6) * 0.008);
            ctx.translate(-200, -330 + s.nod * 10 + breath);

            // Cheveux derrière
            ctx.fillStyle = '#2a1c16';
            ctx.beginPath(); ctx.ellipse(200, 205, 120, 140, 0, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.moveTo(78, 215); ctx.quadraticCurveTo(62, 340, 92, 372); ctx.lineTo(130, 330); ctx.closePath(); ctx.fill();
            ctx.beginPath(); ctx.moveTo(322, 215); ctx.quadraticCurveTo(338, 340, 308, 372); ctx.lineTo(270, 330); ctx.closePath(); ctx.fill();

            // Oreilles
            ctx.fillStyle = '#d3a083';
            ctx.beginPath(); ctx.ellipse(96, 232, 12, 22, 0, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.ellipse(304, 232, 12, 22, 0, 0, Math.PI * 2); ctx.fill();

            // Visage
            const skin = ctx.createLinearGradient(0, 90, 0, 350);
            skin.addColorStop(0, '#f1c7a8'); skin.addColorStop(1, '#e2ab88');
            ctx.fillStyle = skin;
            ctx.beginPath();
            ctx.moveTo(200, 82);
            ctx.bezierCurveTo(290, 82, 306, 170, 304, 230);
            ctx.bezierCurveTo(302, 300, 262, 352, 200, 352);
            ctx.bezierCurveTo(138, 352, 98, 300, 96, 230);
            ctx.bezierCurveTo(94, 170, 110, 82, 200, 82);
            ctx.closePath(); ctx.fill();

            // Joues
            const bl = ctx.createRadialGradient(0, 0, 2, 0, 0, 34);
            bl.addColorStop(0, `rgba(226,120,110,${0.28 + s.smile * 0.2})`); bl.addColorStop(1, 'rgba(226,120,110,0)');
            ctx.fillStyle = bl;
            [[140, 262], [260, 262]].forEach(([x, y]) => { ctx.save(); ctx.translate(x, y); ctx.scale(1.3, 0.8); ctx.fillRect(-40, -40, 80, 80); ctx.restore(); });

            // Frange
            ctx.fillStyle = '#2f2019';
            ctx.beginPath();
            ctx.moveTo(86, 214);
            ctx.bezierCurveTo(84, 110, 150, 62, 214, 70);
            ctx.bezierCurveTo(280, 78, 318, 130, 314, 214);
            ctx.bezierCurveTo(300, 160, 270, 128, 232, 122);
            ctx.bezierCurveTo(205, 150, 150, 156, 112, 176);
            ctx.bezierCurveTo(100, 184, 92, 198, 86, 214);
            ctx.closePath(); ctx.fill();

            drawEyes();
            drawBrows();

            // Nez
            ctx.strokeStyle = 'rgba(150,90,60,0.55)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
            ctx.beginPath(); ctx.moveTo(196, 232); ctx.quadraticCurveTo(190, 262, 200, 268); ctx.quadraticCurveTo(210, 270, 214, 264); ctx.stroke();

            drawMouth();
            ctx.restore();
        }

        function drawEyes() {
            const open = clamp(1 - s.blink, 0, 1) * (1 + s.brow * 0.12);
            [[158, 206, -1], [242, 206, 1]].forEach(([cx, cy, side]) => {
                const rx = 22, ry = 14 * clamp(open, 0.04, 1.15);
                // Orbite
                ctx.fillStyle = 'rgba(180,110,90,0.25)';
                ctx.beginPath(); ctx.ellipse(cx, cy + 2, rx + 5, ry + 6, 0, 0, Math.PI * 2); ctx.fill();
                ctx.save();
                ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.clip();
                ctx.fillStyle = '#fbf8f4'; ctx.fillRect(cx - rx, cy - 20, rx * 2, 40);
                const ix = cx + s.gx * 11, iy = cy + s.gy * 7;
                const ir = ctx.createRadialGradient(ix, iy, 1, ix, iy, 11);
                ir.addColorStop(0, '#6b8f5e'); ir.addColorStop(0.6, '#3d5c3a'); ir.addColorStop(1, '#22331f');
                ctx.fillStyle = ir; ctx.beginPath(); ctx.arc(ix, iy, 10.5, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = '#0b0d0a'; ctx.beginPath(); ctx.arc(ix, iy, 4.6, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.beginPath(); ctx.arc(ix - 3.5, iy - 3.5, 2.4, 0, Math.PI * 2); ctx.fill();
                ctx.restore();
                // Paupière supérieure et cils
                ctx.strokeStyle = '#2a1c16'; ctx.lineWidth = 3.2; ctx.lineCap = 'round';
                ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, Math.PI * 1.04, Math.PI * 1.96); ctx.stroke();
                ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(cx + side * (rx - 1), cy - 2); ctx.lineTo(cx + side * (rx + 6), cy - 6); ctx.stroke();
                // Paupière inférieure discrète
                ctx.strokeStyle = 'rgba(150,90,70,0.35)'; ctx.lineWidth = 1.6;
                ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, Math.PI * 0.1, Math.PI * 0.9); ctx.stroke();
            });
        }

        function drawBrows() {
            ctx.strokeStyle = '#2a1c16'; ctx.lineWidth = 6; ctx.lineCap = 'round';
            const raise = s.brow * 9;
            // Réflexion : un sourcil plus haut
            const asym = s.state === 'thinking' ? 4 : 0;
            ctx.beginPath(); ctx.moveTo(130, 178 - raise * 0.6); ctx.quadraticCurveTo(156, 166 - raise - asym, 184, 176 - raise * 0.8); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(216, 176 - raise * 0.8); ctx.quadraticCurveTo(244, 166 - raise, 270, 178 - raise * 0.6); ctx.stroke();
        }

        function drawMouth() {
            const cx = 200, cy = 292;
            const open = clamp(s.mOpen, 0, 1);
            // wide 0 = arrondi (« ou »), 1 = étiré (« i »)
            const half = 24 + (s.mWide - 0.5) * 18 - open * 4;
            const corner = (s.smile - 0.2) * 14;                 // coins relevés
            const hOpen = open * 30;
            const lx = cx - half, rx = cx + half, cyc = cy - corner * 0.4;
            ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            if (hOpen < 1.5) {
                // Bouche fermée : trait des lèvres avec léger sourire
                ctx.strokeStyle = '#a64a4a'; ctx.lineWidth = 5;
                ctx.beginPath(); ctx.moveTo(lx, cyc - corner); ctx.quadraticCurveTo(cx, cyc + 3 + corner * 0.5, rx, cyc - corner); ctx.stroke();
                ctx.fillStyle = 'rgba(200,100,100,0.55)';
                ctx.beginPath(); ctx.moveTo(lx + 6, cyc - corner + 2); ctx.quadraticCurveTo(cx, cyc + 13 + corner * 0.5, rx - 6, cyc - corner + 2); ctx.quadraticCurveTo(cx, cyc + 6 + corner * 0.5, lx + 6, cyc - corner + 2); ctx.fill();
                return;
            }
            const top = cyc - corner - hOpen * 0.28, bot = cyc - corner + hOpen * 0.95;
            // Intérieur
            ctx.fillStyle = '#4a1418';
            ctx.beginPath(); ctx.moveTo(lx, cyc - corner);
            ctx.quadraticCurveTo(cx, top - 2, rx, cyc - corner);
            ctx.quadraticCurveTo(cx, bot + hOpen * 0.35, lx, cyc - corner); ctx.closePath(); ctx.fill();
            // Dents du haut et langue
            ctx.save();
            ctx.beginPath(); ctx.moveTo(lx, cyc - corner);
            ctx.quadraticCurveTo(cx, top - 2, rx, cyc - corner);
            ctx.quadraticCurveTo(cx, bot + hOpen * 0.35, lx, cyc - corner); ctx.closePath(); ctx.clip();
            ctx.fillStyle = '#f4efe8'; ctx.fillRect(lx, top - 4, rx - lx, Math.min(9, hOpen * 0.4) + 4);
            ctx.fillStyle = '#c4585f'; ctx.beginPath(); ctx.ellipse(cx, bot + hOpen * 0.05, half * 0.55, hOpen * 0.4, 0, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
            // Lèvres
            ctx.strokeStyle = '#a64a4a'; ctx.lineWidth = 5;
            ctx.beginPath(); ctx.moveTo(lx, cyc - corner); ctx.quadraticCurveTo(cx, top - 3, rx, cyc - corner); ctx.stroke();
            ctx.strokeStyle = '#b85a5a'; ctx.lineWidth = 6;
            ctx.beginPath(); ctx.moveTo(lx, cyc - corner); ctx.quadraticCurveTo(cx, bot + hOpen * 0.38, rx, cyc - corner); ctx.stroke();
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
            setState(st) { if (s.state !== st) { s.state = st; s.gazeT = 0; } },
            setMouth(open, wide) { s.mouthOpen = clamp(open, 0, 1); s.mouthWide = clamp(wide, 0, 1); },
            setListenLevel(v) { s.listenLevel = lerp(s.listenLevel, clamp(v, 0, 1), 0.25); },
            nod(strength) { s.nodV = -(strength || 1) * 7; },
            stop() { running = false; window.removeEventListener('resize', resize); }
        };
    }
    window.AvatarFace = Face;
})();
