// rabbit.js — tête « photo » animée : le lapin en peluche bouge comme une marionnette (balancement, respiration,
// hochements, rebond avec la voix), cligne des yeux et ouvre une petite bouche calée sur la voix.
// Même interface que face.js : setState, setMouth, setListenLevel, nod, stop.
(function () {
    'use strict';
    const IMG = 'lapin.png';   // photo détourée (fond retiré)
    const K = 5.8;                                  // échelle des détails dessinés (paupières, bouche) par rapport à la première photo
    const IW = 1000, IH = 1541;                     // taille de l'image
    const BOX = [92, 5, 859, 1534];                 // cadre du lapin dans l'image
    const EYES = [[353.5, 601.5], [617.5, 602.5]];  // billes noires
    const EYE_R = 37;
    const MOUTH = [495, 748];                       // sous le museau
    const RESERVE_CSS = 210;                        // hauteur gardée en bas pour le texte et les boutons                       // sous le museau
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const lerp = (a, b, t) => a + (b - a) * t;
    const rnd = (a, b) => a + Math.random() * (b - a);

    function Rabbit(canvas) {
        const ctx = canvas.getContext('2d');
        const img = new Image();
        let ready = false, furEyes = ['rgb(214,204,190)', 'rgb(214,204,190)'];
        img.onload = () => {
            ready = true;
            try {   // couleur du pelage juste au-dessus de chaque œil, pour les paupières
                const c = document.createElement('canvas'); c.width = c.height = 1;
                const g = c.getContext('2d');
                furEyes = EYES.map(([x, y]) => {
                    g.clearRect(0, 0, 1, 1);
                    g.drawImage(img, x - 14, y - EYE_R * 1.9, 28, 20, 0, 0, 1, 1);
                    const d = g.getImageData(0, 0, 1, 1).data;
                    return `rgb(${d[0]},${d[1]},${d[2]})`;
                });
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
        // Le cadre du canvas change aussi sans que la fenêtre bouge (boutons, journal, mode lapin) : sinon l'image est écrasée
        let ro = null;
        if (window.ResizeObserver) { ro = new ResizeObserver(resize); ro.observe(canvas); }
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

            // Paupières : le pelage descend sur chaque bille depuis le haut, avec un trait fin quand l'œil est fermé
            if (s.blink > 0.02) {
                EYES.forEach(([x, y], i) => {
                    const rx = EYE_R * 1.18, ry = EYE_R * 1.28;
                    ctx.save();
                    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.clip();
                    const cover = clamp(s.blink * 1.1, 0, 1) * ry * 2;
                    ctx.fillStyle = furEyes[i];
                    ctx.fillRect(x - rx, y - ry - 1, rx * 2, cover + 1);
                    // Texture : le poil juste sous l'œil (même teinte que la joue), recopié sur la paupière
                    if (cover > 2) ctx.drawImage(img, x - rx, y + ry + 10, rx * 2, cover, x - rx, y - ry, rx * 2, cover);
                    ctx.restore();
                    if (s.blink > 0.55) {
                        ctx.strokeStyle = 'rgba(95,80,68,0.75)'; ctx.lineWidth = 1.2 * K; ctx.lineCap = 'round';
                        const ly = y - ry + cover;
                        ctx.beginPath(); ctx.moveTo(x - EYE_R * 0.95, ly - 1); ctx.quadraticCurveTo(x, ly + 0.7 * K * 1.5, x + EYE_R * 0.95, ly - 1); ctx.stroke();
                    }
                });
            }
            // Bouche : pas de bouche sur la peluche, donc une ombre douce dans le poil (bords fondus), qui s'ouvre avec la voix
            if (s.mOpen > 0.04) {
                const [mx, my] = MOUTH;
                const rx = (2.2 + s.mWide * 1.8 + s.mOpen * 0.5) * K, ry = (0.8 + s.mOpen * 4.2) * K;
                const cy = my + ry * 0.35;
                ctx.save();
                ctx.translate(mx, cy); ctx.scale(rx * 1.7, ry * 1.7);
                const outer = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
                outer.addColorStop(0, `rgba(78,36,38,${0.35 + s.mOpen * 0.4})`);
                outer.addColorStop(0.55, `rgba(110,64,60,${0.22 + s.mOpen * 0.22})`);
                outer.addColorStop(1, 'rgba(120,80,70,0)');
                ctx.fillStyle = outer; ctx.fillRect(-1.1, -1.1, 2.2, 2.2);
                if (s.mOpen > 0.3) {
                    ctx.scale(0.55, 0.55);
                    const inner = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
                    inner.addColorStop(0, `rgba(48,18,22,${0.5 + s.mOpen * 0.4})`);
                    inner.addColorStop(0.7, 'rgba(60,26,28,0.35)');
                    inner.addColorStop(1, 'rgba(60,26,28,0)');
                    ctx.fillStyle = inner; ctx.fillRect(-1.1, -1.1, 2.2, 2.2);
                }
                ctx.restore();
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
            stop() { running = false; window.removeEventListener('resize', resize); if (ro) ro.disconnect(); }
        };
    }
    window.AvatarRabbit = Rabbit;
})();
