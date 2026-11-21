// rabbit.js — tête « photo » animée : le lapin en peluche bouge comme une marionnette (balancement, respiration,
// hochements, rebond avec la voix), cligne des yeux et ouvre une petite bouche calée sur la voix.
// Même interface que face.js : setState, setMouth, setListenLevel, nod, stop.
(function () {
    'use strict';
    const IMG = 'lapin.png';   // photo détourée (fond retiré)
    const K = 3.3;                                  // échelle des détails dessinés (billes, bouche) par rapport à la première photo
    const IW = 944, IH = 1116;                      // taille de l'image
    const BOX = [268, 129, 697, 986];               // cadre du lapin dans l'image
    const EYES = [[412.7, 463.3], [562.3, 463.3]];  // billes noires
    const EYE_R = 21;
    const MOUTH = [488, 540];                       // sous le museau
    const RESERVE_CSS = 210;                        // hauteur gardée en bas pour le texte et les boutons                       // sous le museau
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const lerp = (a, b, t) => a + (b - a) * t;
    const rnd = (a, b) => a + Math.random() * (b - a);

    function Rabbit(canvas) {
        const ctx = canvas.getContext('2d');
        const img = new Image();
        let ready = false, fur = 'rgb(216,205,188)';
        img.onload = () => {
            ready = true;
            try {   // couleur du pelage entre les yeux, pour les paupières
                const c = document.createElement('canvas'); c.width = c.height = 1;
                c.getContext('2d').drawImage(img, 486, 440, 12, 12, 0, 0, 1, 1);
                const d = c.getContext('2d').getImageData(0, 0, 1, 1).data;
                fur = `rgb(${d[0]},${d[1]},${d[2]})`;
            } catch (e) { /* pelage par défaut */ }
        };
        img.src = IMG;
        const s = { state: 'idle', mouthOpen: 0, mouthWide: 0.5, mOpen: 0, mWide: 0.5, blink: 0, blinkT: rnd(1.5, 4), blinkPhase: -1,
            tilt: 0, ttilt: 0, nod: 0, nodV: 0, bounce: 0, listenLevel: 0, sway: 0, t: 0 };
        let dpr = 1, last = performance.now(), running = true;
        function resize() {
            const r = canvas.getBoundingClientRect();
            dpr = Math.min(window.devicePixelRatio || 1, 3);
            canvas.width = Math.max(1, Math.round(r.width * dpr));
            canvas.height = Math.max(1, Math.round(r.height * dpr));
        }
        window.addEventListener('resize', resize);
        resize();

        function update(dt) {
            s.t += dt;
            const st = s.state;
            s.ttilt = st === 'thinking' ? -0.05 : st === 'user' ? 0.035 + s.listenLevel * 0.03 : 0;
            const k = (r) => 1 - Math.exp(-r * dt);
            s.mOpen = lerp(s.mOpen, s.mouthOpen, k(28));
            s.mWide = lerp(s.mWide, s.mouthWide, k(20));
            s.tilt = lerp(s.tilt, s.ttilt, k(4));
            s.bounce = lerp(s.bounce, st === 'speaking' ? s.mOpen : 0, k(18));
            s.nodV += (-s.nod * 80 - s.nodV * 10) * dt;
            s.nod += s.nodV * dt;
            s.blinkT -= dt;
            if (s.blinkT <= 0 && s.blinkPhase < 0) s.blinkPhase = 0;
            if (s.blinkPhase >= 0) {
                s.blinkPhase += dt / 0.17;
                s.blink = s.blinkPhase < 0.5 ? s.blinkPhase * 2 : Math.max(0, 2 - s.blinkPhase * 2);
                if (s.blinkPhase >= 1) { s.blinkPhase = -1; s.blink = 0; s.blinkT = Math.random() < 0.2 ? 0.13 : rnd(2.4, 5.5); }
            }
        }

        function draw() {
            const w = canvas.width, h = canvas.height;
            ctx.globalCompositeOperation = 'source-over';
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, w, h);
            const breath = Math.sin(s.t * 1.8) * 0.004;
            if (!ready) return;

            // Le lapin entier tient au-dessus des boutons (zone réservée en bas) ; il pivote autour de ses pieds
            const reserve = Math.min(RESERVE_CSS * dpr, h * 0.34);
            const rh = h - reserve;
            const bw = BOX[2] - BOX[0], bh = BOX[3] - BOX[1];
            const sc = Math.min(rh * 0.92 / bh, w * 0.9 / bw);
            const cx = (BOX[0] + BOX[2]) / 2, cy = (BOX[1] + BOX[3]) / 2;
            const px = cx, py = BOX[3] - 10;
            // Halo derrière lui, qui réagit à la voix
            const gl = ctx.createRadialGradient(w / 2, rh / 2, 10, w / 2, rh / 2, Math.min(w, rh) * 0.62);
            gl.addColorStop(0, `rgba(217,117,48,${0.16 + s.listenLevel * 0.2 + s.mOpen * 0.12})`);
            gl.addColorStop(1, 'rgba(217,117,48,0)');
            ctx.fillStyle = gl; ctx.fillRect(0, 0, w, h);
            ctx.save();
            ctx.translate(w / 2, rh / 2 + rh * 0.03);
            ctx.scale(sc, sc);
            ctx.translate(-cx, -cy);
            ctx.translate(px, py);
            ctx.rotate(s.tilt + Math.sin(s.t * 0.7) * 0.012 + Math.sin(s.t * 2.9) * 0.0035 * (s.state === 'speaking' ? 1 : 0.3));
            ctx.scale(1 + breath, 1 + breath * 1.5 - s.nod * 0.012 + s.bounce * 0.016);
            ctx.translate(-px, -py);
            ctx.drawImage(img, 0, 0, IW, IH);

            // Paupières : le pelage recouvre les billes, avec un trait fin
            if (s.blink > 0.02) {
                EYES.forEach(([x, y]) => {
                    ctx.fillStyle = fur;
                    ctx.beginPath(); ctx.ellipse(x, y, EYE_R + 1.6 * K, (EYE_R + 1.6 * K) * clamp(s.blink * 1.15, 0, 1), 0, 0, Math.PI * 2); ctx.fill();
                    if (s.blink > 0.6) {
                        ctx.strokeStyle = 'rgba(90,75,62,0.7)'; ctx.lineWidth = 1.1 * K; ctx.lineCap = 'round';
                        ctx.beginPath(); ctx.moveTo(x - EYE_R, y); ctx.quadraticCurveTo(x, y + 2.4 * K, x + EYE_R, y); ctx.stroke();
                    }
                });
            }
            // Bouche : une petite ouverture sombre, qui s'élargit avec la voix
            if (s.mOpen > 0.05) {
                const [mx, my] = MOUTH;
                const rx = (2.4 + s.mWide * 2.4 - s.mOpen * 0.5) * K, ry = (0.8 + s.mOpen * 4.6) * K;
                ctx.fillStyle = '#4a1d22';
                ctx.beginPath(); ctx.ellipse(mx, my + ry * 0.4, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
                if (ry > 3.5) {
                    ctx.fillStyle = '#b4565e';
                    ctx.beginPath(); ctx.ellipse(mx, my + ry * 0.85, rx * 0.65, ry * 0.4, 0, 0, Math.PI * 2); ctx.fill();
                }
                ctx.strokeStyle = 'rgba(120,70,70,0.55)'; ctx.lineWidth = 0.9 * K;
                ctx.beginPath(); ctx.ellipse(mx, my + ry * 0.4, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
            }
            ctx.restore();
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
            setMouth(open, wide) { s.mouthOpen = clamp(open, 0, 1); s.mouthWide = clamp(wide, 0, 1); },
            setListenLevel(v) { s.listenLevel = lerp(s.listenLevel, clamp(v, 0, 1), 0.25); },
            nod(strength) { s.nodV = -(strength || 1) * 6; },
            stop() { running = false; window.removeEventListener('resize', resize); }
        };
    }
    window.AvatarRabbit = Rabbit;
})();
