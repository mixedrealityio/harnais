// live.js — conversation vocale continue (façon « Live ») : on parle, il répond à voix haute,
// on peut lui couper la parole. Écoute par détection de voix, transcription (Mistral par défaut),
// envoi par sendMessage, réponse lue phrase par phrase par la voix du système pendant qu'elle s'écrit.

(function () {
    const liveBtn = document.getElementById('live-btn');
    if (!liveBtn) return;

    // Réponses pensées pour l'oral, ajoutées aux instructions le temps du mode Live
    const VOICE_INSTRUCTIONS = "# Conversation vocale\nL'utilisateur te parle à voix haute et ta réponse lui est lue par une synthèse vocale. "
        + "Réponds comme à l'oral : phrases courtes et naturelles, deux à quatre phrases en général, sans Markdown, "
        + "sans listes, tableaux, titres, code, liens ni émojis. S'il veut plus de détails, il te le demandera.";

    // Détection de voix (niveaux RMS de blocs de 2048 échantillons, ~43 ms à 48 kHz)
    const BLOCK = 2048;
    const PREROLL_BLOCKS = 20;      // ~0,9 s gardées avant la détection : premières syllabes, détection plus lente en coupure de parole
    const START_BLOCKS = 3;         // ~130 ms au-dessus du seuil pour commencer
    const START_BLOCKS_BARGE = 7;   // 7 blocs sur les 10 derniers (~0,4 s) pendant qu'il parle : son écho ne doit pas l'interrompre
    const END_SILENCE_MS = 1000;    // fin de phrase après 1 s de silence
    const MIN_SPEECH_MS = 350;      // plus court : bruit, ignoré
    const MAX_SPEECH_MS = 60000;
    const DIAG = /[?&]diag\b/.test(location.search);  // ?diag : niveaux du micro affichés en direct
    // ?diag : mesures aussi envoyées au VPS toutes les 2 s (~/.cache/harnais-diag-live.log), sans avoir à les lire à l'écran
    const diagLines = [];
    let diagPeak = 0;
    function diagLog(msg) {
        if (DIAG) diagLines.push(new Date().toISOString().slice(11, 23) + ' ' + msg);
    }
    if (DIAG) setInterval(() => {
        if (!diagLines.length) return;
        fetch('diag-live', { method: 'POST', body: diagLines.splice(0).join('\n'), keepalive: true, credentials: 'same-origin' }).catch(() => {});
    }, 2000);

    const state = {
        active: false, phase: 'off', muted: false,
        stream: null, ctx: null, source: null, proc: null, sink: null,
        floor: 0.004, hits: [], blocks: 0, maxRms: 0, micTimer: null, rebuilt: false, recording: false, chunks: [], preroll: [], lastVoiceAt: 0, speechStart: 0,
        assistantEl: null, spokenLen: 0, speakQueue: 0, voiceGen: 0, voiceChain: Promise.resolve(), voiceAbort: null, voiceSources: [], playHead: 0, watch: null, wakeLock: null,
    };

    // --- Écran Live ---
    const overlay = document.createElement('div');
    overlay.className = 'live-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
        <div class="live-stage">
            <div class="live-orb"><img src="images/DavidTwentyAI.png" alt=""></div>
            <p class="live-status" aria-live="polite"></p>
            <p class="live-caption"></p>
        </div>
        <div class="live-controls">
            <button type="button" class="live-mute" aria-pressed="false" title="Couper le micro">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><line class="live-mute-slash" x1="3" y1="3" x2="21" y2="21"/></svg>
            </button>
            <button type="button" class="live-end" title="Terminer">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
            </button>
        </div>`;
    document.body.appendChild(overlay);
    const orb = overlay.querySelector('.live-orb');
    const statusEl = overlay.querySelector('.live-status');
    const captionEl = overlay.querySelector('.live-caption');
    const muteBtn = overlay.querySelector('.live-mute');

    const STATUS = {
        ecoute: 'Je vous écoute…',
        capte: 'Je vous écoute…',
        transcription: 'Je réfléchis…',
        reflexion: 'Je réfléchis…',
        parole: 'Parlez pour m\'interrompre',
        paroleToucher: 'Touchez le lapin pour m\'interrompre',
        muet: 'Micro coupé',
    };
    function setPhase(p) {
        if (state.phase !== p) diagLog('phase ' + p);
        state.phase = p;
        overlay.dataset.phase = state.muted && p === 'ecoute' ? 'muet' : p;
        // iPhone avec la voix de l'appareil : iOS coupe le micro pendant qu'elle parle, on ne l'interrompt qu'au toucher
        const touchOnly = p === 'parole' && IOS && !useVoxtral();
        statusEl.textContent = STATUS[touchOnly ? 'paroleToucher' : overlay.dataset.phase] || '';
    }
    const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    // --- Voix : Voxtral (Mistral) jouée dans le contexte audio du micro, sinon celle de l'appareil (voix.js) ---
    // La voix de l'appareil fait couper le micro par iOS pendant qu'elle parle : plus de coupure de parole possible.
    // Jouée par le site dans le même contexte que le micro, iOS garde le micro ouvert avec l'annulation d'écho.
    const VOXTRAL_MODEL = 'voxtral-mini-tts-3-0';
    const VOXTRAL_VOICE = 'voice_592';   // Marie, comme la lecture à voix haute
    const VOXTRAL_LIVE = false;   // désactivé le temps d'essayer la voix de l'appareil avec interruption au toucher
    function useVoxtral() { return VOXTRAL_LIVE && !!(typeof API_KEYS !== 'undefined' && API_KEYS.mistral); }
    function speak(text) {
        text = text.replace(/[*_`#>|~]+/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
        if (!text) return;
        if (useVoxtral() && state.ctx) return speakVoxtral(text);
        if (!window.speechSynthesis) return;
        const u = new SpeechSynthesisUtterance(text);
        const voice = getSystemVoice();
        u.lang = voice?.lang || 'fr-FR';
        if (voice) u.voice = voice;
        u.rate = 1.05;
        state.speakQueue++;
        diagLog('voix demandée : ' + text.slice(0, 50));
        u.onstart = () => diagLog('voix commence');
        u.onend = u.onerror = (e) => { diagLog('voix ' + e.type + (e.error ? ' ' + e.error : '')); state.speakQueue = Math.max(0, state.speakQueue - 1); };
        // iPhone : une lecture restée bloquée (déverrouillage à l'ouverture) retient toute la file, on la vide d'abord
        if (state.speakQueue === 1 && (speechSynthesis.speaking || speechSynthesis.pending)) {
            diagLog('voix bloquée vidée');
            speechSynthesis.cancel();
            setTimeout(() => speechSynthesis.speak(u), 100);   // parler juste après cancel est parfois ignoré
            return;
        }
        speechSynthesis.speak(u);
    }
    // Phrases lues dans l'ordre : chacune est demandée en flux et ses morceaux sont calés à la suite sur playHead
    function speakVoxtral(text) {
        state.speakQueue++;
        diagLog('voix Voxtral demandée : ' + text.slice(0, 50));
        const gen = state.voiceGen;
        state.voiceChain = state.voiceChain.then(() => gen === state.voiceGen && streamVoxtral(text, gen)).catch((err) => {
            diagLog('voix Voxtral erreur : ' + (err && err.message ? err.message.slice(0, 160) : err));
            if (gen === state.voiceGen) captionEl.textContent = 'Voix Mistral indisponible : ' + (err && err.message ? err.message.slice(0, 100) : err);
        }).finally(() => {
            // La phrase compte comme lue quand son dernier morceau a fini de jouer
            const left = state.ctx ? Math.max(0, state.playHead - state.ctx.currentTime) : 0;
            setTimeout(() => { if (gen === state.voiceGen) state.speakQueue = Math.max(0, state.speakQueue - 1); }, left * 1000 + 50);
        });
    }
    async function streamVoxtral(text, gen) {
        const abort = new AbortController();
        state.voiceAbort = abort;
        const response = await fetch('https://api.mistral.ai/v1/audio/speech', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEYS.mistral}` },
            body: JSON.stringify({ model: VOXTRAL_MODEL, input: text, response_format: 'pcm', voice_id: VOXTRAL_VOICE, stream: true }),
            signal: abort.signal
        });
        if (!response.ok) throw new Error(`Mistral ${response.status} : ${(await response.text()).slice(0, 200)}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', first = true;
        while (gen === state.voiceGen) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ') || gen !== state.voiceGen) continue;
                let evt;
                try { evt = JSON.parse(line.slice(6).trim()); } catch (e) { continue; }
                if (!evt.audio_data) continue;
                // PCM float 32 bits, 24 kHz, mono
                const raw = atob(evt.audio_data);
                const bytes = new Uint8Array(raw.length);
                for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                const samples = new Float32Array(bytes.buffer, 0, Math.floor(bytes.length / 4));
                if (!samples.length || !state.ctx) continue;
                const abuf = state.ctx.createBuffer(1, samples.length, 24000);
                abuf.getChannelData(0).set(samples);
                const src = state.ctx.createBufferSource();
                src.buffer = abuf;
                src.connect(state.ctx.destination);
                const when = Math.max(state.playHead, state.ctx.currentTime + 0.05);
                src.start(when);
                state.voiceSources.push(src);
                src.onended = () => { state.voiceSources = state.voiceSources.filter(x => x !== src); };
                state.playHead = when + abuf.duration;
                if (first) { first = false; diagLog('voix Voxtral commence'); }
            }
        }
        try { reader.cancel(); } catch (e) {}
    }
    function stopSpeaking() {
        diagLog('voix arrêtée');
        state.speakQueue = 0;
        // Voxtral : flux abandonnés, morceaux déjà calés arrêtés
        state.voiceGen++;
        state.voiceChain = Promise.resolve();
        try { state.voiceAbort && state.voiceAbort.abort(); } catch (e) {}
        for (const src of state.voiceSources) { try { src.stop(); } catch (e) {} }
        state.voiceSources = [];
        state.playHead = 0;
        try { window.speechSynthesis && speechSynthesis.cancel(); } catch (e) { /* rien à arrêter */ }
    }

    // --- Micro et détection de voix ---
    async function startMic() {
        state.stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
        });
        if (DIAG) state.stream.getTracks().forEach(t => {
            diagLog('micro ' + t.label + ' ' + t.readyState + (t.muted ? ' muet' : ''));
            t.onmute = () => diagLog('micro MUET (coupé par le système)');
            t.onunmute = () => diagLog('micro rétabli');
            t.onended = () => diagLog('micro TERMINÉ');
        });
        if (!state.ctx) newContext();
        try { await state.ctx.resume(); } catch (e) { /* repris au prochain toucher */ }
        connectGraph();
    }
    // iPhone : le contexte audio doit naître dans le geste de l'utilisateur, avant toute attente
    function newContext() {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        state.ctx = new Ctx();
        if (DIAG) { diagLog('contexte audio ' + state.ctx.state); state.ctx.onstatechange = (e) => diagLog('contexte audio ' + e.target.state); }
        try { state.ctx.resume(); } catch (e) {}
    }
    function connectGraph() {
        state.source = state.ctx.createMediaStreamSource(state.stream);
        state.proc = state.ctx.createScriptProcessor(BLOCK, 1, 1);
        state.sink = state.ctx.createGain();
        state.sink.gain.value = 0;   // le traitement ne tourne que relié à la sortie, mais sans bruit
        state.source.connect(state.proc);
        state.proc.connect(state.sink);
        state.sink.connect(state.ctx.destination);
        state.proc.onaudioprocess = onAudio;
    }
    function disconnectGraph() {
        try { state.proc && (state.proc.onaudioprocess = null); } catch (e) {}
        try { state.source && state.source.disconnect(); state.proc && state.proc.disconnect(); state.sink && state.sink.disconnect(); } catch (e) {}
    }
    // Rien reçu ou silence complet : contexte recréé une fois (contourne les blocages de Safari)
    function micWatchdog() {
        clearTimeout(state.micTimer);
        state.micTimer = setTimeout(() => {
            if (!state.active || !state.stream) return;
            if (state.blocks === 0 || state.maxRms === 0) {
                if (!state.rebuilt) {
                    state.rebuilt = true;
                    disconnectGraph();
                    try { state.ctx.close(); } catch (e) {}
                    newContext();
                    connectGraph();
                    micWatchdog();
                    return;
                }
                captionEl.textContent = state.blocks === 0
                    ? 'Le son du micro n\'arrive pas. Touchez le lapin, ou fermez et rouvrez le mode Live.'
                    : 'Le micro n\'envoie que du silence. Vérifiez qu\'aucune autre app ne l\'utilise.';
            } else if (state.maxRms < 0.006) {
                captionEl.textContent = 'Je vous entends à peine : parlez plus près du téléphone.';
            }
        }, 2500);
    }
    function stopMic() {
        clearTimeout(state.micTimer);
        try { state.proc && (state.proc.onaudioprocess = null); } catch (e) {}
        try { state.source && state.source.disconnect(); state.proc && state.proc.disconnect(); state.sink && state.sink.disconnect(); } catch (e) {}
        try { state.ctx && state.ctx.close(); } catch (e) {}
        try { state.stream && state.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
        state.stream = state.ctx = state.source = state.proc = state.sink = null;
    }

    function onAudio(e) {
        if (!state.active) return;
        const data = new Float32Array(e.inputBuffer.getChannelData(0));
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();
        const botTalking = state.phase === 'parole' || state.speakQueue > 0;  // speechSynthesis.speaking peut rester vrai à tort sur iPhone
        // Seuil au-dessus du bruit de fond ; plus haut pendant qu'il parle (écho du haut-parleur)
        const threshold = botTalking ? Math.max(0.02, state.floor * 5) : Math.max(0.006, state.floor * 3);
        orb.style.setProperty('--level', Math.min(1, rms * 15).toFixed(3));
        state.blocks++;
        if (rms > state.maxRms) state.maxRms = rms;
        if (rms > diagPeak) diagPeak = rms;
        if (DIAG && state.blocks % 5 === 0) {
            diagLog(`blocs ${state.blocks} · pic ${diagPeak.toFixed(4)} · seuil ${threshold.toFixed(4)} · fond ${state.floor.toFixed(4)} · ${botTalking ? 'IA parle' : 'IA muette'} · ${state.phase} · touches ${state.hits.reduce((a, b) => a + b, 0)} · ${state.ctx.state}`);
            diagPeak = 0;
        }
        if (DIAG) captionEl.textContent = `niveau ${rms.toFixed(4)} · seuil ${threshold.toFixed(4)} · fond ${state.floor.toFixed(4)} · ${state.ctx.state} ${state.ctx.sampleRate} Hz · blocs ${state.blocks}`;

        if (state.recording) {
            state.chunks.push(data);
            if (rms > threshold * 0.6) state.lastVoiceAt = now;
            const long = now - state.speechStart > MAX_SPEECH_MS;
            if (now - state.lastVoiceAt > END_SILENCE_MS || long) finishUtterance();
            return;
        }
        state.preroll.push(data);
        if (state.preroll.length > PREROLL_BLOCKS) state.preroll.shift();
        if (state.muted || state.phase === 'transcription') { state.hits = []; return; }

        // Fenêtre glissante : les petites pauses entre syllabes ne remettent pas le compte à zéro
        state.hits.push(rms > threshold ? 1 : 0);
        if (state.hits.length > 10) state.hits.shift();
        const hits = state.hits.reduce((a, b) => a + b, 0);
        const barge = botTalking || state.phase === 'reflexion';
        if (rms > threshold ? hits >= (barge ? START_BLOCKS_BARGE : START_BLOCKS) : false) startUtterance(now);
        else if (rms <= threshold && !botTalking) state.floor = state.floor * 0.95 + rms * 0.05;
    }

    function startUtterance(now) {
        diagLog('début de parole détecté (phase ' + state.phase + ')');
        // Coupure de parole : il se tait et abandonne sa réponse en cours
        if (state.phase === 'parole' || state.phase === 'reflexion') {
            stopSpeaking();
            stopWatching();
            if (typeof isStreaming !== 'undefined' && isStreaming && typeof stopGeneration === 'function') stopGeneration();
        }
        state.recording = true;
        state.chunks = state.preroll.slice();
        state.preroll = [];
        state.speechStart = state.lastVoiceAt = now;
        state.hits = [];
        captionEl.textContent = '';
        setPhase('capte');
    }

    function finishUtterance() {
        state.recording = false;
        const chunks = state.chunks;
        state.chunks = [];
        const rate = state.ctx ? state.ctx.sampleRate : 48000;
        const ms = chunks.length * BLOCK / rate * 1000;
        diagLog('fin de parole : ' + Math.round(ms) + ' ms enregistrées');
        if (ms < MIN_SPEECH_MS + PREROLL_BLOCKS * BLOCK / rate * 1000) { setPhase('ecoute'); return; }
        setPhase('transcription');
        transcribeAudio(toWav(chunks, rate), (text) => {
            if (!state.active) return;
            text = (text || '').trim();
            diagLog('transcription : « ' + text.slice(0, 80) + ' »');
            if (!text) { setPhase('ecoute'); return; }
            captionEl.textContent = '« ' + text + ' »';
            send(text);
        }, (err) => {
            if (!state.active) return;
            captionEl.textContent = 'Transcription impossible : ' + (err && err.message ? err.message.slice(0, 120) : err);
            setPhase('ecoute');
        }, sttModelId());
    }

    // Mono 16 kHz, 16 bits : léger à envoyer, suffisant pour la voix
    function toWav(chunks, rate) {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const ratio = rate / 16000;
        const outLen = Math.floor(total / ratio);
        const pcm = new Int16Array(outLen);
        let ci = 0, offset = 0;
        for (let i = 0; i < outLen; i++) {
            let idx = Math.floor(i * ratio) - offset;
            while (ci < chunks.length && idx >= chunks[ci].length) { offset += chunks[ci].length; idx -= chunks[ci].length; ci++; }
            const s = ci < chunks.length ? chunks[ci][idx] : 0;
            pcm[i] = Math.max(-1, Math.min(1, s)) * 0x7fff;
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

    // Transcription choisie dans Configuration, sinon Voxtral (Mistral) si la clé est là
    function sttModelId() {
        if (AUDIO_SETTINGS.sttProvider) return AUDIO_SETTINGS.sttProvider;
        if (API_KEYS.mistral) return 'voxtral-mini-transcribe-3-0';
        if (API_KEYS.google) return 'gemini-3.5-transcribe';
        return 'gpt-transcribe';
    }

    // --- Envoi et lecture de la réponse au fil de l'eau ---
    function send(text) {
        if (!currentModel) {
            captionEl.textContent = 'Choisissez d\'abord un modèle dans le sélecteur, puis relancez le mode Live.';
            setPhase('ecoute');
            return;
        }
        const before = document.querySelectorAll('.message-assistant').length;
        sendMessage({ text });
        setPhase('reflexion');
        state.assistantEl = null;
        state.spokenLen = 0;
        const startedAt = Date.now();
        stopWatching();
        state.watch = setInterval(() => {
            if (!state.active) return stopWatching();
            const all = document.querySelectorAll('.message-assistant');
            if (!state.assistantEl) {
                if (all.length > before) state.assistantEl = all[all.length - 1];
                else if (!isStreaming && Date.now() - startedAt > 4000) {
                    // Rien n'est parti (fenêtre de confirmation, erreur…) : on rend la main
                    captionEl.textContent = 'Le message n\'a pas pu être envoyé. Vérifiez l\'écran, puis reparlez.';
                    stopWatching(); setPhase('ecoute'); return;
                } else return;
            }
            const textEl = state.assistantEl.querySelector('.message-text') || state.assistantEl;
            // Sans « Génération en cours… », état de recherche ni réflexion : seulement la réponse
            let full = textEl.innerText || '';
            textEl.querySelectorAll('.generation-placeholder, .stream-status, .thinking-block, details').forEach(el => {
                const t = el.innerText;
                if (t) full = full.replace(t, '');
            });
            const done = !isStreaming;
            // Phrases complètes seulement, sauf la fin une fois la réponse terminée
            const rest = full.slice(state.spokenLen);
            const m = done ? rest : (rest.match(/^[\s\S]*[.!?…:;\n](?=\s|$)/) || [''])[0];
            if (m.trim()) {
                speak(m);
                setPhase('parole');
            }
            state.spokenLen += m.length;
            const deviceTalking = !useVoxtral() && window.speechSynthesis && (speechSynthesis.speaking || speechSynthesis.pending);
            if (done && state.speakQueue === 0 && !deviceTalking) {
                stopWatching();
                setPhase('ecoute');
            }
        }, 150);
    }
    function stopWatching() {
        if (state.watch) { clearInterval(state.watch); state.watch = null; }
    }

    // --- Ouverture / fermeture ---
    let originalInstructions = null;
    async function open() {
        if (state.active) return;
        if (!navigator.mediaDevices?.getUserMedia) {
            customAlert('Ce navigateur ne permet pas d\'utiliser le micro ici.');
            return;
        }
        // Dans le geste de l'utilisateur : déverrouille la synthèse vocale (iPhone)
        if (window.speechSynthesis && !useVoxtral()) {
            // Un texte réel : une phrase vide ne se termine jamais sur iPhone et bloque la voix
            const unlock = new SpeechSynthesisUtterance('ok');
            unlock.volume = 0;
            unlock.rate = 2;
            speechSynthesis.speak(unlock);
        }
        diagLog('--- ouverture Live · ' + navigator.userAgent);
        newContext();
        state.blocks = 0; state.maxRms = 0; state.rebuilt = false; state.floor = 0.004; state.hits = [];
        overlay.hidden = false;
        document.body.classList.add('live-open');
        captionEl.textContent = '';
        state.active = true;
        state.muted = false;
        muteBtn.setAttribute('aria-pressed', 'false');
        setPhase('ecoute');
        statusEl.textContent = 'Ouverture du micro…';
        try {
            await startMic();
        } catch (err) {
            captionEl.textContent = 'Micro inaccessible : autorisez-le pour ce site dans les réglages du navigateur.';
            state.active = false;
            setTimeout(close, 2500);
            return;
        }
        setPhase('ecoute');
        micWatchdog();
        if (originalInstructions === null) {
            originalInstructions = loadCustomInstructions;
            loadCustomInstructions = () => [originalInstructions().trim(), VOICE_INSTRUCTIONS].filter(Boolean).join('\n\n');
        }
        try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) { /* écran qui peut s'éteindre */ }
    }
    function close() {
        state.active = false;
        state.recording = false;
        stopWatching();
        stopSpeaking();
        stopMic();
        if (originalInstructions) { loadCustomInstructions = originalInstructions; originalInstructions = null; }
        try { state.wakeLock && state.wakeLock.release(); } catch (e) {}
        state.wakeLock = null;
        overlay.hidden = true;
        document.body.classList.remove('live-open');
        setPhase('off');
    }

    liveBtn.addEventListener('click', open);
    overlay.querySelector('.live-end').addEventListener('click', close);
    muteBtn.addEventListener('click', () => {
        state.muted = !state.muted;
        muteBtn.setAttribute('aria-pressed', String(state.muted));
        if (state.muted && state.recording) { state.recording = false; state.chunks = []; }
        if (state.phase === 'ecoute' || state.phase === 'capte') setPhase('ecoute');
    });
    // Taper sur le lapin pendant qu'il parle : il se tait et écoute
    overlay.addEventListener('pointerdown', () => { try { state.ctx && state.ctx.state !== 'running' && state.ctx.resume(); } catch (e) {} });
    orb.addEventListener('click', () => {
        if (state.ctx && state.ctx.state !== 'running') { state.ctx.resume(); return; }
        if (state.phase === 'parole' || state.phase === 'reflexion') {
            stopSpeaking(); stopWatching();
            if (isStreaming) stopGeneration();
            setPhase('ecoute');
        }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.active) close(); });
    // Application mise en arrière-plan : micro et voix coupés
    document.addEventListener('visibilitychange', () => { if (document.hidden && state.active) close(); });
})();
