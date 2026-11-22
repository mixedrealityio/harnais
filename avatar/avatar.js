// avatar.js — conversation vocale « full duplex » avec un avatar animé.
// Le micro reste ouvert pendant que David Twenty parle : on peut l'interrompre à la voix, et elle réagit pendant
// qu'on parle (hochements, « hm », « d'accord »). Chaîne : micro → transcription Voxtral → Ministral → voix en flux.
(function () {
    'use strict';

    // ---------- Réglages ----------
    // Palier gratuit Mistral : 2 requêtes par minute et par modèle. On répartit donc les réponses entre plusieurs modèles.
    const CHAT_POOL = ['ministral-8b-latest', 'ministral-14b-latest', 'ministral-3b-latest', 'open-mistral-nemo'];
    const PER_MODEL_PER_MIN = 2;
    const STT_MODEL = 'voxtral-mini-latest';
    const TTS_MODEL = 'voxtral-mini-tts-2603';
    // Pas de voix d'enfant chez Mistral : on part d'une voix existante, jouée plus aiguë (pitch), puis on rallonge le son
    // sans changer sa hauteur (étirement temporel) pour que la voix parle plus lentement qu'une lecture accélérée.
    // Garçon : voix masculine « Paul » (lit le français avec un léger accent), hauteur +30 %.
    const VOICES = {
        garcon: { id: 'en_paul_happy', pitch: 1.3, speed: 0.9, label: 'Voix : garçon' },
        fille: { id: 'fr_marie_happy', pitch: 1.17, speed: 0.92, label: 'Voix : fille' },
        adulte: { id: 'fr_marie_neutral', pitch: 1, speed: 0.95, label: 'Voix : adulte' }
    };
    const VOICE_ORDER = ['garcon', 'fille', 'adulte'];
    let voiceKind = (function () { try { return localStorage.getItem('avatar-voix2') || 'garcon'; } catch (e) { return 'garcon'; } })();
    if (!VOICES[voiceKind]) voiceKind = 'garcon';
    const voice = () => VOICES[voiceKind];
    const BLOCK = 2048;                  // blocs du micro (~43 ms à 48 kHz)
    const PREROLL_BLOCKS = 14;           // ~0,6 s gardées avant la détection
    const START_BLOCKS = 3;              // début de parole : 3 blocs sur 10 au-dessus du seuil
    const START_BLOCKS_BARGE = 7;        // pendant qu'elle parle : 7 sur 10 (l'écho ne doit pas l'interrompre)
    const END_SILENCE_MS = 800;          // fin de tour après 0,8 s de silence
    const MIN_SPEECH_MS = 300;
    const MAX_SPEECH_MS = 25000;
    const BC_MIN_SPEECH_MS = 4000;       // réaction « hm » seulement quand on parle depuis un moment
    const BC_PAUSE_MIN = 380, BC_PAUSE_MAX = 620;
    const BC_GAP_MS = 7000;
    const HISTORY_MAX = 24;
    const BACKCHANNELS = ['D\'accord.', 'Je vois.', 'Oui.'];

    const SYSTEM_PROMPT = [
        'Tu t\'appelles David Twenty. Tu es un avatar vocal chaleureux et naturel ; si on te demande ton nom, tu réponds « David Twenty ». Tu parles français, à l\'oral, en face à face avec une personne.',
        'Réponds en une à trois phrases courtes, comme dans une vraie conversation : pas de liste, pas de markdown, pas d\'emoji, pas de symbole.',
        'Écris tout ce qui se dit à voix haute en toutes lettres : « onze à douze degrés », « vingt-trois pour cent ».',
        'Tu peux réagir brièvement (« ah oui ? », « d\'accord ») et poser une question de relance, mais jamais plusieurs à la fois.',
        'Si la personne t\'a interrompue, reprends simplement avec ce qu\'elle vient de dire. Quand des résultats de recherche web te sont fournis, appuie-toi dessus en une ou deux phrases : ne lis jamais d\'adresse, de numéro de source ni de liste de liens, cite au besoin le nom du site. Sans résultats fournis, tu n\'as pas accès à Internet : dis-le si on te demande une information récente.'
    ].join(' ');

    // ---------- Éléments ----------
    const $ = (id) => document.getElementById(id);
    const el = { face: $('face'), status: $('status'), capUser: $('cap-user'), capBot: $('cap-bot'),
        micsel: $('micsel'), mic: $('mic'), meter: $('meter-bar'), head: $('head'), voiceBtn: $('voice'), diag: $('diag'), start: $('start'), mute: $('mute'), cut: $('cut'), stop: $('stop'), note: $('note') };
    const HEADS = { lapin: window.AvatarRabbit, marie: window.AvatarFace };
    const HEAD_LABEL = { lapin: 'Tête : lapin', marie: 'Tête : visage' };
    let headName = (function () { try { return localStorage.getItem('avatar-tete') || 'lapin'; } catch (e) { return 'lapin'; } })();
    if (!HEADS[headName]) headName = 'lapin';
    let face = HEADS[headName](el.face);
    attachPet(face);
    document.body.classList.toggle('lapin', headName === 'lapin');
    el.head.textContent = HEAD_LABEL[headName];
    el.voiceBtn.textContent = VOICES[voiceKind].label;
    el.voiceBtn.addEventListener('click', () => {
        voiceKind = VOICE_ORDER[(VOICE_ORDER.indexOf(voiceKind) + 1) % VOICE_ORDER.length];
        try { localStorage.setItem('avatar-voix2', voiceKind); } catch (e) { /* stockage indisponible */ }
        el.voiceBtn.textContent = VOICES[voiceKind].label;
        S.bcBuffers = []; S.bcStarted = false;   // les petites réactions sont refaites avec la nouvelle voix
    });
    el.head.addEventListener('click', () => {
        headName = headName === 'lapin' ? 'marie' : 'lapin';
        try { localStorage.setItem('avatar-tete', headName); } catch (e) { /* stockage indisponible */ }
        face.stop(); document.body.classList.toggle('lapin', headName === 'lapin'); face = HEADS[headName](el.face); attachPet(face);
        face.setState(S.state === 'transcribing' ? 'thinking' : S.state);
        el.head.textContent = HEAD_LABEL[headName];
    });
    const STATUS = { idle: '', user: 'Je vous écoute', transcribing: '…', thinking: 'Je réfléchis', speaking: 'David Twenty parle' };

    // ---------- Mode ?diag : journal envoyé au VPS (~/.cache/harnais-diag-live.log) et affiché à l'écran ----------
    const DIAG = /[?&]diag\b/.test(location.search);
    const diagLines = [];
    function diagLog(msg) {
        if (!DIAG) return;
        const line = new Date().toISOString().slice(11, 23) + ' [avatar] ' + msg;
        diagLines.push(line);
        el.diag.hidden = false;
        el.diag.textContent = (el.diag.textContent + '\n' + line.slice(0, 120)).split('\n').slice(-9).join('\n');
    }
    if (DIAG) setInterval(() => {
        if (!diagLines.length) return;
        fetch('../diag-live', { method: 'POST', body: diagLines.splice(0).join('\n'), keepalive: true, credentials: 'same-origin' }).catch(() => {});
    }, 2000);

    // ---------- Clé Mistral ----------
    function mistralKey() {
        try { const k = JSON.parse(localStorage.getItem('minou-apikeys') || '{}').mistral; if (k) return k; } catch (e) { /* stockage indisponible */ }
        return (window.DAVIDTWENTYAI_CLES || {}).mistral || '';
    }

    // ---------- État ----------
    const S = {
        active: false, state: 'idle', muted: false,
        ctx: null, stream: null, source: null, proc: null, sink: null, out: null, analyser: null,
        floor: 0.002, hits: [], preroll: [], chunks: [], recording: false, speechStart: 0, lastVoiceAt: 0,
        lastBc: 0, bcUntil: 0, bcBuffers: [], lastNod: 0,
        history: [], gen: 0, llmAbort: null, voiceChain: Promise.resolve(), voiceAbort: null, sources: [], playHead: 0,
        spoken: '', pendingText: '', llmDone: true, botText: '', prevBot: '', ttsPending: 0, peak: 0, blocks: 0, maxRms: 0, peakWin: 0, zeroBlocks: 0, rebuilt: false, micTimer: null, meterTimer: null
    };

    function setState(st) {
        if (S.state !== st) diagLog('état ' + st);
        S.state = st;
        face.setState(st === 'transcribing' ? 'thinking' : st);
        el.status.textContent = S.muted && st === 'idle' ? 'Micro coupé' : (STATUS[st] || '');
        el.status.dataset.s = st;
    }

    // ---------- Audio : contexte, micro, sortie ----------
    function newContext() {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        S.ctx = new Ctx();
        try { S.ctx.resume(); } catch (e) { /* repris au toucher */ }
        // Sortie unique : tout ce que l'avatar dit passe par là (analyse de la bouche)
        S.out = S.ctx.createGain();
        S.analyser = S.ctx.createAnalyser();
        S.analyser.fftSize = 1024;
        S.out.connect(S.analyser);
        S.analyser.connect(S.ctx.destination);
    }
    let micChoice = (function () { try { return localStorage.getItem('avatar-micro') || ''; } catch (e) { return ''; } })();
    async function startMic() {
        const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
        if (micChoice) audio.deviceId = { exact: micChoice };
        try {
            S.stream = await navigator.mediaDevices.getUserMedia({ audio });
        } catch (e) {
            if (!micChoice) throw e;
            diagLog('micro choisi introuvable, retour au micro par défaut');
            micChoice = ''; delete audio.deviceId;
            S.stream = await navigator.mediaDevices.getUserMedia({ audio });
        }
        const track = S.stream.getAudioTracks()[0];
        if (track) {
            const st = track.getSettings ? track.getSettings() : {};
            diagLog(`micro « ${track.label} » ${track.readyState}${track.muted ? ' MUET' : ''} · écho ${st.echoCancellation} · ${S.ctx.state} ${S.ctx.sampleRate} Hz`);
            track.onmute = () => { diagLog('micro MUET (coupé par le système)'); showMicHint('Le micro est coupé par le système. Vérifiez qu\'aucune autre app ne l\'utilise.'); };
            track.onunmute = () => { diagLog('micro rétabli'); showMicHint(''); };
            track.onended = () => { diagLog('micro TERMINÉ'); showMicHint('Le micro s\'est arrêté : touchez « Terminer » puis recommencez.'); };
            el.mic.textContent = '🎤 ' + (track.label || 'micro').slice(0, 44);
        }
        S.source = S.ctx.createMediaStreamSource(S.stream);
        S.proc = S.ctx.createScriptProcessor(BLOCK, 1, 1);
        S.sink = S.ctx.createGain(); S.sink.gain.value = 0;
        S.source.connect(S.proc); S.proc.connect(S.sink); S.sink.connect(S.ctx.destination);
        S.proc.onaudioprocess = onAudio;
    }
    // Le micro doit envoyer des blocs et du signal : sinon on relance le contexte audio une fois, puis on le dit à l'écran
    function showMicHint(t) { el.capUser.textContent = t; }
    function micWatch() {
        clearTimeout(S.micTimer);
        S.micTimer = setTimeout(() => {
            if (!S.active || !S.stream) return;
            diagLog(`micro : ${S.blocks} blocs, pic ${S.maxRms.toFixed(4)}, seuil ${Math.max(0.004, S.floor * 3).toFixed(4)}, ${S.ctx.state}`);
            if (S.ctx.state !== 'running') { try { S.ctx.resume(); } catch (e) { /* repris au toucher */ } }
            if (S.blocks === 0 || S.maxRms === 0) {
                if (!S.rebuilt) {
                    S.rebuilt = true;
                    diagLog('micro : aucun signal, contexte recréé');
                    reopenMic().then(micWatch);
                    return;
                }
                listMics().then((mics) => {
                    const next = mics.find(d => !(S.micTried && S.micTried.has(d.deviceId)));
                    if (next && S.active) {
                        diagLog('micro muet : essai de « ' + (next.label || next.deviceId.slice(0, 8)) + ' »');
                        showMicHint('Ce micro n\'envoie que du silence : j\'essaie « ' + (next.label || 'un autre micro') + ' »…');
                        S.micTried = S.micTried || new Set(); S.micTried.add(next.deviceId);
                        micChoice = next.deviceId;
                        reopenMic().then(micWatch);
                    } else {
                        showMicHint(S.blocks === 0 ? 'Le son du micro n\'arrive pas. Touchez l\'écran, ou autorisez le micro puis recommencez.' : 'Aucun micro n\'envoie de son : sur Mac, autorisez Chrome dans Réglages Système > Confidentialité > Micro, ou choisissez un autre micro dans la liste.');
                    }
                });
            } else if (S.maxRms < 0.01 && S.state === 'idle') {
                showMicHint('Je vous entends à peine : parlez plus près du micro.');
            }
        }, 3000);
    }
    // Micros disponibles (les noms n'apparaissent qu'une fois le micro autorisé)
    async function listMics() {
        try {
            const devs = await navigator.mediaDevices.enumerateDevices();
            return devs.filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
        } catch (e) { return []; }
    }
    async function fillMicList() {
        const mics = await listMics();
        const cur = S.stream && S.stream.getAudioTracks()[0] && S.stream.getAudioTracks()[0].getSettings().deviceId;
        el.micsel.innerHTML = '';
        mics.forEach((d, i) => {
            const o = document.createElement('option');
            o.value = d.deviceId; o.textContent = d.label || ('Micro ' + (i + 1));
            if (d.deviceId === cur) o.selected = true;
            el.micsel.appendChild(o);
        });
        el.micsel.hidden = mics.length < 2;
        S.micTried = S.micTried || new Set(); if (cur) S.micTried.add(cur);
    }
    async function reopenMic() {
        try {
            try { S.proc && (S.proc.onaudioprocess = null); S.source && S.source.disconnect(); S.proc && S.proc.disconnect(); S.sink && S.sink.disconnect(); } catch (e) { /* déjà détaché */ }
            try { S.stream && S.stream.getTracks().forEach(t => t.stop()); } catch (e) { /* déjà arrêté */ }
            S.blocks = 0; S.maxRms = 0;
            await startMic();
            try { await S.ctx.resume(); } catch (e) { /* repris au toucher */ }
            fillMicList();
        } catch (e) { diagLog('micro : réouverture impossible ' + (e && e.message)); }
    }
    function stopAudio() {
        try { S.proc && (S.proc.onaudioprocess = null); } catch (e) { /* déjà arrêté */ }
        try { S.source && S.source.disconnect(); S.proc && S.proc.disconnect(); S.sink && S.sink.disconnect(); } catch (e) { /* déjà arrêté */ }
        try { S.stream && S.stream.getTracks().forEach(t => t.stop()); } catch (e) { /* déjà arrêté */ }
        try { S.ctx && S.ctx.close(); } catch (e) { /* déjà arrêté */ }
        S.ctx = S.stream = S.source = S.proc = S.sink = S.out = S.analyser = null;
    }
    // Elle « parle » dès qu'une voix est demandée, tant que de l'audio est attendu ou joué, et 0,45 s après (écho de fin)
    // Jauge : montre à l'écran que le micro entend, même quand rien ne se passe
    function meterTick() {
        if (!S.active) { el.meter.style.width = '0'; return; }
        el.meter.style.width = Math.min(100, Math.round(S.peakWin * 900)) + '%';
        S.peakWin *= 0.6;
    }
    const botTalking = () => S.state === 'speaking' || S.ttsPending > 0 || !!(S.ctx && (S.ctx.currentTime < S.bcUntil || S.ctx.currentTime < S.playHead + 0.45));

    // Sans micro (écho de l'avatar en cas de mauvaise annulation) : seuil plus haut pendant qu'elle parle
    function onAudio(e) {
        if (!S.active) return;
        const data = new Float32Array(e.inputBuffer.getChannelData(0));
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();
        S.blocks++;
        if (rms > S.maxRms) S.maxRms = rms;
        if (rms > S.peakWin) S.peakWin = rms;
        S.zeroBlocks = rms === 0 ? S.zeroBlocks + 1 : 0;
        const talking = botTalking();
        const threshold = talking ? Math.max(0.02, S.floor * 5) : Math.max(0.004, S.floor * 3);
        if (S.muted) { S.hits = []; return; }
        face.setListenLevel(S.recording && !talking ? rms * 14 : 0);

        if (S.recording) {
            S.chunks.push(data);
            const bcPlaying = S.ctx.currentTime < S.bcUntil;
            S.peak = Math.max(S.peak * 0.992, rms);
            // Voix = nettement au-dessus du seuil ET d'une part du pic de la prise : un bruit continu ne retient plus l'enregistrement
            if (rms > Math.max(threshold * (bcPlaying ? 1.8 : 0.6), S.peak * 0.2)) S.lastVoiceAt = now;
            const pause = now - S.lastVoiceAt, dur = now - S.speechStart;
            // Il hoche la tête dès qu'on marque une pause, et réagit à voix basse quand on parle longtemps
            if (pause > 250 && pause < 700 && now - S.lastNod > 2200) { S.lastNod = now; face.nod(0.8); }
            if (dur > BC_MIN_SPEECH_MS && pause > BC_PAUSE_MIN && pause < BC_PAUSE_MAX && now - S.lastBc > BC_GAP_MS && !bcPlaying && S.ttsPending === 0 && S.sources.length === 0) playBackchannel(now);
            if (pause > END_SILENCE_MS || dur > MAX_SPEECH_MS) finishUtterance();
            return;
        }
        S.preroll.push(data);
        if (S.preroll.length > PREROLL_BLOCKS) S.preroll.shift();
        if (S.state === 'transcribing') { S.hits = []; return; }
        S.hits.push(rms > threshold ? 1 : 0);
        if (S.hits.length > 10) S.hits.shift();
        const hits = S.hits.reduce((a, b) => a + b, 0);
        const barge = talking || S.state === 'thinking';
        if (rms > threshold && hits >= (barge ? START_BLOCKS_BARGE : START_BLOCKS)) startUtterance(now);
        else if (rms <= threshold && !talking) S.floor = S.floor * 0.95 + rms * 0.05;
    }

    function startUtterance(now) {
        if (S.state === 'speaking' || S.state === 'thinking') interrupt();
        S.recording = true;
        S.chunks = S.preroll.slice(); S.preroll = []; S.hits = [];
        S.speechStart = S.lastVoiceAt = now;
        S.peak = 0;
        S.lastNod = now;
        el.capUser.textContent = '';
        setState('user');
    }

    function finishUtterance() {
        S.recording = false;
        const chunks = S.chunks; S.chunks = [];
        const rate = S.ctx ? S.ctx.sampleRate : 48000;
        const ms = chunks.length * BLOCK / rate * 1000;
        if (ms < MIN_SPEECH_MS + PREROLL_BLOCKS * BLOCK / rate * 1000) { setState('idle'); return; }
        setState('transcribing');
        transcribe(toWav(chunks, rate)).then((text) => {
            if (!S.active) return;
            text = (text || '').replace(/\s+/g, ' ').trim();
            // Bruit ou souffle : rien à répondre
            if (text.replace(/[^\p{L}\p{N}]/gu, '').length < 3) { setState('idle'); return; }
            if (isHallucination(text) || looksLikeEcho(text)) { diagLog('ignoré (écho ou bruit) : « ' + text.slice(0, 60) + ' »'); setState('idle'); return; }
            diagLog('transcription : « ' + text.slice(0, 80) + ' »');
            el.capUser.textContent = '« ' + text + ' »';
            say(text);
        }).catch((err) => {
            if (!S.active) return;
            el.capUser.textContent = 'Transcription impossible : ' + String(err && err.message || err).slice(0, 120);
            setState('idle');
        });
    }

    // Voxtral invente parfois « Thank you » sur du bruit ; et le micro peut reprendre la voix de l'avatar
    function isHallucination(t) {
        const n = t.toLowerCase().replace(/[^a-zàâçéèêëîïôûùüÿœ' ]/g, ' ').replace(/\s+/g, ' ').trim();
        return /^(thank you|thanks for watching|thank you for watching|sous-titr|subtitles|amara)\b/.test(n) || n === 'thank you' || n === 'you';
    }
    function looksLikeEcho(t) {
        const norm = (x) => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
        const words = norm(t);
        if (words.length < 3) return false;
        const ref = new Set(norm(S.botText + ' ' + S.prevBot));
        return words.filter(w => ref.has(w)).length / words.length >= 0.7;
    }

    function toWav(chunks, rate) {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const ratio = rate / 16000;
        const outLen = Math.floor(total / ratio);
        const pcm = new Int16Array(outLen);
        let ci = 0, offset = 0;
        for (let i = 0; i < outLen; i++) {
            let idx = Math.floor(i * ratio) - offset;
            while (ci < chunks.length && idx >= chunks[ci].length) { offset += chunks[ci].length; idx -= chunks[ci].length; ci++; }
            const smp = ci < chunks.length ? chunks[ci][idx] : 0;
            pcm[i] = Math.max(-1, Math.min(1, smp)) * 0x7fff;
        }
        const buf = new ArrayBuffer(44 + pcm.length * 2);
        const v = new DataView(buf);
        const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
        str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
        str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
        new Int16Array(buf, 44).set(pcm);
        return new Blob([buf], { type: 'audio/wav' });
    }

    // ---------- Mistral : appels avec nouvelle tentative sur 429 ----------
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    async function mistral(path, init, tries = 4, base = 'https://api.mistral.ai') {
        for (let i = 0; ; i++) {
            const t0 = performance.now();
            const res = await fetch(base + path, init);
            diagLog(`${path} → ${res.status} en ${Math.round(performance.now() - t0)} ms` + (i ? ` (essai ${i + 1})` : ''));
            if (res.status !== 429 || i >= tries - 1 || (init.signal && init.signal.aborted)) return res;
            const wait = Math.min(8000, (Number(res.headers.get('retry-after')) || 0) * 1000 || 1500 * (i + 1));
            diagLog('429 : nouvelle tentative dans ' + wait + ' ms');
            await sleep(wait);
        }
    }
    async function transcribe(blob) {
        const fd = new FormData();
        fd.append('file', blob, 'audio.wav'); fd.append('model', STT_MODEL); fd.append('language', 'fr');
        const res = await mistral('/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + mistralKey() }, body: fd });
        if (!res.ok) throw new Error('Mistral ' + res.status + (res.status === 429 ? ' : limite de requêtes, réessayez' : ''));
        return (await res.json()).text;
    }

    // ---------- Conversation : réponse en flux, lue phrase par phrase ----------
    function cleanForSpeech(text) {
        return String(text)
            .replace(/(^|\n)\s*Sources?\s*:[\s\S]*$/i, ' ').replace(/\[\d+(?:\s*[,\-–]\s*\d+)*\]/g, ' ').replace(/\bhttps?:\/\/\S+/g, ' ')
            .replace(/(\d)\s*[‐-―−]\s*(\d)/g, '$1 à $2')
            .replace(/\s*°\s*C\b/g, ' degrés Celsius').replace(/\s*°/g, ' degrés')
            .replace(/[*_`#>|~]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // Questions d'actualité, de météo, de prix, de résultats… ou demande explicite de chercher
    const WEB_RE = /\b(météo|temps qu.il fait|il fait (combien|quel)|actualit|actu\b|infos?\b|nouvelles?\b|aujourd.hui|ce (matin|soir)|en ce moment|dernier(e|s)?\b|récent|cette semaine|hier|demain|score|résultat|match|classement|cours (de|du)|bourse|prix|combien (coûte|ça coûte|vaut)|horaires?|ouvert|élections?|président|premier ministre|cherche|recherche|sur (internet|le web)|trouve)/i;
    function needsWeb(text) { return WEB_RE.test(text); }

    // Chaque modèle a son quota par minute (fenêtre de l'horloge) : on prend le premier modèle qui n'est pas épuisé ;
    // si tous le sont, on attend la minute suivante en le disant à l'écran
    const poolUse = {};
    const minuteId = () => Math.floor(Date.now() / 60000);
    const used = (m) => (poolUse[m] && poolUse[m].win === minuteId() ? poolUse[m].n : 0);
    function pickModel() {
        let best = null;
        for (const m of CHAT_POOL) if (used(m) < PER_MODEL_PER_MIN && (best === null || used(m) < used(best))) best = m;
        return best;
    }
    async function chatRequest(web, abort, gen) {
        let lastRes = null;
        for (let essai = 0; essai < CHAT_POOL.length * 3 + 1; essai++) {
            if (gen !== S.gen) return null;
            let model = pickModel();
            if (!model) {
                const wait = 60000 - (Date.now() % 60000) + 400;
                diagLog('tous les modèles Mistral sont à leur limite : attente ' + Math.round(wait / 1000) + ' s');
                el.capBot.textContent = 'Je reprends mon souffle… (limite Mistral)';
                await sleep(wait);
                if (gen !== S.gen) return null;
                model = pickModel() || CHAT_POOL[0];
            }
            poolUse[model] = { win: minuteId(), n: used(model) + 1 };
            diagLog('modèle ' + model + ' (' + poolUse[model].n + '/' + PER_MODEL_PER_MIN + ')');
            const res = await mistral(web ? '/mistral/v1/chat/completions' : '/v1/chat/completions', {
                method: 'POST', signal: abort.signal,
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + mistralKey() },
                body: JSON.stringify({ model, stream: true, max_tokens: 220, temperature: 0.7, ...(web ? { web_search: true, web_voice: true } : {}),
                    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...S.history] })
            }, 1, web ? '..' : 'https://api.mistral.ai');
            if (res.status !== 429) return res;
            poolUse[model] = { win: minuteId(), n: PER_MODEL_PER_MIN };   // ce modèle est épuisé pour cette minute
            lastRes = res;
        }
        return lastRes;
    }

    function stopAllSounds() {
        for (const src of S.sources) { try { src.stop(); } catch (e) { /* déjà arrêtée */ } }
        S.sources = []; S.playHead = 0; S.bcUntil = 0;
    }

    async function say(userText) {
        const gen = ++S.gen;
        stopAllSounds();
        S.ttsPending = 0; S.voiceChain = Promise.resolve();
        S.history.push({ role: 'user', content: userText });
        if (S.history.length > HISTORY_MAX) S.history.splice(0, S.history.length - HISTORY_MAX);
        S.prevBot = (S.botText + ' ' + S.prevBot).slice(0, 600);
        S.spoken = ''; S.pendingText = ''; S.botText = ''; S.llmDone = false;
        el.capBot.textContent = '';
        setState('thinking');
        const abort = new AbortController();
        S.llmAbort = abort;
        // Garde-fou : aucune réponse au bout de 40 s (recherche web ou modèle bloqués) → on rend la main au lieu de rester muet
        clearTimeout(S.wd);
        S.wd = setTimeout(() => {
            if (gen !== S.gen || S.botText) return;
            diagLog('délai dépassé : aucune réponse en 40 s');
            try { abort.abort(); } catch (e) { /* déjà fini */ }
            el.capBot.textContent = 'Pas de réponse du modèle, réessayez.';
            S.llmDone = true; setState('idle');
        }, 40000);
        // Recherche web (Tavily, par le relais du serveur) seulement quand la question en a besoin
        const web = needsWeb(userText);
        if (web) { diagLog('recherche web'); el.capBot.textContent = 'Je cherche sur le web…'; }
        try {
            const res = await chatRequest(web, abort, gen);
            if (!res) return;
            if (!res.ok) throw new Error(res.status === 429 ? 'Limite Mistral atteinte (2 réponses par minute et par modèle) : patientez une minute puis reparlez.' : 'Mistral ' + res.status);
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            while (gen === S.gen) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                const lines = buf.split('\n'); buf = lines.pop();
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const payload = line.slice(6).trim();
                    if (payload === '[DONE]') continue;
                    let evt; try { evt = JSON.parse(payload); } catch (e) { continue; }
                    const delta = evt.choices && evt.choices[0] && evt.choices[0].delta && evt.choices[0].delta.content;
                    if (typeof delta === 'string' && delta) onDelta(gen, delta);
                }
            }
            clearTimeout(S.wd);
            if (gen !== S.gen) return;
            flushSpeech(gen, true);
            S.llmDone = true;
            S.history.push({ role: 'assistant', content: S.botText.trim() || '…' });
            watchEnd(gen);
            if (!S.bcStarted) { S.bcStarted = true; setTimeout(() => { if (S.active) prepareBackchannels(); }, 6000); }
        } catch (err) {
            clearTimeout(S.wd);
            if (gen !== S.gen || (err && err.name === 'AbortError')) return;
            diagLog('erreur réponse : ' + String(err && err.message || err).slice(0, 120));
            el.capBot.textContent = String(err && err.message || err).slice(0, 140);
            S.llmDone = true;
            setState('idle');
        }
    }

    // Phrases complètes envoyées à la voix ; la première part plus tôt (à la première virgule) pour répondre vite
    function onDelta(gen, delta) {
        clearTimeout(S.wd);
        S.botText += delta;
        S.pendingText += delta;
        el.capBot.textContent = S.botText.trim();
        flushSpeech(gen, false);
    }
    function flushSpeech(gen, final) {
        let rest = S.pendingText;
        for (;;) {
            let cut = -1;
            if (final && rest.length <= 300) break;   // fin de réponse : le reste part en une seule requête de voix
            // Après le premier morceau, on regroupe les phrases (≈ 110 caractères) : moins de requêtes de voix, donc moins de 429
            const m = S.spoken && !final ? rest.match(/^[\s\S]{100,}?[.!?…](?=\s|$)/) : rest.match(/^[\s\S]*?[.!?…:;\n](?=\s|$)/);
            if (m) cut = m[0].length;
            else if (!S.spoken && !final) { const c = rest.match(/^[\s\S]{24,}?,(?=\s)/); if (c) cut = c[0].length; }
            else if (rest.length > 180 && !final) { const c = rest.match(/^[\s\S]{100,}?[,\s](?=\S)/); if (c) cut = c[0].length; }
            if (cut < 0) break;
            if (cut < 14 && !final) break;   // un texte trop court donne une voix inventée : on attend la suite
            const chunk = rest.slice(0, cut);
            rest = rest.slice(cut);
            speak(gen, chunk);
        }
        if (final && rest.trim()) { speak(gen, rest); rest = ''; }
        S.pendingText = rest;
    }

    // ---------- Voix en flux, jouée dans le contexte du micro ----------
    function speak(gen, raw) {
        const text = cleanForSpeech(raw);
        if (!text || gen !== S.gen) return;
        S.spoken += text + ' ';
        if (S.state !== 'speaking') setState('speaking');
        S.ttsPending++;
        S.voiceChain = S.voiceChain.then(() => gen === S.gen && streamTts(text, gen)).catch((err) => {
            diagLog('erreur voix : ' + String(err && err.message || err).slice(0, 120));
            if (gen === S.gen) el.capBot.textContent = 'Voix indisponible : ' + String(err && err.message || err).slice(0, 100);
        }).finally(() => { if (gen === S.gen) S.ttsPending = Math.max(0, S.ttsPending - 1); });
    }
    async function streamTts(text, gen) {
        const abort = new AbortController();
        S.voiceAbort = abort;
        const res = await mistral('/v1/audio/speech', {
            method: 'POST', signal: abort.signal,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + mistralKey() },
            body: JSON.stringify({ model: TTS_MODEL, input: text, response_format: 'pcm', voice_id: voice().id, stream: true })
        }, 3);
        if (!res.ok) throw new Error('Mistral ' + res.status);
        const parts = [];
        await readPcm(res, gen, (samples) => { parts.push(samples); });
        if (gen !== S.gen) return;
        const v = voice();
        let all = concat(parts);
        const maxSamples = Math.round((0.9 + text.length * 0.12) * 24000);
        if (all.length > maxSamples) {
            diagLog('audio trop long pour « ' + text.slice(0, 30) + ' » (' + (all.length / 24000).toFixed(1) + ' s), coupé');
            all = all.slice(0, maxSamples);
            const fade = Math.min(720, all.length);
            for (let i = 0; i < fade; i++) all[all.length - 1 - i] *= i / fade;
        }
        const f = v.pitch / v.speed;                       // > 1 : on rallonge le son avant de le jouer plus aigu
        schedule(Math.abs(f - 1) > 0.03 ? timeStretch(all, f) : all, 1, v.pitch);
    }
    async function readPcm(res, gen, onSamples) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (gen === S.gen || gen === 'bc') {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n'); buf = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                let evt; try { evt = JSON.parse(line.slice(6).trim()); } catch (e) { continue; }
                if (!evt.audio_data) continue;
                const raw = atob(evt.audio_data);
                const bytes = new Uint8Array(raw.length);
                for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                const samples = new Float32Array(bytes.buffer, 0, Math.floor(bytes.length / 4));   // PCM float 32 bits, 24 kHz
                if (samples.length) onSamples(samples);
            }
        }
        try { reader.cancel(); } catch (e) { /* flux déjà fermé */ }
    }
    function concat(parts) {
        const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    }
    // Étirement temporel (WSOLA) : f > 1 rallonge le son sans changer sa hauteur. Fenêtres de 40 ms, recouvrement de moitié,
    // chacune recalée (±12 ms) sur la suite naturelle de la précédente pour éviter les battements.
    function timeStretch(x, f) {
        const sr = 24000, win = Math.round(sr * 0.04), hop = win >> 1, ha = hop / f, tol = Math.round(sr * 0.012);
        const hann = new Float32Array(win);
        for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (win - 1));
        const outLen = Math.ceil(x.length * f) + win;
        const out = new Float32Array(outLen), norm = new Float32Array(outLen);
        let prev = 0;
        for (let k = 0; ; k++) {
            const target = Math.round(k * ha);
            let best = target;
            if (k > 0) {
                const ref = prev + hop;
                if (ref + win >= x.length) break;
                let bestC = -Infinity;
                for (let d = -tol; d <= tol; d += 2) {
                    const st = target + d;
                    if (st < 0 || st + win >= x.length) continue;
                    let c = 0;
                    for (let i = 0; i < win; i += 4) c += x[st + i] * x[ref + i];
                    if (c > bestC) { bestC = c; best = st; }
                }
            }
            if (best + win > x.length) break;
            const o = k * hop;
            if (o + win > outLen) break;
            for (let i = 0; i < win; i++) { out[o + i] += x[best + i] * hann[i]; norm[o + i] += hann[i]; }
            prev = best;
        }
        const n = Math.min(outLen, Math.floor(x.length * f));
        const res = new Float32Array(n);
        for (let i = 0; i < n; i++) res[i] = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
        return res;
    }

    function schedule(samples, gain, rate = 1) {
        if (!S.ctx) return;
        const buf = S.ctx.createBuffer(1, samples.length, 24000);
        buf.getChannelData(0).set(samples);
        const src = S.ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;
        const g = S.ctx.createGain(); g.gain.value = gain;
        src.connect(g); g.connect(S.out);
        const when = Math.max(S.playHead, S.ctx.currentTime + 0.05);
        src.start(when);
        S.sources.push(src);
        src.onended = () => { S.sources = S.sources.filter(x => x !== src); };
        S.playHead = when + buf.duration / rate;
        diagLog(`son planifié : départ dans ${(when - S.ctx.currentTime).toFixed(2)} s, durée ${(buf.duration / rate).toFixed(2)} s, ${S.sources.length} en file`);
    }

    // Fin de réponse : quand tout est lu, retour à l'écoute
    function watchEnd(gen) {
        const tick = () => {
            if (gen !== S.gen || !S.ctx) return;
            if (S.llmDone && S.ttsPending === 0 && S.ctx.currentTime >= S.playHead - 0.05 && S.sources.length === 0) {
                setState(S.recording ? 'user' : 'idle');
                return;
            }
            setTimeout(tick, 120);
        };
        tick();
    }

    // L'utilisateur parle par-dessus : elle se tait, la réponse en cours est abandonnée
    function interrupt() {
        diagLog('interruption');
        const spokenSoFar = S.spoken.trim();
        S.gen++;
        try { S.llmAbort && S.llmAbort.abort(); } catch (e) { /* déjà fini */ }
        try { S.voiceAbort && S.voiceAbort.abort(); } catch (e) { /* déjà fini */ }
        S.voiceChain = Promise.resolve();
        for (const src of S.sources) { try { src.stop(); } catch (e) { /* déjà arrêtée */ } }
        S.sources = []; S.playHead = 0; S.bcUntil = 0;
        // L'historique garde ce qu'elle a eu le temps de dire, marqué comme coupé
        if (S.history.length && S.history[S.history.length - 1].role === 'user') {
            S.history.push({ role: 'assistant', content: spokenSoFar ? spokenSoFar + ' […coupée par l\'utilisateur]' : '[n\'a pas eu le temps de répondre]' });
        } else if (S.history.length && spokenSoFar) {
            S.history[S.history.length - 1].content = spokenSoFar + ' […coupée par l\'utilisateur]';
        }
        S.llmDone = true; S.pendingText = ''; S.ttsPending = 0;
        face.setMouth(0, 0.5);
    }

    // ---------- Réactions pendant que l'utilisateur parle ----------
    async function prepareBackchannels() {
        for (const text of BACKCHANNELS) {
            if (!S.active) return;
            try {
                const res = await mistral('/v1/audio/speech', { method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + mistralKey() },
                    body: JSON.stringify({ model: TTS_MODEL, input: text, response_format: 'pcm', voice_id: voice().id, stream: true }) }, 2);
                if (!res.ok) { diagLog('réactions vocales abandonnées (' + res.status + ')'); return; }
                const parts = [];
                await readPcm(res, 'bc', (s) => parts.push(s));
                const total = parts.reduce((n, p) => n + p.length, 0);
                if (!total || !S.ctx) continue;
                const v = voice();
                const all = concat(parts), f = v.pitch / v.speed;
                // Les très courts textes donnent parfois plusieurs secondes de babillage : on écarte tout ce qui est trop long
                if (all.length > 24000 * 1.5 || all.length < 24000 * 0.12) { diagLog('réaction écartée (' + (all.length / 24000).toFixed(1) + ' s) : ' + text); continue; }
                S.bcBuffers.push(Math.abs(f - 1) > 0.03 ? timeStretch(all, f) : all);
            } catch (e) { /* tant pis : seulement les hochements */ }
            await sleep(2500);
        }
    }
    function playBackchannel(now) {
        S.lastBc = now;
        face.nod(1.3);
        if (!S.bcBuffers.length || !S.ctx) return;
        const samples = S.bcBuffers[Math.floor(Math.random() * S.bcBuffers.length)];
        const before = S.playHead;
        S.playHead = 0;
        schedule(samples, 0.55, voice().pitch);
        S.bcUntil = S.playHead + 0.25;
        S.playHead = before;   // n'empiète pas sur une réponse déjà programmée
    }

    // ---------- Bouche : analyse de la voix en sortie ----------
    const tdata = new Float32Array(1024);
    function lipSync() {
        requestAnimationFrame(lipSync);
        if (!S.analyser) { face.setMouth(0, 0.5); return; }
        S.analyser.getFloatTimeDomainData(tdata);
        let sum = 0, zc = 0;
        for (let i = 0; i < tdata.length; i++) { sum += tdata[i] * tdata[i]; if (i && (tdata[i] > 0) !== (tdata[i - 1] > 0)) zc++; }
        const rms = Math.sqrt(sum / tdata.length);
        const open = rms < 0.004 ? 0 : Math.min(1, rms * 7.5);
        const wide = Math.max(0, Math.min(1, (zc / tdata.length - 0.04) / 0.22 + 0.25));
        face.setMouth(open, wide);
    }
    lipSync();

    // ---------- Caresses sur les oreilles : il réagit aussi de vive voix, de temps en temps ----------
    const PET_PHRASES = ['Hihi, ça chatouille !', 'Oh, j\'adore les caresses !', 'Mmh, c\'est tout doux.', 'Oh là là, continue !'];
    function attachPet(f) { if (f && typeof f.onPet === 'function') f.onPet(handlePet); }
    function handlePet() {
        const now = Date.now();
        if (!S.active || now - (S.lastPetSay || 0) < 25000) return;
        if (S.state === 'speaking' || S.state === 'thinking' || S.state === 'transcribing' || S.recording) return;
        S.lastPetSay = now;
        diagLog('caresse : réaction vocale');
        quickSay(PET_PHRASES[Math.floor(Math.random() * PET_PHRASES.length)]);
    }
    // Une phrase toute faite, sans passer par le modèle de réponse (pas de requête de chat)
    function quickSay(text) {
        if (!S.ctx || !S.active) return;
        const gen = ++S.gen;
        stopAllSounds();
        S.ttsPending = 0; S.voiceChain = Promise.resolve();
        S.spoken = ''; S.pendingText = ''; S.botText = text; S.llmDone = true;
        el.capBot.textContent = text;
        speak(gen, text);
        watchEnd(gen);
    }

    // ---------- Boutons ----------
    async function begin() {
        if (!mistralKey()) { el.capBot.textContent = 'Clé Mistral manquante : saisissez-la dans la configuration du harnais.'; return; }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { el.capBot.textContent = 'Ce navigateur ne permet pas d\'utiliser le micro ici.'; return; }
        newContext();                                    // dans le geste de l'utilisateur (iPhone)
        S.rebuilt = false; S.maxRms = 0; S.blocks = 0;
        try { await startMic(); } catch (e) { el.capBot.textContent = 'Micro refusé : autorisez-le puis réessayez.'; stopAudio(); return; }
        S.active = true; S.muted = false; S.history = []; S.bcBuffers = [];
        el.start.hidden = true; el.mute.hidden = el.cut.hidden = el.stop.hidden = false; el.note.hidden = true;
        el.capUser.textContent = ''; el.capBot.textContent = '';
        setState('idle');
        diagLog('--- ouverture · ' + navigator.userAgent);
        S.micTried = new Set();
        fillMicList();
        micWatch();
        clearInterval(S.meterTimer); S.meterTimer = setInterval(meterTick, 80);
        // Les petites réactions (« hm ») se préparent après le premier échange, pour ne pas peser sur le quota au départ
        S.bcStarted = false;
    }
    function end() {
        S.active = false;
        clearTimeout(S.micTimer); clearInterval(S.meterTimer); el.meter.style.width = '0'; el.mic.textContent = ''; el.micsel.hidden = true;
        interrupt();
        stopAudio();
        S.recording = false; S.chunks = []; S.preroll = [];
        el.start.hidden = false; el.mute.hidden = el.cut.hidden = el.stop.hidden = true; el.note.hidden = false;
        setState('idle');
    }
    el.micsel.addEventListener('change', () => {
        micChoice = el.micsel.value;
        try { localStorage.setItem('avatar-micro', micChoice); } catch (e) { /* stockage indisponible */ }
        S.micTried = new Set([micChoice]); S.rebuilt = false; S.maxRms = 0;
        reopenMic().then(micWatch);
    });
    el.start.addEventListener('click', begin);
    el.stop.addEventListener('click', end);
    el.cut.addEventListener('click', () => { if (S.state === 'speaking' || S.state === 'thinking') { interrupt(); setState('idle'); } });
    el.face.addEventListener('click', () => { if (S.active && (S.state === 'speaking' || S.state === 'thinking')) { interrupt(); setState('idle'); } });
    el.mute.addEventListener('click', () => {
        S.muted = !S.muted;
        el.mute.setAttribute('aria-pressed', String(S.muted));
        el.mute.textContent = S.muted ? 'Réactiver le micro' : 'Couper le micro';
        if (S.muted && S.recording) { S.recording = false; S.chunks = []; }
        setState(S.state === 'user' && S.muted ? 'idle' : S.state);
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ctx && S.ctx.state !== 'running') { try { S.ctx.resume(); } catch (e) { /* repris au toucher */ } } });

    // Accès pour les essais (?test) : simule une phrase de l'utilisateur sans micro
    window.avatar = { say, state: S, begin, end, newContext, watchEnd, face: () => face };
})();
