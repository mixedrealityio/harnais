// avatar.js — conversation vocale « full duplex » avec un avatar animé.
// Le micro reste ouvert pendant que Marie parle : on peut l'interrompre à la voix, et elle réagit pendant
// qu'on parle (hochements, « hm », « d'accord »). Chaîne : micro → transcription Voxtral → Ministral → voix Marie en flux.
(function () {
    'use strict';

    // ---------- Réglages ----------
    const CHAT_MODEL = 'ministral-8b-latest';
    const STT_MODEL = 'voxtral-mini-latest';
    const TTS_MODEL = 'voxtral-mini-tts-2603';
    const TTS_VOICE = 'fr_marie_neutral';
    const BLOCK = 2048;                  // blocs du micro (~43 ms à 48 kHz)
    const PREROLL_BLOCKS = 14;           // ~0,6 s gardées avant la détection
    const START_BLOCKS = 3;              // début de parole : 3 blocs sur 10 au-dessus du seuil
    const START_BLOCKS_BARGE = 7;        // pendant qu'elle parle : 7 sur 10 (l'écho ne doit pas l'interrompre)
    const END_SILENCE_MS = 800;          // fin de tour après 0,8 s de silence
    const MIN_SPEECH_MS = 300;
    const MAX_SPEECH_MS = 60000;
    const BC_MIN_SPEECH_MS = 4000;       // réaction « hm » seulement quand on parle depuis un moment
    const BC_PAUSE_MIN = 380, BC_PAUSE_MAX = 620;
    const BC_GAP_MS = 7000;
    const HISTORY_MAX = 24;
    const BACKCHANNELS = ['Hm.', 'D\'accord.', 'Je vois.'];

    const SYSTEM_PROMPT = [
        'Tu es Marie, une interlocutrice vocale chaleureuse et naturelle. Tu parles français, à l\'oral, en face à face avec une personne.',
        'Réponds en une à trois phrases courtes, comme dans une vraie conversation : pas de liste, pas de markdown, pas d\'emoji, pas de symbole.',
        'Écris tout ce qui se dit à voix haute en toutes lettres : « onze à douze degrés », « vingt-trois pour cent ».',
        'Tu peux réagir brièvement (« ah oui ? », « d\'accord ») et poser une question de relance, mais jamais plusieurs à la fois.',
        'Si la personne t\'a interrompue, reprends simplement avec ce qu\'elle vient de dire. Quand des résultats de recherche web te sont fournis, appuie-toi dessus en une ou deux phrases : ne lis jamais d\'adresse, de numéro de source ni de liste de liens, cite au besoin le nom du site. Sans résultats fournis, tu n\'as pas accès à Internet : dis-le si on te demande une information récente.'
    ].join(' ');

    // ---------- Éléments ----------
    const $ = (id) => document.getElementById(id);
    const el = { face: $('face'), status: $('status'), capUser: $('cap-user'), capBot: $('cap-bot'),
        head: $('head'), diag: $('diag'), start: $('start'), mute: $('mute'), cut: $('cut'), stop: $('stop'), note: $('note') };
    const HEADS = { lapin: window.AvatarRabbit, marie: window.AvatarFace };
    const HEAD_LABEL = { lapin: 'Tête : lapin', marie: 'Tête : Marie' };
    let headName = (function () { try { return localStorage.getItem('avatar-tete') || 'lapin'; } catch (e) { return 'lapin'; } })();
    if (!HEADS[headName]) headName = 'lapin';
    let face = HEADS[headName](el.face);
    el.head.textContent = HEAD_LABEL[headName];
    el.head.addEventListener('click', () => {
        headName = headName === 'lapin' ? 'marie' : 'lapin';
        try { localStorage.setItem('avatar-tete', headName); } catch (e) { /* stockage indisponible */ }
        face.stop(); face = HEADS[headName](el.face);
        face.setState(S.state === 'transcribing' ? 'thinking' : S.state);
        el.head.textContent = HEAD_LABEL[headName];
    });
    const STATUS = { idle: '', user: 'Je vous écoute', transcribing: '…', thinking: 'Je réfléchis', speaking: 'Marie parle' };

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
        floor: 0.004, hits: [], preroll: [], chunks: [], recording: false, speechStart: 0, lastVoiceAt: 0,
        lastBc: 0, bcUntil: 0, bcBuffers: [], lastNod: 0,
        history: [], gen: 0, llmAbort: null, voiceChain: Promise.resolve(), voiceAbort: null, sources: [], playHead: 0,
        spoken: '', pendingText: '', llmDone: true, botText: '', blocks: 0
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
        // Sortie unique : tout ce que Marie dit passe par là (analyse de la bouche)
        S.out = S.ctx.createGain();
        S.analyser = S.ctx.createAnalyser();
        S.analyser.fftSize = 1024;
        S.out.connect(S.analyser);
        S.analyser.connect(S.ctx.destination);
    }
    async function startMic() {
        S.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
        S.source = S.ctx.createMediaStreamSource(S.stream);
        S.proc = S.ctx.createScriptProcessor(BLOCK, 1, 1);
        S.sink = S.ctx.createGain(); S.sink.gain.value = 0;
        S.source.connect(S.proc); S.proc.connect(S.sink); S.sink.connect(S.ctx.destination);
        S.proc.onaudioprocess = onAudio;
    }
    function stopAudio() {
        try { S.proc && (S.proc.onaudioprocess = null); } catch (e) { /* déjà arrêté */ }
        try { S.source && S.source.disconnect(); S.proc && S.proc.disconnect(); S.sink && S.sink.disconnect(); } catch (e) { /* déjà arrêté */ }
        try { S.stream && S.stream.getTracks().forEach(t => t.stop()); } catch (e) { /* déjà arrêté */ }
        try { S.ctx && S.ctx.close(); } catch (e) { /* déjà arrêté */ }
        S.ctx = S.stream = S.source = S.proc = S.sink = S.out = S.analyser = null;
    }
    const botTalking = () => S.state === 'speaking' || (S.ctx && S.ctx.currentTime < S.bcUntil);

    // Sans micro (écho de Marie en cas de mauvaise annulation) : seuil plus haut pendant qu'elle parle
    function onAudio(e) {
        if (!S.active) return;
        const data = new Float32Array(e.inputBuffer.getChannelData(0));
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();
        S.blocks++;
        const talking = botTalking();
        const threshold = talking ? Math.max(0.02, S.floor * 5) : Math.max(0.006, S.floor * 3);
        if (S.muted) { S.hits = []; return; }
        face.setListenLevel(S.recording && !talking ? rms * 14 : 0);

        if (S.recording) {
            S.chunks.push(data);
            const bcPlaying = S.ctx.currentTime < S.bcUntil;
            if (rms > threshold * (bcPlaying ? 1.8 : 0.6)) S.lastVoiceAt = now;
            const pause = now - S.lastVoiceAt, dur = now - S.speechStart;
            // Il hoche la tête dès qu'on marque une pause, et réagit à voix basse quand on parle longtemps
            if (pause > 250 && pause < 700 && now - S.lastNod > 2200) { S.lastNod = now; face.nod(0.8); }
            if (dur > BC_MIN_SPEECH_MS && pause > BC_PAUSE_MIN && pause < BC_PAUSE_MAX && now - S.lastBc > BC_GAP_MS && !bcPlaying) playBackchannel(now);
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
            diagLog('transcription : « ' + text.slice(0, 80) + ' »');
            el.capUser.textContent = '« ' + text + ' »';
            say(text);
        }).catch((err) => {
            if (!S.active) return;
            el.capUser.textContent = 'Transcription impossible : ' + String(err && err.message || err).slice(0, 120);
            setState('idle');
        });
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

    async function say(userText) {
        const gen = ++S.gen;
        S.history.push({ role: 'user', content: userText });
        if (S.history.length > HISTORY_MAX) S.history.splice(0, S.history.length - HISTORY_MAX);
        S.spoken = ''; S.pendingText = ''; S.botText = ''; S.llmDone = false;
        el.capBot.textContent = '';
        setState('thinking');
        const abort = new AbortController();
        S.llmAbort = abort;
        // Recherche web (Tavily, par le relais du serveur) seulement quand la question en a besoin
        const web = needsWeb(userText);
        if (web) { diagLog('recherche web'); el.capBot.textContent = 'Je cherche sur le web…'; }
        try {
            const res = await mistral(web ? '/mistral/v1/chat/completions' : '/v1/chat/completions', {
                method: 'POST', signal: abort.signal,
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + mistralKey() },
                body: JSON.stringify({ model: CHAT_MODEL, stream: true, max_tokens: 220, temperature: 0.7, ...(web ? { web_search: true, web_voice: true } : {}),
                    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...S.history] })
            }, 4, web ? '..' : 'https://api.mistral.ai');
            if (!res.ok) throw new Error('Mistral ' + res.status + (res.status === 429 ? ' : limite de requêtes, patientez un instant' : ''));
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
            if (gen !== S.gen) return;
            flushSpeech(gen, true);
            S.llmDone = true;
            S.history.push({ role: 'assistant', content: S.botText.trim() || '…' });
            watchEnd(gen);
            if (!S.bcStarted) { S.bcStarted = true; setTimeout(() => { if (S.active) prepareBackchannels(); }, 6000); }
        } catch (err) {
            if (gen !== S.gen || (err && err.name === 'AbortError')) return;
            diagLog('erreur réponse : ' + String(err && err.message || err).slice(0, 120));
            el.capBot.textContent = String(err && err.message || err).slice(0, 140);
            S.llmDone = true;
            setState('idle');
        }
    }

    // Phrases complètes envoyées à la voix ; la première part plus tôt (à la première virgule) pour répondre vite
    function onDelta(gen, delta) {
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
            const chunk = rest.slice(0, cut);
            rest = rest.slice(cut);
            speak(gen, chunk);
        }
        if (final && rest.trim()) { speak(gen, rest); rest = ''; }
        S.pendingText = rest;
    }

    // ---------- Voix Marie en flux, jouée dans le contexte du micro ----------
    function speak(gen, raw) {
        const text = cleanForSpeech(raw);
        if (!text || gen !== S.gen) return;
        S.spoken += text + ' ';
        if (S.state !== 'speaking') setState('speaking');
        S.voiceChain = S.voiceChain.then(() => gen === S.gen && streamTts(text, gen)).catch((err) => {
            diagLog('erreur voix : ' + String(err && err.message || err).slice(0, 120));
            if (gen === S.gen) el.capBot.textContent = 'Voix indisponible : ' + String(err && err.message || err).slice(0, 100);
        });
    }
    async function streamTts(text, gen) {
        const abort = new AbortController();
        S.voiceAbort = abort;
        const res = await mistral('/v1/audio/speech', {
            method: 'POST', signal: abort.signal,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + mistralKey() },
            body: JSON.stringify({ model: TTS_MODEL, input: text, response_format: 'pcm', voice_id: TTS_VOICE, stream: true })
        }, 3);
        if (!res.ok) throw new Error('Mistral ' + res.status);
        await readPcm(res, gen, (samples) => schedule(samples, 1));
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
    function schedule(samples, gain) {
        if (!S.ctx) return;
        const buf = S.ctx.createBuffer(1, samples.length, 24000);
        buf.getChannelData(0).set(samples);
        const src = S.ctx.createBufferSource();
        src.buffer = buf;
        const g = S.ctx.createGain(); g.gain.value = gain;
        src.connect(g); g.connect(S.out);
        const when = Math.max(S.playHead, S.ctx.currentTime + 0.05);
        src.start(when);
        S.sources.push(src);
        src.onended = () => { S.sources = S.sources.filter(x => x !== src); };
        S.playHead = when + buf.duration;
    }

    // Fin de réponse : quand tout est lu, retour à l'écoute
    function watchEnd(gen) {
        const tick = () => {
            if (gen !== S.gen || !S.ctx) return;
            if (S.llmDone && S.ctx.currentTime >= S.playHead - 0.05 && S.sources.length === 0) {
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
        S.llmDone = true; S.pendingText = '';
        face.setMouth(0, 0.5);
    }

    // ---------- Réactions pendant que l'utilisateur parle ----------
    async function prepareBackchannels() {
        for (const text of BACKCHANNELS) {
            if (!S.active) return;
            try {
                const res = await mistral('/v1/audio/speech', { method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + mistralKey() },
                    body: JSON.stringify({ model: TTS_MODEL, input: text, response_format: 'pcm', voice_id: TTS_VOICE, stream: true }) }, 2);
                if (!res.ok) { diagLog('réactions vocales abandonnées (' + res.status + ')'); return; }
                const parts = [];
                await readPcm(res, 'bc', (s) => parts.push(s));
                const total = parts.reduce((n, p) => n + p.length, 0);
                if (!total || !S.ctx) continue;
                const all = new Float32Array(total);
                let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
                S.bcBuffers.push(all);
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
        schedule(samples, 0.55);
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

    // ---------- Boutons ----------
    async function begin() {
        if (!mistralKey()) { el.capBot.textContent = 'Clé Mistral manquante : saisissez-la dans la configuration du harnais.'; return; }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { el.capBot.textContent = 'Ce navigateur ne permet pas d\'utiliser le micro ici.'; return; }
        newContext();                                    // dans le geste de l'utilisateur (iPhone)
        try { await startMic(); } catch (e) { el.capBot.textContent = 'Micro refusé : autorisez-le puis réessayez.'; stopAudio(); return; }
        S.active = true; S.muted = false; S.history = []; S.bcBuffers = [];
        el.start.hidden = true; el.mute.hidden = el.cut.hidden = el.stop.hidden = false; el.note.hidden = true;
        el.capUser.textContent = ''; el.capBot.textContent = '';
        setState('idle');
        diagLog('--- ouverture · ' + navigator.userAgent);
        // Les petites réactions (« hm ») se préparent après le premier échange, pour ne pas peser sur le quota au départ
        S.bcStarted = false;
    }
    function end() {
        S.active = false;
        interrupt();
        stopAudio();
        S.recording = false; S.chunks = []; S.preroll = [];
        el.start.hidden = false; el.mute.hidden = el.cut.hidden = el.stop.hidden = true; el.note.hidden = false;
        setState('idle');
    }
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
