// chant.js — David Twenty chante : un petit synthétiseur de voix (source glottale + trois formants + consonnes bruitées)
// chante des chansons du domaine public, calé sur les notes et les syllabes. Rien n'est demandé à Internet.
(function () {
    'use strict';
    // Voyelles : formants F1, F2, F3 (Hz) et nasalité. Légèrement relevés (×1,15) pour une voix d'enfant.
    const KID = 1.15;
    const V = {
        a: [800, 1300, 2600], e: [400, 2100, 2800], E: [550, 1800, 2600], i: [300, 2300, 3000], o: [450, 900, 2600], ou: [320, 800, 2500],
        eu: [420, 1500, 2500], y: [300, 1700, 2300], an: [650, 1000, 2600, 'n'], on: [500, 900, 2500, 'n'], in: [550, 1800, 2600, 'n']
    };
    // Consonnes d'attaque : f = fricative (bruit), v = fricative voisée, p = occlusive, n = nasale, l = liquide (glissement de formants), '' = aucune
    const S = (c, v) => ({ c, v });
    // Chaque note : [syllabe affichée, consonne, voyelle, demi-tons au-dessus de la tonique, durée en temps]
    const SONGS = [
        {
            titre: 'Frère Jacques', bpm: 100,
            sections: [
                { texte: 'Frère Jacques, Frère Jacques,', notes: [['Frè', 'f', 'E', 0, 1], ['re', 'l', 'eu', 2, 1], ['Jac', 'v', 'a', 4, 1], ['ques', 'p', 'eu', 0, 1], ['Frè', 'f', 'E', 0, 1], ['re', 'l', 'eu', 2, 1], ['Jac', 'v', 'a', 4, 1], ['ques', 'p', 'eu', 0, 1]] },
                { texte: 'Dormez-vous ? Dormez-vous ?', notes: [['Dor', 'p', 'o', 4, 1], ['mez', 'n', 'e', 5, 1], ['vous', 'v', 'ou', 7, 2], ['Dor', 'p', 'o', 4, 1], ['mez', 'n', 'e', 5, 1], ['vous', 'v', 'ou', 7, 2]] },
                { texte: 'Sonnez les matines, sonnez les matines,', notes: [['Son', 'f', 'on', 7, 0.5], ['nez', 'n', 'e', 9, 0.5], ['les', 'l', 'e', 7, 0.5], ['ma', 'n', 'a', 5, 0.5], ['ti', 'p', 'i', 4, 1], ['nes', 'n', 'eu', 0, 1], ['Son', 'f', 'on', 7, 0.5], ['nez', 'n', 'e', 9, 0.5], ['les', 'l', 'e', 7, 0.5], ['ma', 'n', 'a', 5, 0.5], ['ti', 'p', 'i', 4, 1], ['nes', 'n', 'eu', 0, 1]] },
                { texte: 'Ding, ding, dong ! Ding, ding, dong !', notes: [['Din', 'p', 'in', 0, 1], ['din', 'p', 'in', 7, 1], ['don', 'p', 'on', 0, 2], ['Din', 'p', 'in', 0, 1], ['din', 'p', 'in', 7, 1], ['don', 'p', 'on', 0, 2]] }
            ]
        },
        {
            titre: 'Au clair de la lune', bpm: 84,
            sections: [
                { texte: 'Au clair de la lune,', notes: [['Au', '', 'o', 0, 1], ['clair', 'p', 'E', 0, 1], ['de', 'p', 'eu', 0, 1], ['la', 'l', 'a', 2, 1], ['lu', 'l', 'y', 4, 2], ['ne', 'n', 'eu', 2, 2]] },
                { texte: 'mon ami Pierrot.', notes: [['mon', 'n', 'on', 0, 1], ['a', '', 'a', 4, 1], ['mi', 'n', 'i', 2, 1], ['Pier', 'p', 'E', 2, 1], ['rot', 'l', 'o', 0, 4]] }
            ]
        },
        {
            titre: 'Ah ! vous dirai-je, maman', bpm: 96,
            sections: [
                { texte: 'Ah ! vous dirai-je, maman,', notes: [['Ah', '', 'a', 0, 1], ['vous', 'v', 'ou', 0, 1], ['di', 'p', 'i', 7, 1], ['rai', 'l', 'E', 7, 1], ['je', 'v', 'eu', 9, 1], ['ma', 'n', 'a', 9, 1], ['man', 'n', 'an', 7, 2]] },
                { texte: 'ce qui cause mon tourment.', notes: [['ce', 'f', 'eu', 5, 1], ['qui', 'p', 'i', 5, 1], ['cau', 'p', 'o', 4, 1], ['se', 'f', 'eu', 4, 1], ['mon', 'n', 'on', 2, 1], ['tour', 'p', 'ou', 2, 1], ['ment', 'n', 'an', 0, 2]] }
            ]
        }
    ];
    const TONIC = 349.23;   // fa 4 : tonique de toutes les chansons (voix d'enfant)

    // Bruit blanc partagé
    const noiseCache = new WeakMap();
    function noise(c) {
        if (!noiseCache.has(c)) {
            const len = c.sampleRate, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
            for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
            noiseCache.set(c, buf);
        }
        return noiseCache.get(c);
    }
    function burst(c, dest, t, kind, dur, vol) {
        const n = c.createBufferSource(); n.buffer = noise(c); n.loop = true;
        const f = c.createBiquadFilter(), g = c.createGain();
        if (kind === 'f') { f.type = 'bandpass'; f.frequency.value = 5200; f.Q.value = 1.2; }
        else if (kind === 'v') { f.type = 'bandpass'; f.frequency.value = 3200; f.Q.value = 1.4; }
        else { f.type = 'highpass'; f.frequency.value = 1800; }
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.008); g.gain.linearRampToValueAtTime(0.0001, t + dur);
        n.connect(f); f.connect(g); g.connect(dest);
        n.start(t, Math.random() * 0.5); n.stop(t + dur + 0.02);
    }

    // Une syllabe chantée : voyelle tenue (dents de scie filtrées par trois formants) + consonne d'attaque
    function syllable(c, dest, t, dur, freq, cons, vow, vol) {
        const F = (V[vow] || V.a), nasal = F[3] === 'n';
        const onset = cons === 'p' ? 0.035 : cons === 'f' || cons === 'v' ? 0.07 : cons === 'n' ? 0.06 : cons === 'l' ? 0.05 : 0;
        const t0 = t;                                   // la voyelle tombe sur le temps ; la consonne la précède un peu
        if (cons === 'f' || cons === 'v') burst(c, dest, t0 - onset, cons, onset + 0.02, 0.22);
        if (cons === 'p') burst(c, dest, t0 - onset, 'p', 0.03, 0.3);
        const amp = c.createGain();
        const end = t0 + Math.max(0.12, dur);
        amp.gain.setValueAtTime(0.0001, t0 - (cons === 'n' || cons === 'l' ? onset : 0));
        amp.gain.linearRampToValueAtTime(vol, t0 + 0.035);
        amp.gain.setValueAtTime(vol, Math.max(t0 + 0.04, end - 0.09));
        amp.gain.linearRampToValueAtTime(0.0001, end + 0.03);
        amp.connect(dest);
        // source glottale : deux dents de scie très légèrement désaccordées + vibrato qui s'installe
        const lfo = c.createOscillator(), lfoG = c.createGain();
        lfo.frequency.value = 5.4; lfoG.gain.setValueAtTime(0, t0); lfoG.gain.linearRampToValueAtTime(freq * 0.006, t0 + Math.min(0.4, dur * 0.8));
        lfo.connect(lfoG);
        [1, 1.004].forEach((det) => {
            const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq * det;
            lfoG.connect(o.frequency);
            const src = c.createGain(); src.gain.value = 0.5;
            o.connect(src);
            // formants en parallèle
            [[F[0], 1.0, 9], [F[1], 0.7, 10], [F[2], 0.4, 12]].forEach(([fc, g, q], i) => {
                const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = q;
                // la liquide (l, r) et la nasale glissent vers la voyelle
                const start = fc * KID;
                if (cons === 'l' && i < 2) { bp.frequency.setValueAtTime(i === 0 ? 360 : 1500, t0 - onset); bp.frequency.linearRampToValueAtTime(start, t0 + 0.07); }
                else if (cons === 'n' && i < 2) { bp.frequency.setValueAtTime(i === 0 ? 250 : 1100, t0 - onset); bp.frequency.linearRampToValueAtTime(start, t0 + 0.06); }
                else bp.frequency.value = start;
                const gg = c.createGain(); gg.gain.value = g;
                src.connect(bp); bp.connect(gg); gg.connect(amp);
            });
            if (nasal) {   // résonance nasale
                const nb = c.createBiquadFilter(); nb.type = 'bandpass'; nb.frequency.value = 280; nb.Q.value = 6;
                const ng = c.createGain(); ng.gain.value = 0.6; src.connect(nb); nb.connect(ng); ng.connect(amp);
            }
            o.start(t0 - (cons === 'n' || cons === 'l' ? onset : 0)); o.stop(end + 0.06);
        });
        lfo.start(t0); lfo.stop(end + 0.06);
        return end;
    }

    // Programme une section : renvoie { fin, syllabes: [{ t, texte }] }
    function schedule(c, dest, t0, song, sec, opts) {
        opts = opts || {};
        const beat = 60 / song.bpm, vol = opts.volume || 0.5;
        let t = t0; const syl = [];
        for (const [txt, cons, vow, semi, beats] of song.sections[sec].notes) {
            const dur = beats * beat * 0.92, f = TONIC * Math.pow(2, semi / 12);
            syllable(c, dest, t, dur, f, cons, vow, vol);
            syl.push({ t, texte: txt, f });
            t += beats * beat;
        }
        return { fin: t, syllabes: syl };
    }

    // Progression : à chaque bonne réponse, la section suivante de la chanson en cours, puis une autre chanson
    function load() { try { return JSON.parse(localStorage.getItem('avatar-chant') || '{}'); } catch (e) { return {}; } }
    function next() {
        const st = load();
        let song = Number.isInteger(st.song) && SONGS[st.song] ? st.song : 0, sec = Number.isInteger(st.sec) ? st.sec : 0;
        if (sec >= SONGS[song].sections.length) { song = (song + 1) % SONGS.length; sec = 0; }
        try { localStorage.setItem('avatar-chant', JSON.stringify({ song, sec: sec + 1 })); } catch (e) { /* stockage indisponible */ }
        return { song: SONGS[song], titre: SONGS[song].titre, sec, secIndex: sec, texte: SONGS[song].sections[sec].texte };
    }
    window.Chant = { SONGS, TONIC, schedule, next, V };
})();
