// enigmes.js — deux petites énigmes (maths à gauche, physique à droite) façon olympiades, en QCM.
// Bonne réponse = des carottes, comptées par un afficheur persistant (gardé sur le serveur, par compte).
(function () {
    'use strict';
    // r = carottes gagnées (1 facile, 2 moyen, 3 difficile). Toutes les réponses ont été recalculées par programme.
    const BANK = {
        m: [
            { id: 1, r: 2, q: 'Entre 1 et 100, combien d\'entiers sont divisibles par 3 ou par 5 ?', o: ['40', '47', '53', '60'], a: 1, e: '33 + 20 − 6 (multiples de 15) = 47.' },
            { id: 2, r: 2, q: 'Quel est le reste de 2¹⁰⁰ divisé par 7 ?', o: ['1', '2', '4', '6'], a: 1, e: '2³ = 8 ≡ 1 (mod 7), et 100 = 3×33 + 1, donc 2¹⁰⁰ ≡ 2.' },
            { id: 3, r: 2, q: 'Si x + 1/x = 3, que vaut x² + 1/x² ?', o: ['5', '7', '9', '11'], a: 1, e: '(x + 1/x)² = x² + 2 + 1/x², donc 9 − 2 = 7.' },
            { id: 4, r: 1, q: 'Combien de diagonales a un hexagone convexe ?', o: ['6', '9', '12', '15'], a: 1, e: 'n(n−3)/2 = 6×3/2 = 9.' },
            { id: 5, r: 3, q: 'Quelle est la somme des chiffres de 10²⁰ − 7 ?', o: ['153', '165', '174', '183'], a: 2, e: '10²⁰ − 7 = 99…93 : dix-neuf 9 et un 3, soit 171 + 3 = 174.' },
            { id: 6, r: 1, q: 'On lance deux dés équilibrés. Probabilité que la somme soit 7 ?', o: ['1/12', '1/9', '1/6', '1/5'], a: 2, e: '6 couples sur 36 donnent 7 : 6/36 = 1/6.' },
            { id: 7, r: 2, q: 'Quel est le dernier chiffre de 7²⁰²⁶ ?', o: ['1', '3', '7', '9'], a: 3, e: 'Les derniers chiffres de 7ⁿ cyclent 7, 9, 3, 1. 2026 = 4×506 + 2, donc 9.' },
            { id: 8, r: 1, q: 'Quelle est l\'aire d\'un triangle de côtés 5, 12 et 13 ?', o: ['25', '30', '32,5', '60'], a: 1, e: '5² + 12² = 13² : triangle rectangle, aire = 5×12/2 = 30.' },
            { id: 9, r: 1, q: 'De combien de façons peut-on ranger 4 personnes sur une file ?', o: ['12', '16', '24', '32'], a: 2, e: '4! = 4×3×2×1 = 24.' },
            { id: 10, r: 1, q: 'Que vaut 1 + 3 + 5 + … + 99 (les 50 premiers impairs) ?', o: ['2450', '2500', '2550', '5000'], a: 1, e: 'La somme des n premiers impairs vaut n² : 50² = 2500.' },
            { id: 11, r: 2, q: 'Si a + b = 10 et ab = 21, que vaut a² + b² ?', o: ['49', '52', '58', '79'], a: 2, e: 'a² + b² = (a + b)² − 2ab = 100 − 42 = 58.' },
            { id: 12, r: 3, q: 'Que vaut 1/(1×2) + 1/(2×3) + … + 1/(99×100) ?', o: ['1', '99/100', '100/101', '98/99'], a: 1, e: '1/(k(k+1)) = 1/k − 1/(k+1) : la somme se télescope en 1 − 1/100.' },
            { id: 13, r: 2, q: 'Par combien de zéros se termine 25! ?', o: ['4', '5', '6', '7'], a: 2, e: 'Facteurs 5 : ⌊25/5⌋ + ⌊25/25⌋ = 5 + 1 = 6.' },
            { id: 14, r: 3, q: 'Quel est le plus petit n tel que n! soit divisible par 1000 ?', o: ['10', '12', '15', '20'], a: 2, e: 'Il faut trois facteurs 5 : 5, 10, 15 donnent 3 facteurs 5 dans 15!, et 10! n\'en a que 2.' },
            { id: 15, r: 1, q: 'Un cercle est inscrit dans un carré de côté 2. Quelle est l\'aire entre le carré et le cercle ?', o: ['4 − π', '2 − π', 'π − 2', '4 − 2π'], a: 0, e: 'Carré : 4. Cercle de rayon 1 : π. Reste 4 − π.' }
        ],
        p: [
            { id: 1, r: 1, q: 'Une pierre tombe 3 s sans vitesse initiale (g = 10 m/s², sans frottements). Distance parcourue ?', o: ['30 m', '45 m', '60 m', '90 m'], a: 1, e: 'd = ½ g t² = ½ × 10 × 9 = 45 m.' },
            { id: 2, r: 2, q: 'Deux résistances de 6 Ω en parallèle, en série avec 3 Ω. Résistance totale ?', o: ['3 Ω', '6 Ω', '9 Ω', '15 Ω'], a: 1, e: 'Deux 6 Ω en parallèle font 3 Ω ; plus 3 Ω en série : 6 Ω.' },
            { id: 3, r: 1, q: 'Un objet de 2 kg reçoit une force résultante de 10 N. Son accélération ?', o: ['2 m/s²', '5 m/s²', '10 m/s²', '20 m/s²'], a: 1, e: 'a = F / m = 10 / 2 = 5 m/s².' },
            { id: 4, r: 1, q: 'On double la vitesse d\'une voiture. Son énergie cinétique est multipliée par :', o: ['2', '3', '4', '8'], a: 2, e: 'Ec = ½ m v² : proportionnelle à v², donc ×4.' },
            { id: 5, r: 2, q: 'La lumière du Soleil met 8 minutes à nous parvenir. Distance Terre–Soleil ?', o: ['1,5·10⁸ m', '1,5·10⁹ m', '1,5·10¹¹ m', '1,5·10¹³ m'], a: 2, e: 'd = c × t = 3·10⁸ × 480 ≈ 1,4·10¹¹ m, soit environ 1,5·10¹¹ m.' },
            { id: 6, r: 3, q: 'Un glaçon flotte dans un verre d\'eau et fond entièrement. Le niveau de l\'eau :', o: ['monte', 'descend', 'ne change pas', 'dépend du verre'], a: 2, e: 'Le glaçon déplace un poids d\'eau égal à son poids ; fondu, il occupe exactement ce volume.' },
            { id: 7, r: 1, q: 'Un cycliste roule à 36 km/h. Sa vitesse en m/s ?', o: ['3,6 m/s', '10 m/s', '18 m/s', '36 m/s'], a: 1, e: '36 km/h ÷ 3,6 = 10 m/s.' },
            { id: 8, r: 1, q: 'Une ampoule de 60 W reste allumée 2 h. Énergie consommée ?', o: ['0,06 kWh', '0,12 kWh', '1,2 kWh', '120 kWh'], a: 1, e: '60 W × 2 h = 120 Wh = 0,12 kWh.' },
            { id: 9, r: 2, q: 'On quadruple la longueur d\'un pendule simple. Sa période est multipliée par :', o: ['2', '4', '1/2', '√2'], a: 0, e: 'T = 2π√(L/g) : ×4 sur L donne ×√4 = ×2 sur T.' },
            { id: 10, r: 1, q: 'Sur la Lune (g ≈ 1,6 m/s²), quel est le poids d\'un objet de 10 kg ?', o: ['10 N', '16 N', '100 N', '160 N'], a: 1, e: 'P = m g = 10 × 1,6 = 16 N.' },
            { id: 11, r: 2, q: 'Deux charges identiques à la distance d se repoussent avec la force F. À la distance 2d, la force vaut :', o: ['F/2', 'F/4', '2F', '4F'], a: 1, e: 'Loi de Coulomb : F ∝ 1/d². Distance doublée : force divisée par 4.' },
            { id: 12, r: 2, q: 'Un gaz parfait passe de 300 K à 600 K à volume constant. Sa pression :', o: ['est doublée', 'ne change pas', 'est divisée par 2', 'est multipliée par 4'], a: 0, e: 'P/T = constante à volume constant : T double, P double.' },
            { id: 13, r: 1, q: 'Un son de 340 Hz se propage à 340 m/s. Sa longueur d\'onde ?', o: ['0,5 m', '1 m', '2 m', '340 m'], a: 1, e: 'λ = v / f = 340 / 340 = 1 m.' },
            { id: 14, r: 3, q: 'On lâche dans le vide, de la même hauteur, une balle de 1 kg et une de 5 kg. Elles touchent le sol :', o: ['la légère en premier', 'la lourde en premier', 'en même temps', 'cela dépend de la forme'], a: 2, e: 'Sans frottements, l\'accélération vaut g pour tous les corps, quelle que soit leur masse.' },
            { id: 15, r: 1, q: 'Une force de 20 N déplace un objet de 3 m dans sa direction. Le travail fourni ?', o: ['6,7 J', '17 J', '23 J', '60 J'], a: 3, e: 'W = F × d = 20 × 3 = 60 J.' }
        ]
    };
    const API = '../avatar-jeu';
    const $ = (id) => document.getElementById(id);
    const root = $('enigmes');
    if (!root) return;
    const state = { carottes: 0, bonnes: 0, essais: 0, serie: 0, vues: { m: [], p: [] } };
    try { Object.assign(state, JSON.parse(localStorage.getItem('avatar-jeu-cache') || '{}')); } catch (e) { /* cache absent */ }
    state.vues = state.vues || { m: [], p: [] };
    const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

    // --- Sauvegarde : serveur (par compte), copie dans le navigateur ---
    let saveT = null;
    function persist() {
        try { localStorage.setItem('avatar-jeu-cache', JSON.stringify(state)); } catch (e) { /* stockage indisponible */ }
        clearTimeout(saveT);
        saveT = setTimeout(() => {
            fetch(API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state), keepalive: true }).catch(() => {});
        }, 300);
    }
    async function load() {
        try {
            const r = await fetch(API, { credentials: 'same-origin', cache: 'no-store' });
            if (r.ok) {
                const d = await r.json();
                if (d && typeof d.carottes === 'number') {
                    // Le plus grand compteur l'emporte (copie du navigateur ou serveur) : on ne perd jamais de carottes
                    if (d.carottes >= state.carottes) { state.carottes = d.carottes; state.bonnes = d.bonnes || 0; state.essais = d.essais || 0; state.serie = d.serie || 0; state.vues = d.vues || state.vues; }
                    else persist();
                }
            }
        } catch (e) { /* hors ligne : copie locale */ }
        shown = state.carottes; paintCount(shown);
    }

    // --- Afficheur de carottes ---
    const counter = $('carottes');
    let shown = 0;
    function paintCount(n) { counter.querySelector('.n').textContent = String(n); }
    function animateTo(target) {
        const from = shown, t0 = performance.now(), dur = 700;
        counter.classList.add('bump');
        setTimeout(() => counter.classList.remove('bump'), 500);
        (function step(now) {
            const u = Math.min(1, (now - t0) / dur);
            shown = Math.round(from + (target - from) * u);
            paintCount(shown);
            if (u < 1) requestAnimationFrame(step);
        })(t0);
    }
    // Carottes qui volent de la carte vers l'afficheur, et pluie sur tout l'écran
    function flyCarrots(fromEl, n) {
        const a = fromEl.getBoundingClientRect(), b = counter.getBoundingClientRect();
        for (let i = 0; i < Math.min(n, 6); i++) {
            const c = document.createElement('span');
            c.className = 'fly'; c.textContent = '🥕';
            c.style.left = (a.left + a.width / 2 + (Math.random() - 0.5) * 40) + 'px'; c.style.top = (a.top + a.height / 2) + 'px';
            document.body.appendChild(c);
            const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
            c.animate([{ transform: 'translate(0,0) scale(1.2)', opacity: 1 }, { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 40}px) scale(1.6)`, opacity: 1, offset: 0.45 }, { transform: `translate(${dx}px, ${dy}px) scale(0.6)`, opacity: 0.2 }],
                { duration: 900 + i * 120, easing: 'ease-in-out', delay: i * 70 }).onfinish = () => c.remove();
        }
        for (let i = 0; i < 16; i++) {
            const r = document.createElement('span');
            r.className = 'rain'; r.textContent = '🥕';
            r.style.left = (Math.random() * 100) + 'vw'; r.style.fontSize = (16 + Math.random() * 22) + 'px';
            document.body.appendChild(r);
            r.animate([{ transform: 'translateY(-10vh) rotate(0deg)', opacity: 1 }, { transform: `translateY(105vh) rotate(${(Math.random() - 0.5) * 540}deg)`, opacity: 0.9 }],
                { duration: 1600 + Math.random() * 1400, delay: Math.random() * 500, easing: 'cubic-bezier(.3,.1,.6,1)' }).onfinish = () => r.remove();
        }
    }

    // --- Cartes ---
    function Card(cat, label) {
        const el = $('enigme-' + cat);
        const qEl = el.querySelector('.q'), oEl = el.querySelector('.opts'), fbEl = el.querySelector('.fb'), lvl = el.querySelector('.lvl');
        el.querySelector('.min').addEventListener('click', () => { el.classList.toggle('collapsed'); el.querySelector('.min').textContent = el.classList.contains('collapsed') ? '+' : '–'; });
        let cur = null, timer = null, locked = false;
        function next() {
            clearTimeout(timer);
            let pool = BANK[cat].filter(x => !state.vues[cat].includes(x.id));
            if (!pool.length) { state.vues[cat] = []; pool = BANK[cat]; }
            cur = pool[Math.floor(Math.random() * pool.length)];
            const order = shuffle([0, 1, 2, 3]);
            cur.order = order;
            qEl.textContent = cur.q;
            lvl.textContent = '★'.repeat(cur.r) + ' · ' + cur.r + ' 🥕';
            fbEl.textContent = ''; fbEl.className = 'fb';
            oEl.innerHTML = '';
            locked = false;
            order.forEach((k, pos) => {
                const b = document.createElement('button');
                b.type = 'button'; b.className = 'opt'; b.dataset.k = String(k);
                b.textContent = 'ABCD'[pos] + '. ' + cur.o[k];
                b.addEventListener('click', () => answer(k, b));
                oEl.appendChild(b);
            });
            requestAnimationFrame(layout);
        }
        function answer(k, btn) {
            if (locked) return;
            locked = true;
            state.essais++;
            state.vues[cat].push(cur.id);
            const ok = k === cur.a;
            [...oEl.children].forEach(b => { b.disabled = true; if (Number(b.dataset.k) === cur.a) b.classList.add('good'); });
            if (ok) {
                state.bonnes++; state.serie++;
                const bonus = state.serie > 0 && state.serie % 3 === 0 ? 1 : 0;   // un bonus toutes les 3 bonnes réponses de suite
                const gain = cur.r + bonus;
                state.carottes += gain;
                fbEl.className = 'fb ok';
                fbEl.textContent = `Bravo ! +${gain} 🥕${bonus ? ' (série de ' + state.serie + ')' : ''} · ${cur.e}`;
                animateTo(state.carottes);
                flyCarrots(btn, gain);
                if (window.avatar && window.avatar.celebrate) window.avatar.celebrate(gain);
            } else {
                state.serie = 0;
                btn.classList.add('bad');
                fbEl.className = 'fb ko';
                fbEl.textContent = `Raté : c'était « ${cur.o[cur.a]} ». ${cur.e}`;
                el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
            }
            persist();
            requestAnimationFrame(layout);
            timer = setTimeout(next, ok ? 5000 : 8000);
        }
        return { next, right: () => { const b = oEl.querySelector('[data-k="' + cur.a + '"]'); if (b) b.click(); } };
    }
    // L'avatar ne doit pas passer sous les cartes : on lui réserve la place du haut
    function layout() {
        const h = Math.ceil(root.getBoundingClientRect().height) + 8;
        document.documentElement.style.setProperty('--enigmes-h', h + 'px');
        const face = $('face');
        if (face) face.dataset.top = String(h);
    }
    if (window.ResizeObserver) new ResizeObserver(layout).observe(root);
    window.addEventListener('resize', layout);
    const m = Card('m'), p = Card('p');
    paintCount(0);
    load().then(() => { m.next(); p.next(); layout(); });
    window.enigmes = { state, _right: (c) => (c === 'p' ? p : m).right() };
})();
