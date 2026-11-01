// voix.js — choix de la voix de l'appareil (synthèse du navigateur), pour la lecture à voix haute et le mode Live

const SYSTEM_VOICE_KEY = 'davidtwentyai-voix-systeme';

function _frenchVoices() {
    const voices = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
    return voices.filter(v => /^fr(-|_|$)/i.test(v.lang));
}

// Voix choisie dans la Configuration, sinon la plus naturelle parmi les voix françaises installées
function getSystemVoice() {
    const fr = _frenchVoices();
    let saved = '';
    try { saved = localStorage.getItem(SYSTEM_VOICE_KEY) || ''; } catch (e) { /* stockage indisponible */ }
    const chosen = saved && fr.find(v => v.name === saved);
    if (chosen) return chosen;
    const score = v => (/premium|enhanced|amélioré|natural|neural/i.test(v.name) ? 4 : 0)
        + (/fr[-_]FR/i.test(v.lang) ? 2 : 0) + (/amélie|thomas|audrey|aurélie|google/i.test(v.name) ? 1 : 0);
    return fr.slice().sort((a, b) => score(b) - score(a))[0] || null;
}

(function () {
    const select = document.getElementById('system-voice');
    const testBtn = document.getElementById('system-voice-test');
    if (!select || !window.speechSynthesis) {
        const row = select && select.closest('.audio-setting-row');
        if (row) row.hidden = true;
        return;
    }
    function fill() {
        const fr = _frenchVoices();
        let saved = '';
        try { saved = localStorage.getItem(SYSTEM_VOICE_KEY) || ''; } catch (e) {}
        select.innerHTML = '';
        const auto = document.createElement('option');
        auto.value = '';
        auto.textContent = 'Automatique';
        select.appendChild(auto);
        fr.forEach(v => {
            const o = document.createElement('option');
            o.value = v.name;
            // Nom sans le préfixe « Microsoft » répété, avec la région
            o.textContent = v.name.replace(/^Microsoft\s+/i, '').replace(/\s+-\s+French.*$/i, '') + ' (' + v.lang + ')';
            select.appendChild(o);
        });
        select.value = fr.some(v => v.name === saved) ? saved : '';
    }
    fill();
    speechSynthesis.addEventListener?.('voiceschanged', fill);
    select.addEventListener('change', () => {
        try {
            if (select.value) localStorage.setItem(SYSTEM_VOICE_KEY, select.value);
            else localStorage.removeItem(SYSTEM_VOICE_KEY);
        } catch (e) {}
        testBtn?.click();
    });
    testBtn?.addEventListener('click', () => {
        speechSynthesis.cancel();
        const v = getSystemVoice();
        const u = new SpeechSynthesisUtterance('Bonjour, je suis DavidTwentyAI. Voici ma voix.');
        u.lang = v?.lang || 'fr-FR';
        if (v) u.voice = v;
        speechSynthesis.speak(u);
    });
})();
