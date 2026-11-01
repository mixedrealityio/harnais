// api.js — appels aux fournisseurs d'IA

// --- 1. Configuration & état global ---

let API_KEYS = {
    openai: '',
    anthropic: '',
    google: '',
    mistral: '',
    perplexity: '',
    deepseek: '',
    grok: '',
    zai: '',
    openrouter: '',
    ollama: '',         // URL du serveur, ex. http://localhost:11434
    lmstudio: ''        // URL du serveur, ex. http://localhost:1234
};

function isLocalEditeur(editeur) {
    return editeur === 'ollama' || editeur === 'lmstudio';
}

let MODELS = [];
let SEARCH_MODELS = [];
let IMAGE_MODELS = [];
let TARIFS = {};
let IMAGE_TARIFS = {};
let SEARCH_TARIFS = {};

// --- 2. Fonctions publiques utilitaires ---

function loadApiKeys() {
    try {
        const stored = localStorage.getItem('minou-apikeys');
        if (stored) {
            const parsed = JSON.parse(stored);
            // Ancienne clé `local` (URL partagée) répartie vers ollama ou lmstudio
            if (parsed.local && !parsed.ollama && !parsed.lmstudio) {
                if (/11434/.test(parsed.local)) parsed.ollama = parsed.local;
                else if (/1234/.test(parsed.local)) parsed.lmstudio = parsed.local;
                else parsed.ollama = parsed.local;
            }
            delete parsed.local;
            Object.assign(API_KEYS, parsed);
        }
    } catch (e) {
        console.warn('Lecture des clés API impossible (localStorage corrompu) :', e);
    }
    // Clés du serveur (config-cles.js) pour les champs que l'utilisateur n'a pas remplis
    const preset = window.DAVIDTWENTYAI_CLES || {};
    for (const k of Object.keys(API_KEYS)) if (!API_KEYS[k] && preset[k]) API_KEYS[k] = preset[k];
}

function saveApiKeys(keys) {
    Object.assign(API_KEYS, keys);
    localStorage.setItem('minou-apikeys', JSON.stringify(API_KEYS));
}

// --- Catalogue de modèles (prefs + cache OpenRouter) ---

function loadCatalogPrefs() {
    try {
        const s = localStorage.getItem('minou-catalog-prefs');
        if (s) return JSON.parse(s);
    } catch(e) {}
    return { disabled: [], orEnabled: [] };
}

function saveCatalogPrefs(prefs) {
    localStorage.setItem('minou-catalog-prefs', JSON.stringify(prefs));
}

// Un cache OpenRouter par onglet : la requête image ajoute ?output_modalities=image
function getOrCache(tabType = 'text') {
    try {
        const key = tabType === 'image' ? 'minou-or-cache-image' : 'minou-or-cache';
        const s = localStorage.getItem(key);
        if (s) return JSON.parse(s);
    } catch(e) {}
    return null;
}

function setOrCache(models, tabType = 'text') {
    const key = tabType === 'image' ? 'minou-or-cache-image' : 'minou-or-cache';
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), models }));
}

// Retire le préfixe fournisseur : "OpenAI: GPT-5.1-Codex-Mini" → "GPT-5.1-Codex-Mini"
function cleanOrModelLabel(name, id) {
    if (!name || !id) return name || '';
    const colonIdx = name.indexOf(':');
    if (colonIdx > 0 && colonIdx < 30) {
        const after = name.slice(colonIdx + 1).trim();
        // Un seul mot (« Relace: Search ») : ambigu sans son fabricant
        if (after && !/\s|\d/.test(after)) return name.slice(0, colonIdx).trim() + ' ' + after;
        if (after) return after;
    }
    // Préfixe mot à mot identique au slug fournisseur de l'id ("[~]editeur/modele")
    const provider = id.replace(/^~/, '').split('/')[0] || '';
    const providerNorm = provider.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!providerNorm) return name;
    const words = name.split(/\s+/);
    let acc = '';
    let stripCount = 0;
    for (let i = 0; i < words.length; i++) {
        acc += words[i].toLowerCase().replace(/[^a-z0-9]/g, '');
        if (acc === providerNorm) { stripCount = i + 1; break; }
        if (!providerNorm.startsWith(acc)) break;
    }
    if (stripCount > 0) {
        const stripped = words.slice(stripCount).join(' ').trim();
        if (stripped) return stripped;
    }
    return name;
}

// Prix image issus de /endpoints, à part du cache /models (qui renvoie souvent 0) ; TTL en lecture
const OR_IMG_PRICES_KEY = 'minou-or-image-prices';
const OR_IMG_PRICES_TTL_MS = 14 * 24 * 60 * 60 * 1000;
function _readOrImagePricesRaw() {
    try {
        const s = localStorage.getItem(OR_IMG_PRICES_KEY);
        if (s) return JSON.parse(s) || {};
    } catch(e) {}
    return {};
}
function getOrImagePrices() {
    const raw = _readOrImagePricesRaw();
    const now = Date.now();
    const out = {};
    for (const [id, v] of Object.entries(raw)) {
        if (typeof v === 'number') {
            // Ancien format sans ts : valeur gardée sans expiration, migrée à la prochaine écriture
            if (v > 0) out[id] = v;
        } else if (v && typeof v === 'object' && typeof v.price === 'number' && v.price > 0) {
            if (!v.ts || (now - v.ts) < OR_IMG_PRICES_TTL_MS) out[id] = v.price;
        }
    }
    return out;
}
function setOrImagePrice(modelId, price) {
    if (!modelId || !(price > 0)) return;
    const raw = _readOrImagePricesRaw();
    const existing = raw[modelId];
    const existingPrice = (typeof existing === 'number')
        ? existing
        : (existing && typeof existing.price === 'number' ? existing.price : null);
    const existingTs = (existing && typeof existing === 'object' && existing.ts) || 0;
    if (existingPrice === price && existingTs && (Date.now() - existingTs) < OR_IMG_PRICES_TTL_MS) return;
    raw[modelId] = { price, ts: Date.now() };
    try { localStorage.setItem(OR_IMG_PRICES_KEY, JSON.stringify(raw)); } catch(e) {}
}

function rebuildModelLists() {
    loadModels();
    // loadModels a réinitialisé MODELS : réinjecter les modèles locaux en cache
    if (typeof loadCachedLocalModels === 'function') loadCachedLocalModels();
    const prefs = loadCatalogPrefs();
    const orEnabled = new Set(prefs.orEnabled || []);
    if (orEnabled.size === 0) return;

    const buildMeta = (m) => ({
        id: m.id,
        // Libellé du cache déjà nettoyé : le nettoyer de nouveau ôtait le fabricant (« DeepSeek V4.1 Flash » → « V4.1 Flash »)
        label: /:/.test(m.label || '') ? cleanOrModelLabel(m.label, m.id) : m.label,
        editeur: 'openrouter',
        description: m.description || '',
        contextLength: m.contextLength || null,
        created: m.created || null,
        expirationDate: m.expirationDate || null,
        knowledgeCutoff: m.knowledgeCutoff || null,
        inputModalities: m.inputModalities || [],
        outputModalities: m.outputModalities || [],
        supportedParameters: m.supportedParameters || [],
        defaultParameters: m.defaultParameters || null,
        maxOutput: m.topProvider && m.topProvider.max_completion_tokens > 0 ? m.topProvider.max_completion_tokens : null
    });

    // Filtre _isImage : le cache texte peut contenir des modèles mixtes
    const textCache = getOrCache('text');
    if (textCache?.models) {
        for (const m of textCache.models) {
            if (m._isImage) continue;
            if (orEnabled.has(m.id) && !MODELS.find(x => x.id === m.id)) {
                MODELS.push(buildMeta(m));
                const pricing = m.pricingDetails || {};
                // Un prix absent devenait 0 dans les anciens catalogues : zéro accepté seulement si confirmé
                const cacheRate = value => Number.isFinite(value) && value >= 0
                    && (value > 0 || pricing.cacheRatesReported) ? value * 1_000_000 : undefined;
                TARIFS[m.id] = { editeur: 'openrouter', inputPer1M: m.inputPer1M || 0, outputPer1M: m.outputPer1M || 0,
                    cachedInputPer1M: cacheRate(pricing.inputCacheRead),
                    cacheWritePer1M: cacheRate(pricing.inputCacheWrite) };
            }
        }
    }

    const imageCache = getOrCache('image');
    if (imageCache?.models) {
        // Cache écrit avant l'enrichissement /endpoints : relire les prix persistés
        const priceMap = (typeof getOrImagePrices === 'function') ? getOrImagePrices() : {};
        for (const m of imageCache.models) {
            if (orEnabled.has(m.id) && !IMAGE_MODELS.find(x => x.id === m.id)) {
                IMAGE_MODELS.push(buildMeta(m));
                const imageOutput = m.imageOutput || priceMap[m.id] || 0;
                const pricing = m.pricingDetails || {};
                // Un ancien zéro peut signifier « tarif absent », pas « gratuit »
                const cacheRate = value => Number.isFinite(value) && value >= 0
                    && (value > 0 || pricing.cacheRatesReported) ? value * 1_000_000 : undefined;
                IMAGE_TARIFS[m.id] = { editeur: 'openrouter', inputPer1M: m.inputPer1M || 0, outputPer1M: m.outputPer1M || 0, imageOutput,
                    cachedInputPer1M: cacheRate(pricing.inputCacheRead),
                    cacheWritePer1M: cacheRate(pricing.inputCacheWrite) };
            }
        }
    }
}

// Réglage de raisonnement (MODEL_REASONING de models.js), ou null s'il n'y en a pas
function getReasoning(modelId) {
    if (!modelId || typeof MODELS_DATA === 'undefined' || !Array.isArray(MODELS_DATA.text)) return null;
    const m = MODELS_DATA.text.find(x => x.id === modelId);
    return m && m.reasoning ? m.reasoning : null;
}

/* Anthropic exige max_tokens : le maximum du modèle, sinon un long fichier est coupé ; inconnu : 64 000 */
function claudeDefaultMaxTokens(modelId) {
    return modelMaxOutput(modelId) || 64000;
}

function modelMaxOutput(modelId) {
    const m = typeof MODELS_DATA !== 'undefined' && Array.isArray(MODELS_DATA.text) ? MODELS_DATA.text.find(x => x.id === modelId) : null;
    return m && m.maxOutput > 0 ? m.maxOutput : 0;
}

// Plafond de « Tokens max » : maxOutput, celui d'OpenRouter, ou contexte d'un modèle local ; 0 inconnu
function maxOutputLimit(modelId) {
    const known = modelMaxOutput(modelId);
    if (known) return known;
    const m = MODELS.find(x => x.id === modelId);
    if (m && m.maxOutput > 0) return m.maxOutput;
    return m && isLocalEditeur(m.editeur) && m.contextLength > 0 ? m.contextLength : 0;
}

// DeepSeek/Z.ai refusent entrée + max_tokens > contexte : entrée estimée à 3 caractères par jeton
function _maxOutputWithin(modelId, messages, systemPrompt) {
    const max = modelMaxOutput(modelId);
    if (!max) return 0;
    const m = MODELS_DATA.text.find(x => x.id === modelId);
    if (!(m.contextWindow > 0)) return max;
    const chars = String(systemPrompt || '').length + JSON.stringify(messages || [], (k, v) =>
        typeof v === 'string' && v.length > 1000 && (/^data:/.test(v) || /^[A-Za-z0-9+/=]+$/.test(v.slice(0, 1000))) ? '' : v).length;
    const room = m.contextWindow - Math.ceil(chars / 3) - 4096;
    return Math.max(1024, Math.min(max, room));
}

function loadModels() {
    const data = MODELS_DATA;
    if (data.text) {
        // contextLength : contextWindow de models.js, comme pour OpenRouter (jauge de contexte)
        const entry = m => ({ id: m.id, label: m.label, editeur: m.editeur, description: m.description || '', contextLength: m.contextWindow || null });
        MODELS = data.text.filter(m => !RENAMED_MODEL_IDS[m.id]).map(entry);
        RETIRED_MODELS = [...data.text, ...(data.search || [])].filter(m => RENAMED_MODEL_IDS[m.id]).map(entry);
        for (const m of data.text) {
            const useLaterPrice = m.priceAfterDate && Date.now() >= Date.parse(m.priceAfterDate);
            TARIFS[m.id] = {
                editeur: m.editeur,
                inputPer1M: useLaterPrice ? m.inputPer1MAfter : m.inputPer1M,
                outputPer1M: useLaterPrice ? m.outputPer1MAfter : m.outputPer1M,
                cachedInputPer1M: useLaterPrice ? (m.cachedInputPer1MAfter ?? m.cachedInputPer1M) : m.cachedInputPer1M,
                priceAfterDate: m.priceAfterDate,
                inputPer1MBefore: m.inputPer1M,
                outputPer1MBefore: m.outputPer1M,
                cachedInputPer1MBefore: m.cachedInputPer1M,
                inputPer1MAfter: m.inputPer1MAfter,
                outputPer1MAfter: m.outputPer1MAfter,
                cachedInputPer1MAfter: m.cachedInputPer1MAfter,
                cacheWritePer1M: m.cacheWritePer1M,
                cacheWrite1hPer1M: m.cacheWrite1hPer1M,
                offPeakInputPer1M: m.offPeakInputPer1M,
                offPeakCachedInputPer1M: m.offPeakCachedInputPer1M,
                offPeakOutputPer1M: m.offPeakOutputPer1M,
                longContextThreshold: m.longContextThreshold,
                longInputPer1M: m.longInputPer1M,
                longOutputPer1M: m.longOutputPer1M,
                longCachedInputPer1M: m.longCachedInputPer1M,
                longCacheWritePer1M: m.longCacheWritePer1M,
                longCacheWrite1hPer1M: m.longCacheWrite1hPer1M
            };
        }
    }
    if (data.image) {
        IMAGE_MODELS = data.image.map(m => ({ id: m.id, label: m.label, editeur: m.editeur, description: m.description || '' }));
        for (const m of data.image) {
            IMAGE_TARIFS[m.id] = {
                editeur: m.editeur,
                inputPer1M: m.inputPer1M,
                imageInputPer1M: m.imageInputPer1M,
                imageOutputPer1M: m.imageOutputPer1M,
                outputPer1M: m.outputPer1M,
                imageOutput: m.imageOutput,
                imagePricing: m.imagePricing
            };
        }
    }
    if (data.search) {
        SEARCH_MODELS = data.search.filter(m => !RENAMED_MODEL_IDS[m.id]).map(m => ({ id: m.id, label: m.label, editeur: m.editeur, description: m.description || '', contextLength: m.contextWindow || null }));
        for (const m of data.search) {
            SEARCH_TARIFS[m.id] = { editeur: m.editeur, inputPer1M: m.inputPer1M, outputPer1M: m.outputPer1M, ...(m.requestPer1k != null && { requestPer1k: m.requestPer1k }) };
        }
    }
}

// IDs renommés par le fournisseur : les anciennes conversations retrouvent le nouveau modèle
const RENAMED_MODEL_IDS = {
    'gemini-3.1-flash-lite-preview': 'gemini-3.1-flash-lite',
    'gemini-3-pro-image-preview': 'gemini-3-pro-image',
    'gemini-3.1-flash-image-preview': 'gemini-3.1-flash-image',
    'deepseek-chat': 'deepseek-flash',
    'deepseek-v4-flash': 'deepseek-flash',
    'gemini-3.5-flash': 'gemini-3.6-flash',
    'gemini-3-flash-preview': 'gemini-3.8-flash',
    // xAI envoie ses requêtes vers Grok 4.3
    'grok-4-1-fast-reasoning': 'grok-4.3',
    // Sonar ne répond plus (fin de son API) ; Sonar Pro, si
    'sonar': 'sonar-pro',
    // Réglages audio : Voxtral 2 remplacé par Voxtral 3
    'voxtral-mini-tts-2603': 'voxtral-mini-tts-3-0',
    'voxtral-mini-latest': 'voxtral-mini-transcribe-3-0'
};
function migrateModelId(id) { return RENAMED_MODEL_IDS[id] || id; }

// Jamais proposés, mais connus pour les statistiques et le coût des anciennes conversations
let RETIRED_MODELS = [];
function _retiredModel(modelId) { return RETIRED_MODELS.find(m => m.id === modelId) || null; }

function getTarif(model) { return TARIFS[model] || null; }
function getImageTarif(model) { return IMAGE_TARIFS[model] || null; }

// format : 'square' | 'vertical' | 'horizontal' ; imageParams : résultat de getImageParams()
function computeImagePrice(tarif, format, imageParams) {
    if (!tarif) return 0;
    const pricing = tarif.imagePricing;
    if (!pricing) return tarif.imageOutput || 0;

    if (tarif.editeur === 'openai') {
        const sizeMap = { square: '1024x1024', vertical: '1024x1536', horizontal: '1536x1024' };
        const sizeKey = sizeMap[format] || '1024x1024';
        let q = imageParams?.quality || 'high';
        if (q === 'auto') q = 'medium';
        return pricing[q]?.[sizeKey] ?? pricing.high?.[sizeKey] ?? tarif.imageOutput ?? 0;
    }
    if (tarif.editeur === 'google') {
        const resKey = imageParams?.imageSize || '1K';
        return pricing[resKey] ?? pricing['1K'] ?? tarif.imageOutput ?? 0;
    }
    return tarif.imageOutput || 0;
}
function getSearchTarif(model) { return SEARCH_TARIFS[model] || null; }

function getModelEditeur(modelId) {
    const m = MODELS.find(m => m.id === modelId) || _retiredModel(modelId);
    return m ? m.editeur : null;
}

function getImageModelEditeur(modelId) {
    const m = IMAGE_MODELS.find(m => m.id === modelId);
    return m ? m.editeur : null;
}

function getSearchModelEditeur(modelId) {
    const m = SEARCH_MODELS.find(m => m.id === modelId) || _retiredModel(modelId);
    return m ? m.editeur : null;
}

async function initConfig() {
    loadApiKeys();
    // Avant pruneLastSelectionsOrphans(), qui purgerait sinon les anciens IDs
    try {
        for (const key of ['minou-last-model', 'minou-last-image-model', 'minou-last-search-model']) {
            const v = localStorage.getItem(key);
            if (v && RENAMED_MODEL_IDS[v]) localStorage.setItem(key, RENAMED_MODEL_IDS[v]);
        }
    } catch (e) {}
    loadAudioSettings();
    rebuildModelLists();
    fetchLocalModels().then(() => {
        if (typeof populateUnifiedSelect === 'function') populateUnifiedSelect();
    });
    // Rafraîchissement silencieux du catalogue OpenRouter, non bloquant
    if (API_KEYS.openrouter && typeof refreshOrCacheSilently === 'function') {
        refreshOrCacheSilently().then((ok) => {
            if (!ok) return;
            pruneOrEnabledOrphans();
            enableFreeOrModelsOnce();
            rebuildModelLists();
            if (typeof populateUnifiedSelect === 'function') populateUnifiedSelect();
        }).catch(() => {});
    }
}

// Premier passage avec une clé OpenRouter : modèles « :free » cochés d'office (décochables ensuite dans le Catalogue)
function enableFreeOrModelsOnce() {
    const FLAG = 'davidtwentyai-or-free-init';
    try { if (localStorage.getItem(FLAG)) return; } catch (e) { return; }
    const cache = getOrCache('text');
    const free = (cache?.models || []).map(m => m.id).filter(id => id.endsWith(':free'));
    if (!free.length) return;
    const prefs = loadCatalogPrefs();
    const orEnabled = new Set(prefs.orEnabled || []);
    free.forEach(id => orEnabled.add(id));
    saveCatalogPrefs({ disabled: prefs.disabled || [], orEnabled: [...orEnabled] });
    try { localStorage.setItem(FLAG, '1'); } catch (e) {}
}

// Catalogue OpenRouter récupéré sans toucher l'UI du panneau Catalogue (démarrage)
async function refreshOrCacheSilently() {
    if (!API_KEYS.openrouter) return false;
    const headers = { 'Authorization': `Bearer ${API_KEYS.openrouter}`, 'HTTP-Referer': 'https://davidtwentyai.local/', 'X-Title': 'DavidTwentyAI' };
    async function fetchOne(isImage) {
        const url = 'https://openrouter.ai/api/v1/models' + (isImage ? '?output_modalities=image' : '');
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return (data.data || []).filter(m => m.id && m.name).map(m => {
            const arch = m.architecture || {};
            const inputModalities = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
            const outputModalities = Array.isArray(arch.output_modalities) ? arch.output_modalities : [];
            const modality = arch.modality || '';
            // Modalité primaire : openrouter/auto a ["text","image"] et doit rester dans l'onglet Texte
            const _isImage = outputModalities.length
                ? outputModalities[0] === 'image'
                : modality.includes('->image');
            const inp = Math.round(parseFloat(m.pricing?.prompt || 0) * 1e6 * 100) / 100;
            const out = Math.round(parseFloat(m.pricing?.completion || 0) * 1e6 * 100) / 100;
            const imgOut = (typeof _parseOrImagePrice === 'function') ? _parseOrImagePrice(m.pricing) : 0;
            const pricingDetails = {
                request: parseFloat(m.pricing?.request) || 0,
                webSearch: parseFloat(m.pricing?.web_search) || 0,
                internalReasoning: parseFloat(m.pricing?.internal_reasoning) || 0,
                inputCacheRead: m.pricing?.input_cache_read != null ? parseFloat(m.pricing.input_cache_read) : null,
                inputCacheWrite: m.pricing?.input_cache_write != null ? parseFloat(m.pricing.input_cache_write) : null,
                cacheRatesReported: true,
                audio: parseFloat(m.pricing?.audio) || 0
            };
            return {
                id: m.id,
                canonicalSlug: m.canonical_slug || null,
                label: cleanOrModelLabel(m.name, m.id),
                editeur: 'openrouter',
                description: m.description || '',
                inputPer1M: inp,
                outputPer1M: out,
                imageOutput: imgOut,
                pricingDetails,
                _isImage,
                contextLength: m.context_length || null,
                created: m.created || null,
                expirationDate: m.expiration_date || null,
                knowledgeCutoff: m.knowledge_cutoff || null,
                inputModalities,
                outputModalities,
                tokenizer: arch.tokenizer || null,
                instructType: arch.instruct_type || null,
                supportedParameters: Array.isArray(m.supported_parameters) ? m.supported_parameters : [],
                defaultParameters: m.default_parameters || null,
                topProvider: m.top_provider || null,
                perRequestLimits: m.per_request_limits || null,
                isModerated: m.top_provider?.is_moderated ?? null,
                huggingFaceId: m.hugging_face_id || null
            };
        });
    }
    try {
        const [textModels, imageModels] = await Promise.all([fetchOne(false), fetchOne(true)]);
        // /models renvoie souvent pricing=0 en image : réhydrater depuis /endpoints, sinon « Gratuit » (cf. _loadOrModels)
        if (typeof getOrImagePrices === 'function') {
            const priceMap = getOrImagePrices();
            for (const m of imageModels) {
                if ((!m.imageOutput || m.imageOutput === 0) && priceMap[m.id] > 0) {
                    m.imageOutput = priceMap[m.id];
                }
            }
        }
        setOrCache(textModels, 'text');
        setOrCache(imageModels, 'image');
        return true;
    } catch (e) {
        console.warn('Refresh silencieux OpenRouter échoué :', e);
        return false;
    }
}

// À appeler après initConfig() pour éviter un currentModel fantôme
function pruneLastSelectionsOrphans() {
    const purged = [];
    const checks = [
        ['minou-last-model',        (id) => MODELS.some(m => m.id === id)],
        ['minou-last-image-model',  (id) => IMAGE_MODELS.some(m => m.id === id)],
        ['minou-last-search-model', (id) => SEARCH_MODELS.some(m => m.id === id)],
    ];
    for (const [key, isAlive] of checks) {
        const id = localStorage.getItem(key);
        if (id && !isAlive(id)) {
            localStorage.removeItem(key);
            purged.push({ key, id });
        }
    }
    if (purged.length) {
        for (const p of purged) {
            console.info(`[DavidTwentyAI] Modèle "${p.id}" supprimé du catalogue, sélection ${p.key} réinitialisée.`);
        }
    }
    return purged;
}

// Orphelins gardés dans `minou-or-orphans` pour info
function pruneOrEnabledOrphans() {
    const prefs = loadCatalogPrefs();
    const orEnabled = Array.isArray(prefs.orEnabled) ? prefs.orEnabled : [];
    if (orEnabled.length === 0) return;
    const live = new Set();
    const text = getOrCache('text');
    const image = getOrCache('image');
    if (text?.models) for (const m of text.models) live.add(m.id);
    if (image?.models) for (const m of image.models) live.add(m.id);
    if (live.size === 0) return; // refresh n'a rien rapporté → ne pas purger
    const kept = orEnabled.filter(id => live.has(id));
    const orphans = orEnabled.filter(id => !live.has(id));
    if (orphans.length === 0) return;
    saveCatalogPrefs({ disabled: prefs.disabled || [], orEnabled: kept });
    try {
        const prev = JSON.parse(localStorage.getItem('minou-or-orphans') || '[]');
        const merged = Array.from(new Set([...prev, ...orphans]));
        localStorage.setItem('minou-or-orphans', JSON.stringify(merged));
    } catch (e) {}
    console.info(`[DavidTwentyAI] ${orphans.length} modèle(s) OpenRouter sélectionné(s) ne sont plus disponibles et ont été retirés :`, orphans);
}

// Affiche les modèles locaux au démarrage sans relancer Ollama / LM Studio
const LOCAL_MODELS_CACHE_KEY = 'minou-local-models';

function _readLocalModelsCache() {
    try {
        const s = localStorage.getItem(LOCAL_MODELS_CACHE_KEY);
        if (s) return JSON.parse(s) || {};
    } catch (e) {}
    return {};
}

function _writeLocalModelsCache(cache) {
    try { localStorage.setItem(LOCAL_MODELS_CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
}

// `toolIds` : modèles déclarés entraînés aux outils (lu par supportsArtifactTools)
function _applyLocalModels(ed, ids, toolIds = []) {
    MODELS = MODELS.filter(m => m.editeur !== ed);
    for (const key of Object.keys(TARIFS)) {
        if (TARIFS[key].editeur === ed) delete TARIFS[key];
    }
    const tools = new Set(Array.isArray(toolIds) ? toolIds : []);
    for (const id of ids) {
        MODELS.push({ id, label: id, editeur: ed, ...(tools.has(id) && { tools: true }) });
        TARIFS[id] = { editeur: ed, inputPer1M: 0, outputPer1M: 0 };
    }
}

// À appeler à l'init, avant le fetch réseau
function loadCachedLocalModels() {
    const cache = _readLocalModelsCache();
    for (const ed of ['ollama', 'lmstudio']) {
        const ids = Array.isArray(cache[ed]) ? cache[ed] : [];
        if (ids.length) _applyLocalModels(ed, ids, cache[ed + 'Tools']);
    }
}

// Seuls les modèles déclarés aptes reçoivent des outils : LM Studio serait peu fiable, Ollama refuserait
async function _localToolModels(ed, baseUrl, ids) {
    const get = async (url, init) => {
        const r = await fetch(url, { ...init, signal: AbortSignal.timeout(LOCAL_CONTEXT_TIMEOUT_MS) });
        return r.ok ? r.json() : null;
    };
    if (ed === 'lmstudio') {
        const v1 = await get(`${baseUrl}/api/v1/models`).catch(() => null);
        if (v1 && Array.isArray(v1.models)) {
            return v1.models.filter(m => m && m.capabilities && m.capabilities.trained_for_tool_use === true).map(m => m.key).filter(id => ids.includes(id));
        }
        const v0 = await get(`${baseUrl}/api/v0/models`).catch(() => null);
        if (v0 && Array.isArray(v0.data)) {
            return v0.data.filter(m => m && Array.isArray(m.capabilities) && m.capabilities.includes('tool_use')).map(m => m.id).filter(id => ids.includes(id));
        }
        return null;
    }
    const found = await Promise.all(ids.map(id => get(`${baseUrl}/api/show`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: id })
    }).then(d => d && Array.isArray(d.capabilities) && d.capabilities.includes('tools') ? id : '', () => null)));
    return found.every(x => x === null) && ids.length ? null : found.filter(Boolean);
}

// Serveur éteint : les modèles mis en cache sont conservés
async function fetchLocalModels(onlyEditeur = null) {
    const editeurs = onlyEditeur ? [onlyEditeur] : ['ollama', 'lmstudio'];
    const cache = _readLocalModelsCache();

    await Promise.all(editeurs.map(async (ed) => {
        const url = API_KEYS[ed];
        if (!url) {
            _applyLocalModels(ed, []);
            delete cache[ed];
            delete cache[ed + 'Tools'];
            return;
        }
        try {
            const baseUrl = url.replace(/\/+$/, '');
            const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
            if (!response.ok) return; // serveur joignable mais erreur, on garde le cache
            const data = await response.json();
            const models = data.data || data.models || [];
            const ids = models.map(m => m.id || m.name).filter(Boolean);
            // Serveur muet sur les outils : ce qu'on en savait reste valable
            const toolIds = await _localToolModels(ed, baseUrl, ids).catch(() => null);
            if (toolIds) cache[ed + 'Tools'] = toolIds;
            _applyLocalModels(ed, ids, toolIds || (Array.isArray(cache[ed + 'Tools']) ? cache[ed + 'Tools'] : []));
            cache[ed] = ids;
        } catch (e) {
        }
    }));

    _writeLocalModelsCache(cache);
}

let _lastLocalModel = null;

function unloadLocalModel(modelId, editeur = null) {
    if (!modelId) return;
    const ed = editeur || getModelEditeur(modelId);
    if (!isLocalEditeur(ed)) return;
    const url = API_KEYS[ed];
    if (!url) return;
    const origin = url.replace(/\/+$/, '');

    if (ed === 'ollama') {
        fetch(`${origin}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelId, keep_alive: 0 }),
            signal: AbortSignal.timeout(2000)
        }).catch(() => {});
    } else if (ed === 'lmstudio') {
        fetch(`${origin}/api/v1/models/unload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instance_id: modelId }),
            signal: AbortSignal.timeout(2000)
        }).catch(() => {});
    }
}

// --- Taille du contexte d'un modèle (jauge) ---
// Modèles locaux : LM Studio /api/v0/models, Ollama /api/ps puis /api/show ; échec silencieux
const LOCAL_CONTEXT_TIMEOUT_MS = 2000;
// Un modèle non chargé peut l'être avec un autre contexte : redemandé plus souvent
const LOCAL_CONTEXT_TTL_MS = { loaded: 5 * 60 * 1000, other: 30 * 1000 };
const _localContextCache = new Map();   // 'éditeur:id' → { value, loaded, at }
const _localContextPending = new Map();

function getModelContextLength(modelId) {
    if (!modelId) return null;
    const m = MODELS.find(x => x.id === modelId) || SEARCH_MODELS.find(x => x.id === modelId);
    if (m && m.contextLength > 0) return m.contextLength;
    const info = getLocalContextInfo(modelId);
    return info && info.value > 0 ? info.value : null;
}

function getLocalContextInfo(modelId) {
    const ed = getModelEditeur(modelId);
    if (!isLocalEditeur(ed)) return null;
    return _localContextCache.get(ed + ':' + modelId) || null;
}

// `since` (ms) : un modèle non chargé lu avant a répondu depuis, il est chargé
function discoverLocalContextLength(modelId, { since = 0 } = {}) {
    const ed = getModelEditeur(modelId);
    if (!isLocalEditeur(ed) || !API_KEYS[ed]) return null;
    const key = ed + ':' + modelId;
    if (_localContextPending.has(key)) return _localContextPending.get(key);
    const known = _localContextCache.get(key);
    if (known && Date.now() - known.at < (known.loaded ? LOCAL_CONTEXT_TTL_MS.loaded : LOCAL_CONTEXT_TTL_MS.other)
        && (known.loaded || !(since > known.at))) return null;
    const origin = String(API_KEYS[ed]).replace(/\/+$/, '');
    const p = (ed === 'lmstudio' ? _lmStudioContextLength(origin, modelId) : _ollamaContextLength(origin, modelId))
        .catch(() => null)
        .then(found => {
            _localContextPending.delete(key);
            // Serveur muet : la valeur connue reste valable
            const entry = found && found.value > 0
                ? { value: found.value, loaded: !!found.loaded, at: Date.now() }
                : { value: known ? known.value : null, loaded: known ? known.loaded : false, at: Date.now() };
            _localContextCache.set(key, entry);
            return entry.value || null;
        });
    _localContextPending.set(key, p);
    return p;
}

async function _lmStudioContextLength(origin, modelId) {
    const res = await fetch(`${origin}/api/v0/models`, { signal: AbortSignal.timeout(LOCAL_CONTEXT_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = await res.json();
    const m = (Array.isArray(data && data.data) ? data.data : []).find(x => x && x.id === modelId);
    if (!m) return null;
    const loaded = Number(m.loaded_context_length);
    if (loaded > 0) return { value: loaded, loaded: true };
    const max = Number(m.max_context_length);
    return max > 0 ? { value: max, loaded: false } : null;
}

async function _ollamaContextLength(origin, modelId) {
    try {
        const res = await fetch(`${origin}/api/ps`, { signal: AbortSignal.timeout(LOCAL_CONTEXT_TIMEOUT_MS) });
        if (res.ok) {
            const data = await res.json();
            const m = ((data && data.models) || []).find(x => x && (x.name === modelId || x.model === modelId));
            const n = Number(m && m.context_length);
            if (n > 0) return { value: n, loaded: true };
        }
    } catch (e) { /* ancienne version ou modèle non chargé : /api/show */ }
    const res = await fetch(`${origin}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
        signal: AbortSignal.timeout(LOCAL_CONTEXT_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const numCtx = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(String((data && data.parameters) || ''));
    if (numCtx && Number(numCtx[1]) > 0) return { value: Number(numCtx[1]), loaded: false };
    const info = (data && data.model_info) || {};
    const k = Object.keys(info).find(x => /\.context_length$/.test(x));
    const n = Number(k && info[k]);
    return n > 0 ? { value: n, loaded: false } : null;
}

// --- 3. Générateur SSE partagé ---

async function* readSSE(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            // Espace après « data: » facultative (norme SSE)
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') return;
            try { yield JSON.parse(data); } catch {}
        }
    }
}

// --- 4. Utilitaires partagés pour Chat Completions ---

// Garde seulement la fin pouvant commencer `tag` (« <th ») : le reste s'affiche même pendant une pause
function _partialTagLength(s, tag) {
    for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
        if (tag.startsWith(s.slice(-n))) return n;
    }
    return 0;
}

function createThinkTagParser() {
    let inThinkBlock = false, thinkBuffer = '';

    function process(delta) {
        const events = [];
        let text = '';
        thinkBuffer += delta;
        while (thinkBuffer.length > 0) {
            if (inThinkBlock) {
                const endIdx = thinkBuffer.indexOf('</think>');
                if (endIdx !== -1) {
                    events.push({ type: 'thinking', data: thinkBuffer.substring(0, endIdx) });
                    thinkBuffer = thinkBuffer.substring(endIdx + 8);
                    inThinkBlock = false;
                } else {
                    const keep = _partialTagLength(thinkBuffer, '</think>');
                    if (thinkBuffer.length > keep) {
                        events.push({ type: 'thinking', data: thinkBuffer.substring(0, thinkBuffer.length - keep) });
                        thinkBuffer = thinkBuffer.substring(thinkBuffer.length - keep);
                    }
                    break;
                }
            } else {
                const startIdx = thinkBuffer.indexOf('<think>');
                if (startIdx !== -1) {
                    if (startIdx > 0) text += thinkBuffer.substring(0, startIdx);
                    thinkBuffer = thinkBuffer.substring(startIdx + 7);
                    inThinkBlock = true;
                } else {
                    const keep = _partialTagLength(thinkBuffer, '<think>');
                    if (thinkBuffer.length > keep) {
                        text += thinkBuffer.substring(0, thinkBuffer.length - keep);
                        thinkBuffer = thinkBuffer.substring(thinkBuffer.length - keep);
                    }
                    break;
                }
            }
        }
        return { text, events };
    }

    function flush() {
        const events = [];
        if (thinkBuffer) events.push({ type: inThinkBlock ? 'thinking' : 'chunk', data: thinkBuffer });
        thinkBuffer = '';
        return events;
    }

    return { process, flush };
}

// Options : textOnly (Perplexity), trimTrailingAssistant (Mistral), collapseTextOnly (local)
function formatChatCompletionsMessages(history, options = {}) {
    const messages = history.filter(m => m.role !== 'system').map(msg => {
        if (typeof msg.content === 'string') {
            return { role: msg.role, content: msg.content };
        }
        if (Array.isArray(msg.content)) {
            if (options.textOnly) {
                const text = msg.content.map(p => {
                    if (p.type === 'text') return p.text;
                    if (p.type === 'file') return `--- Contenu du fichier joint : ${p.name} ---\n${p.textContent || ''}\n--- Fin du fichier ---`;
                    return '';
                }).filter(Boolean).join('\n');
                return { role: msg.role, content: text };
            }
            const parts = [];
            for (const part of msg.content) {
                if (part.type === 'text') {
                    parts.push({ type: 'text', text: part.text });
                } else if (part.type === 'image') {
                    if (msg.role === 'assistant') {
                        parts.push({ type: 'text', text: '[Image générée]' });
                    } else {
                        const dataUrl = part.dataUrl || `data:${part.mimeType};base64,${part.data}`;
                        parts.push({ type: 'image_url', image_url: { url: dataUrl } });
                    }
                } else if (part.type === 'file') {
                    parts.push({ type: 'text', text: `--- Contenu du fichier joint : ${part.name} ---\n${part.textContent || ''}\n--- Fin du fichier ---` });
                }
            }
            if (options.collapseTextOnly && !parts.some(p => p.type === 'image_url')) {
                return { role: msg.role, content: parts.map(p => p.text).filter(Boolean).join('\n') };
            }
            return { role: msg.role, content: parts };
        }
        return { role: msg.role, content: String(msg.content) };
    });
    if (options.trimTrailingAssistant) {
        while (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
            messages.pop();
        }
    }
    return messages;
}

// Cumulatifs : un champ absent ne remet pas à zéro ; entrée TOTALE, même chez Anthropic (hors cache)
function _apiTokenCount(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Une valeur absente reste absente : zéro est un compteur réel
function _googleAudioUsage(source, interactions, requestTimestamp) {
    const usage = { requestTimestamp };
    if (!source || typeof source !== 'object') return usage;
    const counters = interactions
        ? { inputTokens: 'total_input_tokens', outputTokens: 'total_output_tokens', cachedInputTokens: 'total_cached_tokens', reasoningTokens: 'total_thought_tokens' }
        : { inputTokens: 'promptTokenCount', outputTokens: 'candidatesTokenCount', cachedInputTokens: 'cachedContentTokenCount', reasoningTokens: 'thoughtsTokenCount' };
    for (const [name, field] of Object.entries(counters)) {
        const count = _apiTokenCount(source[field]);
        if (count !== null) usage[name] = count;
    }
    const inputDetails = interactions ? source.input_tokens_by_modality : source.promptTokensDetails;
    const cachedDetails = interactions ? source.cached_tokens_by_modality : source.cacheTokensDetails;
    for (const [details, prefix] of [[inputDetails, ''], [cachedDetails, 'cached']]) {
        if (!Array.isArray(details)) continue;
        for (const part of details) {
            const count = _apiTokenCount(interactions ? part?.tokens : part?.tokenCount);
            const modality = String(part?.modality || '').toLowerCase();
            if (count === null || !['audio', 'text'].includes(modality)) continue;
            const field = prefix ? prefix + (modality === 'audio' ? 'AudioInputTokens' : 'TextInputTokens')
                : modality + 'InputTokens';
            usage[field] = (usage[field] || 0) + count;
        }
    }
    return usage;
}

function _mergeTokenUsage(usage, source, format) {
    if (!source || typeof source !== 'object') return;
    const setCount = (key, value) => {
        const count = _apiTokenCount(value);
        if (count === null) return false;
        usage[key] = count;
        return true;
    };
    const setCacheCount = (key, value) => {
        if (setCount(key, value)) usage.cache_usage_reported = true;
    };
    if (format === 'anthropic') {
        if (setCount('uncached_input_tokens', source.input_tokens)) usage.usage_reported = true;
        if (setCount('output_tokens', source.output_tokens)) usage.usage_reported = true;
        setCacheCount('cached_input_tokens', source.cache_read_input_tokens);
        setCacheCount('cache_write_input_tokens', source.cache_creation_input_tokens);
        const has5m = setCount('cache_write_5m_input_tokens', source.cache_creation?.ephemeral_5m_input_tokens);
        const has1h = setCount('cache_write_1h_input_tokens', source.cache_creation?.ephemeral_1h_input_tokens);
        if (_apiTokenCount(source.cache_creation_input_tokens) === null && (has5m || has1h)) {
            usage.cache_write_input_tokens = (usage.cache_write_5m_input_tokens || 0) + (usage.cache_write_1h_input_tokens || 0);
            usage.cache_usage_reported = true;
        }
        usage.input_tokens = (usage.uncached_input_tokens || 0) + (usage.cached_input_tokens || 0) + (usage.cache_write_input_tokens || 0);
    } else if (format === 'google') {
        if (setCount('input_tokens', source.promptTokenCount)) usage.usage_reported = true;
        if (setCount('candidate_output_tokens', source.candidatesTokenCount)) usage.usage_reported = true;
        setCount('reasoning_tokens', source.thoughtsTokenCount);
        // Gemini facture la réflexion, absente de candidatesTokenCount (contrairement à OpenAI)
        usage.output_tokens = (usage.candidate_output_tokens || 0) + (usage.reasoning_tokens || 0);
        setCacheCount('cached_input_tokens', source.cachedContentTokenCount);
    } else {
        if (setCount('input_tokens', source.prompt_tokens ?? source.input_tokens)) usage.usage_reported = true;
        if (setCount('output_tokens', source.completion_tokens ?? source.output_tokens)) usage.usage_reported = true;
        const details = source.prompt_tokens_details || source.input_tokens_details;
        setCacheCount('cached_input_tokens', source.prompt_cache_hit_tokens ?? details?.cached_tokens);
        setCacheCount('cache_write_input_tokens', details?.cache_write_tokens);
        if (details) usage.input_tokens_details = { ...usage.input_tokens_details, ...details };
        if (source.completion_tokens_details || source.output_tokens_details) {
            usage.output_tokens_details = { ...usage.output_tokens_details, ...(source.completion_tokens_details || source.output_tokens_details) };
        }
        if (format === 'grok') {
            // xAI exclut la réflexion de completion_tokens/output_tokens, contrairement à OpenRouter/OpenAI
            if (setCount('visible_output_tokens', source.completion_tokens ?? source.output_tokens)) usage.usage_reported = true;
            setCount('reasoning_tokens', (source.completion_tokens_details || source.output_tokens_details)?.reasoning_tokens);
            if (usage.visible_output_tokens != null || usage.reasoning_tokens != null) {
                const totalOutput = (usage.visible_output_tokens || 0) + (usage.reasoning_tokens || 0);
                if (Number.isSafeInteger(totalOutput)) usage.output_tokens = totalOutput;
            }
        }
        // DeepSeek peut fournir les deux catégories même sans prompt_tokens.
        if (_apiTokenCount(source.prompt_tokens ?? source.input_tokens) === null
            && _apiTokenCount(source.prompt_cache_hit_tokens) !== null
            && _apiTokenCount(source.prompt_cache_miss_tokens) !== null) {
            usage.input_tokens = source.prompt_cache_hit_tokens + source.prompt_cache_miss_tokens;
            usage.usage_reported = true;
        }
    }
    // OpenRouter : dollars ; xAI : 10^10 ticks par dollar ; cache et outils inclus, prime sur l'estimation
    const readCost = value => {
        if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
        const cost = Number(value);
        return Number.isFinite(cost) && cost >= 0 ? cost : null;
    };
    const ticks = readCost(source.cost_in_usd_ticks);
    // Perplexity : détail du coût, forfait par requête compris (total_cost)
    const cost = readCost(source.cost && typeof source.cost === 'object' ? source.cost.total_cost : source.cost);
    if (ticks !== null) usage.cost_real = ticks / 10_000_000_000;
    else if (cost !== null) usage.cost_real = cost;
    // Recherches faites par le fournisseur (OpenRouter : server_tool_use_details, Anthropic : server_tool_use)
    const tools = source.server_tool_use_details || source.server_tool_use;
    if (tools && typeof tools === 'object') setCount('web_search_requests', tools.web_search_requests);
    // xAI : seules les recherches réussies sont facturées, ainsi que les publications et profils de X lus
    const xai = source.server_side_tool_usage_details;
    if (xai && typeof xai === 'object') {
        const web = _apiTokenCount(xai.web_search_calls), x = _apiTokenCount(xai.x_search_calls);
        if (web !== null || x !== null) usage.web_search_requests = (web || 0) + (x || 0);
        setCount('x_posts_fetched', xai.x_posts_fetched);
        setCount('x_users_fetched', xai.x_users_fetched);
    }
}

// OpenRouter et OpenAI rangent l'adresse dans `url_citation`, d'autres à plat
function _extractUrlCitations(parsed) {
    const anns = parsed.choices?.[0]?.delta?.annotations;
    if (!Array.isArray(anns)) return null;
    const out = [];
    for (const a of anns) {
        if (a?.type !== 'url_citation') continue;
        const c = a.url_citation || a;
        if (typeof c.url !== 'string' || !c.url) continue;
        const cit = { url: c.url, title: c.title || '' };
        const snippet = _citationSnippet(c.content, cit.title);
        if (snippet) cit.snippet = snippet;
        out.push(cit);
    }
    return out.length ? out : null;
}

function _citationSnippet(text, title) {
    if (typeof text !== 'string' || !text.trim()) return '';
    let s = text.replace(/^[ \t]*#+[ \t].*$/gm, '').replace(/^[ \t]*(?:\.{3}|…)[ \t]*$/gm, '').replace(/\s+/g, ' ').trim();
    if (title && s.startsWith(title)) s = s.slice(title.length).replace(/^[\s\-–—:|]+/, '');
    if (s.length > 240) s = s.slice(0, 240).replace(/\s+\S*$/, '') + '…';
    return s;
}

const SERVER_TOOL_NAME_RE = /^(?:openrouter[:_.-])?(?:web[_-]?search|web[_-]?fetch|datetime)$|^openrouter[:_.-]/i;

// `usage.cost_real` reprend le champ `cost` renvoyé par OpenRouter
function createChatCompletionsParser(hasThinkingCallback, options = {}) {
    let usage = { input_tokens: 0, output_tokens: 0, cost_real: null, request_timestamp: Date.now() };
    let citations = [];
    const thinkParser = hasThinkingCallback ? createThinkTagParser() : null;
    // Raisonnement à renvoyer avec les appels d'outils (OpenRouter : reasoning_details)
    const calls = [];
    const reasoningDetails = [];
    let reasoningContent = '';

    function parse(parsed) {
        const events = [];

        // OpenAI o3/o4/gpt-5 : choices[0].delta.reasoning_content
        if (options.extractReasoning) {
            const reasoning = options.extractReasoning(parsed);
            if (reasoning) {
                reasoningContent += reasoning;
                if (hasThinkingCallback) events.push({ type: 'thinking', data: reasoning });
            }
        }

        let delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
            // Mistral Small 4 / Medium 3.5 : `delta.content` peut être un tableau de chunks (thinking, text)
            if (Array.isArray(delta)) {
                for (const chunk of delta) {
                    if (chunk?.type === 'thinking' && hasThinkingCallback && Array.isArray(chunk.thinking)) {
                        for (const inner of chunk.thinking) {
                            if (inner?.type === 'text' && inner.text) {
                                events.push({ type: 'thinking', data: inner.text });
                            }
                        }
                    } else if (chunk?.type === 'text' && chunk.text) {
                        events.push({ type: 'chunk', data: chunk.text });
                    }
                }
            } else if (thinkParser) {
                const { text, events: thinkEvents } = thinkParser.process(delta);
                events.push(...thinkEvents);
                if (text) events.push({ type: 'chunk', data: text });
            } else {
                events.push({ type: 'chunk', data: delta });
            }
        }

        // Perplexity : parsed.citations ; OpenAI : annotations
        if (options.extractCitations) {
            const c = options.extractCitations(parsed);
            if (c) {
                if (options.accumulateCitations) {
                    for (const ci of c) {
                        if (!citations.some(x => x.url === ci.url)) citations.push(ci);
                    }
                } else {
                    citations = c;
                }
            }
        }

        // Un outil inattendu explique une réponse vide : le modèle a voulu agir par un outil
        const toolCalls = parsed.choices?.[0]?.delta?.tool_calls;
        if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
                if (!tc || typeof tc !== 'object') continue;
                const at = Number.isInteger(tc.index) ? tc.index : calls.length;
                const call = calls[at] || (calls[at] = { id: '', name: '', arguments: '' });
                const fn = tc.function || {};
                if (typeof tc.id === 'string' && tc.id) call.id = tc.id;
                if (typeof fn.name === 'string' && fn.name && !call.name) call.name = fn.name;
                if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
                else if (fn.arguments && typeof fn.arguments === 'object') call.arguments = JSON.stringify(fn.arguments);
                if (tc.extra_content) call.extra_content = tc.extra_content;
                const name = fn.name;
                if (typeof name === 'string' && SERVER_TOOL_NAME_RE.test(name) && /search|fetch/i.test(name)) {
                    events.push({ type: 'searching', what: /fetch/i.test(name) ? 'fetch' : 'search' });
                }
                if (typeof name !== 'string' || !name.trim() || SERVER_TOOL_NAME_RE.test(name)) continue;
                usage.tool_calls = usage.tool_calls || [];
                if (!usage.tool_calls.includes(name) && usage.tool_calls.length < 5) usage.tool_calls.push(name.slice(0, 60));
            }
        }
        const details = parsed.choices?.[0]?.delta?.reasoning_details;
        if (Array.isArray(details)) {
            for (const d of details) {
                if (!d || typeof d !== 'object') continue;
                const at = Number.isInteger(d.index) ? d.index : reasoningDetails.length;
                const cur = reasoningDetails[at];
                if (!cur) { reasoningDetails[at] = { ...d }; continue; }
                for (const k of Object.keys(d)) {
                    if (k === 'index' || d[k] == null) continue;
                    if ((k === 'text' || k === 'summary' || k === 'data') && typeof d[k] === 'string' && typeof cur[k] === 'string') cur[k] += d[k];
                    else cur[k] = d[k];
                }
            }
        }

        if (parsed.usage) {
            _mergeTokenUsage(usage, parsed.usage, options.usageFormat || 'chat');
        }
        // Raison de fin et erreur en cours de flux (OpenRouter) : expliquent une réponse tronquée
        const finish = parsed.choices?.[0]?.finish_reason;
        if (typeof finish === 'string' && finish) usage.finish_reason = finish;
        if (parsed.error) usage.stream_error = String(parsed.error.message || parsed.error.code || 'erreur inconnue');
        if (typeof parsed.model === 'string') usage.response_model = parsed.model;
        if (typeof parsed.created === 'number' && Number.isFinite(parsed.created) && parsed.created > 0) usage.request_timestamp = parsed.created * 1000;
        return events;
    }

    parse.flush = () => thinkParser ? thinkParser.flush() : [];
    parse.getResult = () => ({ usage, citations,
        toolCalls: calls.filter(c => c && c.name && !SERVER_TOOL_NAME_RE.test(c.name)),
        reasoningDetails: reasoningDetails.filter(Boolean), reasoningContent });
    return parse;
}

// --- Outils des Artifacts (write_file, edit_file, delete_file, read_file) ---
// DeepSeek garde les balises : avec outils, son API exige la réflexion de tous les messages (400)
const ARTIFACT_TOOLS_EDITEURS = new Set(['openai', 'anthropic', 'google', 'mistral', 'grok', 'openrouter', 'zai']);
// Allers-retours au plus par réponse (chacun renvoie tout le contexte)
const ARTIFACT_TOOLS_MAX_ROUNDS = 8;
const LOCAL_MODELS_TOOLS = true;

function supportsArtifactTools(modelId) {
    if (!modelId) return false;
    const editeur = getModelEditeur(modelId);
    if (LOCAL_MODELS_TOOLS && isLocalEditeur(editeur)) {
        const local = typeof MODELS !== 'undefined' ? MODELS.find(m => m.id === modelId) : null;
        return !!(local && local.tools);
    }
    // Gemma 1 à 3 : pas d'appels de fonction sur l'API Gemini (Gemma 4 : mesuré le 18 octobre)
    if (!ARTIFACT_TOOLS_EDITEURS.has(editeur) || /^gemma-[1-3](?!\d)/i.test(modelId)) return false;
    if (editeur !== 'openrouter') return true;
    const meta = typeof MODELS !== 'undefined' ? MODELS.find(m => m.id === modelId) : null;
    return !!(meta && Array.isArray(meta.supportedParameters) && meta.supportedParameters.includes('tools'));
}

// Guillemet non échappé dans du code : ferme la chaîne seulement devant « : », « , "clé": » ou le « } » final ; openEnd : texte encore incomplet
function _quoteCloses(text, j, isKey, openEnd) {
    const n = text.length;
    let k = j + 1;
    while (k < n && /\s/.test(text[k])) k++;
    if (k >= n) return openEnd;
    if (isKey) return text[k] === ':';
    if (text[k] === '}') {
        let e = k + 1;
        while (e < n && /\s/.test(text[e])) e++;
        return e >= n;
    }
    if (text[k] !== ',') return false;
    k++;
    while (k < n && /\s/.test(text[k])) k++;
    if (k >= n) return openEnd;
    if (text[k] !== '"') return false;
    if (/^"[^"\\\n]{1,40}"\s*:/.test(text.slice(k, k + 64))) return true;
    return openEnd && n - k <= 64 && /^"[^"\\\n]{0,40}(?:"\s*)?$/.test(text.slice(k));
}

// JSON partiel d'un appel en cours : champs lisibles, pour montrer en direct le fichier écrit
function _partialToolArgs(text) {
    const out = {};
    if (typeof text !== 'string') return out;
    let i = text.indexOf('{');
    if (i < 0) return out;
    i++;
    const n = text.length;
    const ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
    const skip = () => { while (i < n && /\s/.test(text[i])) i++; };
    const readString = (isKey) => {
        let str = '';
        i++;
        while (i < n) {
            const c = text[i];
            if (c === '"' && _quoteCloses(text, i, isKey, true)) { i++; return { str, done: true }; }
            if (c === '\\') {
                if (i + 1 >= n) break;
                const e = text[i + 1];
                if (e === 'u') {
                    if (i + 6 > n) break;
                    str += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16) || 0);
                    i += 6;
                    continue;
                }
                str += ESC[e] !== undefined ? ESC[e] : e;
                i += 2;
                continue;
            }
            str += c;
            i++;
        }
        i = n;
        return { str, done: false };
    };
    while (i < n) {
        skip();
        if (text[i] === ',') { i++; continue; }
        if (text[i] !== '"') break;
        const key = readString(true);
        if (!key.done) break;
        skip();
        if (text[i] !== ':') break;
        i++;
        skip();
        if (i >= n) break;
        if (text[i] === '"') {
            const v = readString(false);
            out[key.str] = v.str;
            if (!v.done) { out.__open = key.str; break; }
        } else {
            const m = /^(?:-?\d+(?:\.\d+)?|true|false|null)/.exec(text.slice(i));
            if (!m) break;
            out[key.str] = JSON.parse(m[0]);
            i += m[0].length;
        }
    }
    return out;
}

/* JSON invalide d'un appel terminé (eager_input_streaming ne valide pas) : relu avec tolérance si complet */
function _lenientToolArgs(text) {
    return _readToolArgs(text, false) || _readToolArgs(text, true);
}

/* stray : guillemets non échappés tolérés (second passage, après la lecture habituelle) */
function _readToolArgs(text, stray) {
    if (typeof text !== 'string') return null;
    let i = text.indexOf('{');
    if (i < 0) return null;
    i++;
    const n = text.length;
    const out = {};
    const FAIL = {};
    const ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
    const skip = () => { while (i < n && /\s/.test(text[i])) i++; };
    const readString = (isKey) => {
        let str = '';
        i++;
        while (i < n) {
            const c = text[i];
            if (c === '"' && (!stray || _quoteCloses(text, i, isKey, false))) { i++; return str; }
            if (c === '\\') {
                const e = text[i + 1];
                if (e === undefined) return FAIL;
                const hex = text.slice(i + 2, i + 6);
                if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(hex)) { str += String.fromCharCode(parseInt(hex, 16)); i += 6; continue; }
                // Échappement inconnu : barre gardée (dans du code, \d ou \' voulaient dire ces deux caractères)
                str += ESC[e] !== undefined ? ESC[e] : '\\' + e;
                i += 2;
                continue;
            }
            str += c;
            i++;
        }
        return FAIL;
    };
    skip();
    if (text[i] === '}') { i++; skip(); return i >= n ? out : null; }
    while (i < n) {
        skip();
        if (text[i] !== '"') return null;
        const key = readString(true);
        if (key === FAIL) return null;
        skip();
        if (text[i] !== ':') return null;
        i++;
        skip();
        let value;
        if (text[i] === '"') {
            value = readString(false);
            if (value === FAIL) return null;
        } else {
            const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
            if (!m) return null;
            value = JSON.parse(m[0]);
            i += m[0].length;
        }
        out[key] = value;
        skip();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; skip(); return i >= n ? out : null; }
        return null;
    }
    return null;
}

// Tour du modèle à renvoyer à Gemini : textes vides sans signature retirés
function _geminiModelParts(parts) {
    return (parts || []).filter(p => p && (p.functionCall || p.thoughtSignature || (typeof p.text === 'string' && p.text)));
}

// Somme de deux consommations, comme _sumUsage d'app.js
function _addUsage(a, b) {
    if (!a || !b) return a || b ? { ...(a || b) } : b;
    const out = { ...b };
    for (const k of Object.keys(a)) {
        const x = a[k], y = b[k];
        if (k === 'request_timestamp') out[k] = x;
        // Entrée du plus gros appel (tarif long contexte : par requête)
        else if (k === 'max_call_input_tokens') out[k] = Math.max(x || 0, y || 0);
        else if (typeof x === 'number' && typeof y === 'number') out[k] = x + y;
        else if (Array.isArray(x) && Array.isArray(y)) out[k] = [...new Set([...x, ...y])];
        else if (x && y && typeof x === 'object' && typeof y === 'object') out[k] = _addUsage(x, y);
        else if (y === undefined || y === null) out[k] = x;
    }
    // Coût réel seulement s'il est connu pour chaque partie, sinon estimé par les tokens
    if ('cost_real' in a || 'cost_real' in b) {
        out.cost_real = Number.isFinite(a.cost_real) && Number.isFinite(b.cost_real) ? a.cost_real + b.cost_real : null;
    }
    return out;
}

function _chatAddTools(body, specs) {
    body.tools = specs.map(s => ({ type: 'function', function: { name: s.name, description: s.description, parameters: s.parameters } }));
    body.tool_choice = 'auto';
    return body;
}

function _chatToolRound(messages, round, results, withName, withReasoning) {
    const assistant = {
        role: 'assistant',
        content: round.text || '',
        tool_calls: round.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || JSON.stringify(c.args || {}) },
            ...(c.extra_content ? { extra_content: c.extra_content } : {}) }))
    };
    if (round.reasoningDetails && round.reasoningDetails.length) assistant.reasoning_details = round.reasoningDetails;
    if (withReasoning && round.reasoningContent) assistant.reasoning_content = round.reasoningContent;
    return [...messages, assistant, ...results.map(r => ({ role: 'tool', tool_call_id: r.id, ...(withName ? { name: r.name } : {}), content: r.result }))];
}

// Tour sans appel d'outil renvoyé tel quel, puis une note de DavidTwentyAI : l'IA continue sa réponse (repère recopié)
function _chatNoteRound(messages, round, note, withReasoning) {
    const assistant = { role: 'assistant', content: round.text || '' };
    if (round.reasoningDetails && round.reasoningDetails.length) assistant.reasoning_details = round.reasoningDetails;
    if (withReasoning && round.reasoningContent) assistant.reasoning_content = round.reasoningContent;
    return [...messages, assistant, { role: 'user', content: note }];
}

// Les éléments déjà au format Responses (champ `type`) passent tels quels
function _responsesInput(messages) {
    return (Array.isArray(messages) ? messages : []).map(m => {
        if (!m || m.type || !Array.isArray(m.content)) return m;
        if (m.role === 'assistant') {
            return { role: 'assistant', content: m.content.map(p => p && p.type === 'text' ? p.text : '').filter(Boolean).join('\n') };
        }
        return { role: m.role, content: m.content.map(p => {
            if (p && p.type === 'text') return { type: 'input_text', text: p.text };
            if (p && p.type === 'image_url') return { type: 'input_image', image_url: p.image_url && p.image_url.url };
            return p;
        }) };
    });
}

// Sans validation stricte : les schémas ont des champs facultatifs, que le mode strict refuse
function _responsesAddTools(body, specs) {
    body.tools = [...(body.tools || []), ...specs.map(s => ({ type: 'function', name: s.name, description: s.description, parameters: s.parameters, strict: false }))];
    body.tool_choice = 'auto';
    return body;
}

// store: false : un raisonnement sans contenu chiffré est retiré, avec les ids des éléments suivants
function _responsesToolRound(input, round, results) {
    const items = Array.isArray(round.rawParts) ? round.rawParts.filter(it => it && typeof it === 'object') : [];
    const lost = items.some(it => it.type === 'reasoning' && !it.encrypted_content);
    const back = [];
    for (const it of items) {
        if (it.type === 'reasoning') { if (!lost) back.push(it); continue; }
        if (!lost) { back.push(it); continue; }
        if (it.type === 'message') {
            const text = (it.content || []).map(p => p && typeof p.text === 'string' ? p.text : '').join('');
            if (text) back.push({ role: 'assistant', content: text });
        } else if (it.type === 'function_call') {
            back.push({ type: 'function_call', call_id: it.call_id, name: it.name, arguments: it.arguments });
        }
    }
    // Flux interrompu : appel reconstitué sans élément reçu en entier
    for (const c of round.calls || []) {
        if (!back.some(it => it.type === 'function_call' && it.call_id === c.id)) {
            back.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments || JSON.stringify(c.args || {}) });
        }
    }
    return [...input, ...back, ...results.map(r => ({ type: 'function_call_output', call_id: r.id, output: r.result }))];
}

// Aussi pour la recherche web de Grok (xAI, `usageFormat: 'grok'`)
function createOpenAIResponsesParser(hasThinkingCallback, options = {}) {
    let usage = { input_tokens: 0, output_tokens: 0, request_timestamp: Date.now() };
    let citations = [];
    const calls = [];
    const items = [];
    const callOf = (itemId) => itemId ? calls.find(c => c.itemId === itemId) : null;
    const noteToolName = (name) => {
        if (typeof name !== 'string' || !name.trim()) return;
        usage.tool_calls = usage.tool_calls || [];
        if (!usage.tool_calls.includes(name) && usage.tool_calls.length < 5) usage.tool_calls.push(name.slice(0, 60));
    };
    // xAI met le numéro du renvoi (« 1 ») en titre : sans intérêt
    const addCitation = (ann) => {
        if (ann?.type !== 'url_citation' || typeof ann.url !== 'string' || !ann.url) return;
        if (citations.some(c => c.url === ann.url)) return;
        const title = typeof ann.title === 'string' && !/^\d+$/.test(ann.title.trim()) ? ann.title : '';
        citations.push({ url: ann.url, title });
    };

    function parse(parsed) {
        const events = [];
        if (parsed.type === 'response.output_text.delta' && parsed.delta) {
            events.push({ type: 'chunk', data: parsed.delta });
        }
        // Résumé en plusieurs parties : une ligne vide entre elles
        if (hasThinkingCallback && parsed.type === 'response.reasoning_summary_part.added' && parsed.summary_index > 0) {
            events.push({ type: 'thinking', data: '\n\n' });
        }
        if (hasThinkingCallback && parsed.type === 'response.reasoning_summary_text.delta' && parsed.delta) {
            events.push({ type: 'thinking', data: parsed.delta });
        }
        if (parsed.type === 'response.output_item.added' && parsed.item?.type === 'web_search_call') {
            events.push({ type: 'searching', what: 'search' });
        }
        if (parsed.type === 'response.output_item.added' && parsed.item?.type === 'function_call') {
            const it = parsed.item;
            calls.push({ id: it.call_id || '', name: it.name || '', arguments: typeof it.arguments === 'string' ? it.arguments : '', itemId: it.id || '' });
            noteToolName(it.name);
        }
        if (parsed.type === 'response.function_call_arguments.delta' && typeof parsed.delta === 'string') {
            const c = callOf(parsed.item_id);
            if (c) c.arguments += parsed.delta;
        }
        if (parsed.type === 'response.function_call_arguments.done' && typeof parsed.arguments === 'string') {
            const c = callOf(parsed.item_id);
            if (c) c.arguments = parsed.arguments;
        }
        if (parsed.type === 'response.output_item.done' && parsed.item && typeof parsed.item === 'object') {
            const it = parsed.item;
            if (it.type === 'function_call') {
                let c = callOf(it.id);
                if (!c) { c = { id: '', name: '', arguments: '', itemId: it.id || '' }; calls.push(c); noteToolName(it.name); }
                if (it.call_id) c.id = it.call_id;
                if (it.name) c.name = it.name;
                if (typeof it.arguments === 'string') c.arguments = it.arguments;
            }
            if (it.type === 'reasoning' || it.type === 'function_call' || it.type === 'message') {
                items.push({ at: Number.isInteger(parsed.output_index) ? parsed.output_index : items.length, item: it });
            }
        }
        if (parsed.type === 'error') usage.stream_error = String(parsed.message || parsed.code || 'erreur inconnue');
        if (parsed.type === 'response.failed') usage.stream_error = String(parsed.response?.error?.message || 'erreur inconnue');
        if (parsed.type === 'response.output_text.annotation.added') addCitation(parsed.annotation);
        // xAI n'annonce pas les sources une à une : lues dans le message terminé
        if (parsed.type === 'response.output_item.done' && parsed.item?.type === 'message' && Array.isArray(parsed.item.content)) {
            for (const part of parsed.item.content) for (const ann of (part && Array.isArray(part.annotations) ? part.annotations : [])) addCitation(ann);
        }
        if (parsed.type === 'response.output_item.done' && parsed.item?.type === 'web_search_call' && parsed.item.action?.type === 'search') {
            const a = parsed.item.action;
            usage.web_search_requests = (usage.web_search_requests || 0) + 1;
            const queries = Array.isArray(a.queries) ? a.queries : (a.query ? [a.query] : []);
            for (const q of queries) {
                if (typeof q !== 'string' || !q.trim()) continue;
                usage.web_search_queries = usage.web_search_queries || [];
                if (!usage.web_search_queries.includes(q)) usage.web_search_queries.push(q);
            }
        }
        if (parsed.type === 'response.completed') usage.finish_reason = 'stop';
        if (parsed.type === 'response.incomplete') usage.finish_reason = parsed.response?.incomplete_details?.reason || 'incomplete';
        // Aussi pour une réponse incomplète ou en échec (déjà facturée)
        if (/^response\.(?:completed|incomplete|failed)$/.test(parsed.type) && parsed.response?.usage) {
            _mergeTokenUsage(usage, parsed.response.usage, options.usageFormat || 'responses');
            if (typeof parsed.response.model === 'string') usage.response_model = parsed.response.model;
            if (typeof parsed.response.created_at === 'number' && Number.isFinite(parsed.response.created_at) && parsed.response.created_at > 0) usage.request_timestamp = parsed.response.created_at * 1000;
        }
        return events;
    }

    parse.flush = () => [];
    parse.getResult = () => ({ usage, citations,
        toolCalls: calls.filter(c => c && c.name),
        rawParts: items.slice().sort((a, b) => a.at - b.at).map(x => x.item) });
    return parse;
}

// Agent API de Perplexity : flux de l'API Responses ; sources rangées par numéro (ref), auquel renvoient les « [n] » du texte
function createPerplexityAgentParser(hasThinkingCallback) {
    const base = createOpenAIResponsesParser(hasThinkingCallback);
    const usage = base.getResult().usage;
    const sources = [];
    const addResults = (results) => {
        if (!Array.isArray(results)) return;
        for (const r of results) {
            if (!r || typeof r.url !== 'string' || !/^https?:\/\//i.test(r.url)) continue;
            const n = Number(String(r.id ?? '').replace(/^\D+/, ''));
            const ref = Number.isInteger(n) && n > 0 ? n : null;
            if (ref !== null ? sources.some(s => s.ref === ref) : sources.some(s => s.url === r.url)) continue;
            sources.push({ url: r.url, title: typeof r.title === 'string' ? r.title : '', ...(ref !== null && { ref }) });
        }
        sources.sort((a, b) => (a.ref || 1e9) - (b.ref || 1e9));
    };
    const addQueries = (queries) => {
        if (!Array.isArray(queries)) return;
        for (const q of queries) {
            if (typeof q !== 'string' || !q.trim()) continue;
            usage.web_search_queries = usage.web_search_queries || [];
            if (!usage.web_search_queries.includes(q)) usage.web_search_queries.push(q);
        }
    };
    const addItem = (it) => {
        if (it && it.type === 'search_results') { addQueries(it.queries); addResults(it.results); }
    };

    function parse(parsed) {
        const events = base(parsed);
        const type = parsed && parsed.type;
        if (type === 'response.reasoning.search_queries' || type === 'response.reasoning.fetch_url_queries') {
            events.push({ type: 'searching', what: type === 'response.reasoning.search_queries' ? 'search' : 'fetch' });
        }
        if (type === 'response.reasoning.search_queries') addQueries(parsed.queries);
        if (type === 'response.reasoning.search_results') addResults(parsed.results);
        if (type === 'response.output_item.added' || type === 'response.output_item.done') addItem(parsed.item);
        if (type === 'response.completed' && parsed.response) {
            for (const it of Array.isArray(parsed.response.output) ? parsed.response.output : []) addItem(it);
            const details = parsed.response.usage && parsed.response.usage.tool_calls_details;
            if (details && typeof details === 'object') {
                let searches = null;
                for (const [name, d] of Object.entries(details)) {
                    const count = /^(?:search_web|web_search)$/.test(name) && d ? _apiTokenCount(d.invocation) : null;
                    if (count !== null) searches = (searches || 0) + count;
                }
                if (searches !== null) usage.web_search_requests = searches;
            }
        }
        return events;
    }

    parse.flush = base.flush;
    parse.getResult = () => {
        const result = base.getResult();
        return sources.length ? { ...result, citations: sources.slice() } : result;
    };
    return parse;
}

function chatCompletionsProvider(config) {
    return {
        getHeaders: config.getHeaders,
        getUrl: config.getUrl,
        formatMessages(history) {
            return formatChatCompletionsMessages(history, config.formatOptions);
        },
        buildBody(modelId, messages, systemPrompt, webSearch, modelParams) {
            const convMessages = messages;
            if (systemPrompt) messages = [{ role: 'system', content: systemPrompt }, ...messages];
            const extras = config.bodyExtras ? config.bodyExtras(modelId, webSearch, modelParams) : {};
            const std = modelParams ? {
                temperature: modelParams.temperature,
                top_p: modelParams.top_p,
                max_tokens: modelParams.max_tokens,
                frequency_penalty: modelParams.frequency_penalty,
                presence_penalty: modelParams.presence_penalty
            } : {};
            // Réglages OpenRouter seulement pour lui (un autre fournisseur les refuse) et s'ils sont supportés
            const orExtra = {};
            if (modelParams && config.orParams) {
                const meta = (typeof MODELS !== 'undefined') && MODELS.find(m => m.id === modelId);
                const supported = Array.isArray(meta?.supportedParameters) ? meta.supportedParameters : null;
                const allow = (k) => !supported || supported.includes(k);
                if (modelParams.top_k != null && allow('top_k')) orExtra.top_k = modelParams.top_k;
                if (modelParams.min_p != null && allow('min_p')) orExtra.min_p = modelParams.min_p;
                if (modelParams.top_a != null && allow('top_a')) orExtra.top_a = modelParams.top_a;
                if (modelParams.repetition_penalty != null && allow('repetition_penalty')) orExtra.repetition_penalty = modelParams.repetition_penalty;
                if (modelParams.seed != null && allow('seed')) orExtra.seed = modelParams.seed;
            }
            const body = { model: modelId, messages, stream: true, ...std, ...orExtra, ...extras };
            // Le plafond par défaut de ce fournisseur coupe les longues réponses : maximum du modèle
            if (config.sendMaxOutput && body.max_tokens == null) {
                const max = _maxOutputWithin(modelId, convMessages, systemPrompt);
                if (max) body.max_tokens = max;
            }
            return body;
        },
        createParser(hasThinkingCallback) {
            return createChatCompletionsParser(hasThinkingCallback, config.parserOptions);
        },
        addTools: config.addTools || _chatAddTools,
        toolRound(messages, round, results) {
            return _chatToolRound(messages, round, results, !!config.toolMessageName, !!config.passReasoning);
        },
        noteRound(messages, round, note) {
            return _chatNoteRound(messages, round, note, !!config.passReasoning);
        }
    };
}

// Grok 4.20 désactivé : on appelle sa variante non-reasoning (offModel)
function _grokReasoning(modelId, modelParams) {
    const reasoning = getReasoning(modelId);
    const effort = modelParams?.reasoning_effort;
    return {
        model: reasoning && reasoning.binary && reasoning.offModel && effort === 'minimal' ? reasoning.offModel : modelId,
        effort: reasoning && !reasoning.binary && effort ? effort : null
    };
}

// Tours au plus par recherche xAI (chacun peut lancer plusieurs recherches facturées)
const GROK_SEARCH_MAX_TURNS = 2;

// Recherche sur X (onglet Grok, éteinte par défaut) : 5 $/1000 publications, 10 $/1000 profils
const GROK_X_SEARCH_KEY = 'minou-grok-x-search';
const GROK_X_POST_COST = 0.005;
const GROK_X_USER_COST = 0.01;
function grokXSearchEnabled() {
    try { return localStorage.getItem(GROK_X_SEARCH_KEY) === '1'; } catch (e) { return false; }
}

function _grokProvider() {
    const chat = chatCompletionsProvider({
        getUrl: () => 'https://api.x.ai/v1/chat/completions',
        getHeaders: () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEYS.grok}` }),
        bodyExtras: (modelId, webSearch, modelParams) => {
            const { model, effort } = _grokReasoning(modelId, modelParams);
            // Les Grok 4 à raisonnement refusent les pénalités de fréquence et de présence
            return {
                stream_options: { include_usage: true },
                ...(model !== modelId && { model }),
                ...(effort && { reasoning_effort: effort }),
                frequency_penalty: undefined,
                presence_penalty: undefined
            };
        },
        parserOptions: {
            usageFormat: 'grok',
            extractReasoning: (p) => p.choices?.[0]?.delta?.reasoning_content || null,
            extractCitations: _extractUrlCitations,
            accumulateCitations: true
        }
    });
    return {
        ...chat,
        getUrl: (modelId, webSearch) => webSearch ? 'https://api.x.ai/v1/responses' : 'https://api.x.ai/v1/chat/completions',
        buildBody(modelId, messages, systemPrompt, webSearch, modelParams, opts) {
            if (!webSearch) return chat.buildBody(modelId, messages, systemPrompt, webSearch, modelParams, opts);
            // store: false ; pas de pénalités (refusées par l'API Responses)
            const { model, effort } = _grokReasoning(modelId, modelParams);
            // Recherche sur X si choisie (onglet Grok) : facturée par publication lue
            const body = { model, input: _responsesInput(messages), stream: true, store: false,
                tools: [{ type: 'web_search' }, ...(grokXSearchEnabled() ? [{ type: 'x_search' }] : [])], max_turns: grokSearchMaxTurns(modelParams) };
            if (systemPrompt) body.instructions = systemPrompt;
            if (effort) body.reasoning = { effort };
            if (modelParams?.temperature !== undefined) body.temperature = modelParams.temperature;
            if (modelParams?.top_p !== undefined) body.top_p = modelParams.top_p;
            if (modelParams?.max_tokens !== undefined) body.max_output_tokens = modelParams.max_tokens;
            return body;
        },
        createParser(hasThinkingCallback, webSearch) {
            return webSearch ? createOpenAIResponsesParser(hasThinkingCallback, { usageFormat: 'grok' }) : chat.createParser(hasThinkingCallback);
        }
    };
}

// API Responses pour recherche, outils et résumé du raisonnement affiché ; Chat Completions sinon
function _openaiUsesResponses(modelId, webSearch, withTools, thinking) {
    return !!(webSearch || withTools || (thinking && modelId && getReasoning(modelId)));
}

// Résumé du raisonnement refusé (400) pour une organisation non vérifiée : redemandé un jour plus tard
const OPENAI_SUMMARY_REFUSED_KEY = 'minou-openai-summary-refused';
let _openaiSummaryRefusedAt = null;
function _openaiSummaryAllowed() {
    if (_openaiSummaryRefusedAt === null) {
        let v = NaN;
        try { v = Number(localStorage.getItem(OPENAI_SUMMARY_REFUSED_KEY)); } catch (e) { /* stockage indisponible */ }
        _openaiSummaryRefusedAt = Number.isFinite(v) ? v : 0;
    }
    return Date.now() - _openaiSummaryRefusedAt > 24 * 3600 * 1000;
}

// --- 5. Providers de streaming texte ---

// Recherches au plus par appel (OpenRouter en autorise 30) ; Google n'a pas de réglage
const WEB_SEARCH_MAX_USES = 5;
// modelParams.web_search_max, sinon 5 ; Grok compte en tours : un pour trois recherches, 2 par défaut
function webSearchMaxUses(modelParams) {
    const n = Number(modelParams && modelParams.web_search_max);
    return n >= 1 ? Math.round(n) : WEB_SEARCH_MAX_USES;
}
function grokSearchMaxTurns(modelParams) {
    const n = Number(modelParams && modelParams.web_search_max);
    return n >= 1 ? Math.min(10, Math.max(1, Math.ceil(n / 3))) : GROK_SEARCH_MAX_TURNS;
}

// Correspondance donnée par Perplexity (guide de migration depuis Sonar)
const PERPLEXITY_EFFORT = { 'sonar-pro': 'fast', 'sonar-reasoning-pro': 'low' };

const PROVIDERS = {

    // --- OpenAI ---
    // Responses API pour la recherche ou les outils (Chat Completions les refuse avec raisonnement : GPT-6 Luna)

    openai: {
        getHeaders() {
            return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEYS.openai}` };
        },
        getUrl(modelId, webSearch, withTools, opts) {
            return _openaiUsesResponses(modelId, webSearch, withTools, opts && opts.thinking)
                ? 'https://api.openai.com/v1/responses'
                : 'https://api.openai.com/v1/chat/completions';
        },
        formatMessages(history) {
            return formatChatCompletionsMessages(history);
        },
        buildBody(modelId, messages, systemPrompt, webSearch, modelParams, opts) {
            // Modèle à raisonnement : reasoning_effort, sans température
            const reasoning = getReasoning(modelId);
            const isReasoning = !!reasoning;
            const effort = modelParams?.reasoning_effort || (reasoning && reasoning.default) || 'medium';
            const withTools = !!(opts && opts.tools);
            if (_openaiUsesResponses(modelId, webSearch, withTools, opts && opts.thinking)) {
                // Rien n'est gardé chez OpenAI (store: false)
                const body = { model: modelId, input: _responsesInput(messages), stream: true, store: false };
                if (webSearch) { body.tools = [{ type: 'web_search_preview' }]; body.max_tool_calls = webSearchMaxUses(modelParams); }
                if (systemPrompt) body.instructions = systemPrompt;
                if (!isReasoning && modelParams?.temperature !== undefined) body.temperature = modelParams.temperature;
                if (!isReasoning && modelParams?.top_p !== undefined) body.top_p = modelParams.top_p;
                // Sauf organisation qui ne l'a pas débloqué (_openaiSummaryAllowed)
                if (isReasoning) body.reasoning = { effort, ...(opts && opts.thinking && _openaiSummaryAllowed() && { summary: 'auto' }) };
                if (modelParams?.max_tokens !== undefined) body.max_output_tokens = modelParams.max_tokens;
                // Le raisonnement repart chiffré à chaque aller-retour d'outils (_responsesToolRound)
                if (withTools && isReasoning) body.include = ['reasoning.encrypted_content'];
                return body;
            }
            if (systemPrompt) messages = [{ role: 'system', content: systemPrompt }, ...messages];
            const params = (!isReasoning && modelParams) ? {
                temperature: modelParams.temperature,
                top_p: modelParams.top_p,
                max_tokens: modelParams.max_tokens,
                frequency_penalty: modelParams.frequency_penalty,
                presence_penalty: modelParams.presence_penalty
            } : {};
            return {
                model: modelId, messages, stream: true,
                stream_options: { include_usage: true },
                ...params,
                ...(isReasoning && { reasoning_effort: effort }),
                ...(isReasoning && modelParams?.max_tokens && { max_completion_tokens: modelParams.max_tokens })
            };
        },
        // Les outils passent toujours par l'API Responses (getUrl, buildBody)
        addTools: _responsesAddTools,
        toolRound: _responsesToolRound,
        noteRound: (input, round, note) => [..._responsesToolRound(input, { ...round, calls: [] }, []), { role: 'user', content: note }],
        // Résumé refusé (organisation non vérifiée) : redemandé sans lui, plus demandé pendant un jour
        dropRefusedOption(errText, status) {
            if (status !== 400 || !/reasoning\.summary|verified to generate reasoning summar/i.test(String(errText || ''))) return false;
            if (!_openaiSummaryAllowed()) return false;
            try { localStorage.setItem(OPENAI_SUMMARY_REFUSED_KEY, String(Date.now())); } catch (e) { /* stockage indisponible */ }
            _openaiSummaryRefusedAt = Date.now();
            return true;
        },

        createParser(hasThinkingCallback, webSearch, withTools, modelId) {
            if (_openaiUsesResponses(modelId, webSearch, withTools, hasThinkingCallback)) return createOpenAIResponsesParser(hasThinkingCallback);
            return createChatCompletionsParser(hasThinkingCallback, {
                extractCitations: _extractUrlCitations,
                extractReasoning: (p) => p.choices?.[0]?.delta?.reasoning_content || null,
                accumulateCitations: true
            });
        }
    },

    // --- Anthropic (Messages API) ---

    anthropic: {
        getHeaders() {
            return {
                'Content-Type': 'application/json',
                'x-api-key': API_KEYS.anthropic,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            };
        },

        getUrl() {
            return 'https://api.anthropic.com/v1/messages';
        },

        formatMessages(history) {
            return history.filter(m => m.role !== 'system').map(msg => {
                const out = this._formatMessage(msg);
                // Marqueur de cache avant l'état des fichiers (_cacheBreakpoint d'app.js) : l'historique reste en cache
                if (!msg._cacheBreakpoint) return out;
                const blocks = typeof out.content === 'string' ? [{ type: 'text', text: out.content }] : Array.isArray(out.content) ? out.content.slice() : null;
                if (!blocks || !blocks.length) return out;
                blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
                return { ...out, content: blocks };
            });
        },

        _formatMessage(msg) {
            {
                if (typeof msg.content === 'string') {
                    return { role: msg.role, content: msg.content };
                }
                if (Array.isArray(msg.content)) {
                    const content = [];
                    for (const part of msg.content) {
                        if (part.type === 'text') {
                            content.push({ type: 'text', text: part.text });
                        } else if (part.type === 'image') {
                            if (msg.role === 'assistant') {
                                content.push({ type: 'text', text: '[Image générée]' });
                            } else {
                                content.push({
                                    type: 'image',
                                    source: { type: 'base64', media_type: part.mimeType, data: part.data }
                                });
                            }
                        } else if (part.type === 'file') {
                            if (part.mimeType === 'application/pdf') {
                                content.push({
                                    type: 'document',
                                    source: { type: 'base64', media_type: 'application/pdf', data: part.data }
                                });
                            } else {
                                content.push({ type: 'text', text: `--- Contenu du fichier joint : ${part.name} ---\n${part.textContent || ''}\n--- Fin du fichier ---` });
                            }
                        }
                    }
                    return { role: msg.role, content };
                }
                return { role: msg.role, content: msg.content };
            }
        },

        buildBody(modelId, messages, systemPrompt, webSearch, modelParams) {
            // Mode adaptive avec output_config.effort (Opus 4.7+, Sonnet 5, Fable 5), sinon budget de tokens
            const reasoning = getReasoning(modelId);
            const isThinkingModel = !!reasoning;
            const isAdaptiveThinking = !!reasoning && reasoning.thinking === 'adaptive';
            const effort = modelParams?.reasoning_effort || (reasoning && reasoning.default);
            const body = {
                model: modelId,
                max_tokens: modelParams?.max_tokens || claudeDefaultMaxTokens(modelId),
                messages,
                stream: true
            };
            if (isThinkingModel) {
                if (isAdaptiveThinking) {
                    // Sans display, réflexion vide (« omitted ») ; « summarized » donne un résumé lisible
                    body.thinking = { type: 'adaptive', display: 'summarized' };
                    const effortMap = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
                    body.output_config = { effort: effortMap[effort] || 'medium' };
                } else {
                    // Budget : < max_tokens (sinon 400) et ≥ 1024 ; « Tokens max » trop bas : sans réflexion
                    const budgetMap = { minimal: 2000, low: 4000, medium: 10000, high: 20000 };
                    const budget = Math.min(budgetMap[effort] || 10000, body.max_tokens - 1024);
                    if (budget >= 1024) body.thinking = { type: 'enabled', budget_tokens: budget };
                }
                // temperature doit rester à 1 avec thinking : paramètre utilisateur ignoré
            } else {
                if (modelParams?.temperature !== undefined) body.temperature = modelParams.temperature;
                if (modelParams?.top_p !== undefined) body.top_p = modelParams.top_p;
            }
            if (systemPrompt) body.system = systemPrompt;
            if (webSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: webSearchMaxUses(modelParams) }];
            return body;
        },

        // eager_input_streaming : sans lui, Anthropic retient chaque paramètre entier avant de l'envoyer
        addTools(body, specs) {
            body.tools = specs.map(s => ({ name: s.name, description: s.description, input_schema: s.parameters, eager_input_streaming: true }));
            return body;
        },
        toolRound(messages, round, results) {
            const content = (round.blocks || []).filter(b => b && !(b.type === 'text' && !b.text.trim()));
            return [...messages,
                { role: 'assistant', content },
                { role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.result, ...(r.isError ? { is_error: true } : {}) })) }];
        },
        noteRound(messages, round, note) {
            const content = (round.blocks || []).filter(b => b && !(b.type === 'text' && !b.text.trim()));
            return [...messages, ...(content.length ? [{ role: 'assistant', content }] : []), { role: 'user', content: note }];
        },
        // pause_turn : tour renvoyé tel quel, sans nouveau message ; Anthropic le continue
        resumePaused(messages, round) {
            const content = (round.blocks || []).filter(b => b && !(b.type === 'text' && !b.text.trim()));
            if (!content.length) return messages;
            return [...messages, { role: 'assistant', content }];
        },

        createParser() {
            let usage = { input_tokens: 0, output_tokens: 0, request_timestamp: Date.now() };
            let citations = [];
            let currentBlockType = null;
            // Blocs de la réponse, renvoyés avec les résultats des outils
            const blocks = [];

            function parse(parsed) {
                const events = [];
                if (parsed.type === 'content_block_start' && Number.isInteger(parsed.index)) {
                    const cb = parsed.content_block || {};
                    // server_tool_use gardés tels quels : un tour mis en pause est renvoyé entier (resumePaused)
                    blocks[parsed.index] = cb.type === 'tool_use' || cb.type === 'server_tool_use' ? { type: cb.type, id: cb.id, name: cb.name, input: {}, json: '' }
                        : cb.type === 'thinking' ? { type: 'thinking', thinking: cb.thinking || '', signature: cb.signature || '' }
                        : cb.type === 'redacted_thinking' ? { type: 'redacted_thinking', data: cb.data }
                        : cb.type === 'text' ? { type: 'text', text: cb.text || '' }
                        : /_tool_result$/.test(cb.type || '') ? { ...cb, raw: true } : null;
                }
                if (parsed.type === 'content_block_delta' && Number.isInteger(parsed.index) && blocks[parsed.index]) {
                    const b = blocks[parsed.index], d = parsed.delta || {};
                    if (d.type === 'text_delta' && b.type === 'text') b.text += d.text || '';
                    else if (d.type === 'citations_delta' && b.type === 'text' && d.citation) (b.citations || (b.citations = [])).push(d.citation);
                    else if (d.type === 'thinking_delta' && b.type === 'thinking') b.thinking += d.thinking || '';
                    else if (d.type === 'signature_delta' && b.type === 'thinking') b.signature += d.signature || '';
                    else if (d.type === 'input_json_delta' && (b.type === 'tool_use' || b.type === 'server_tool_use')) b.json += d.partial_json || '';
                }
                if (parsed.type === 'content_block_stop' && Number.isInteger(parsed.index)) {
                    const b = blocks[parsed.index];
                    if (b && (b.type === 'tool_use' || b.type === 'server_tool_use')) {
                        b.done = true;
                        try { b.input = b.json.trim() ? JSON.parse(b.json) : {}; } catch (e) { b.input = _lenientToolArgs(b.json); }
                    }
                }
                if (parsed.type === 'content_block_start') {
                    currentBlockType = parsed.content_block?.type || null;
                    if (parsed.content_block?.type === 'server_tool_use') {
                        events.push({ type: 'searching', what: /fetch/i.test(parsed.content_block.name || '') ? 'fetch' : 'search' });
                    }
                    if (parsed.content_block?.type === 'web_search_tool_result') {
                        const results = parsed.content_block.content || [];
                        for (const r of results) {
                            if (r.type === 'web_search_result' && r.url) {
                                citations.push({ url: r.url, title: r.title || '' });
                            }
                        }
                    }
                }
                if (parsed.type === 'content_block_delta') {
                    if (currentBlockType === 'thinking' && parsed.delta?.thinking) {
                        events.push({ type: 'thinking', data: parsed.delta.thinking });
                    } else if (parsed.delta?.text) {
                        events.push({ type: 'chunk', data: parsed.delta.text });
                    }
                }
                if (parsed.type === 'message_start' && parsed.message?.usage) {
                    _mergeTokenUsage(usage, parsed.message.usage, 'anthropic');
                    if (typeof parsed.message.model === 'string') usage.response_model = parsed.message.model;
                }
                if (parsed.type === 'message_delta' && parsed.usage) {
                    _mergeTokenUsage(usage, parsed.usage, 'anthropic');
                }
                if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) usage.finish_reason = parsed.delta.stop_reason;
                if (parsed.type === 'error') usage.stream_error = String(parsed.error?.message || 'erreur inconnue');
                return events;
            }

            parse.flush = () => [];
            parse.getResult = () => {
                const list = blocks.filter(Boolean);
                return {
                    usage, citations,
                    // Appel incomplet : arguments partiels seulement (_partialToolArgs pour l'écriture en direct)
                    toolCalls: list.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, ...(b.done ? { args: b.input } : {}), arguments: b.json })),
                    assistantBlocks: list.map(b => b.type === 'tool_use' || b.type === 'server_tool_use' ? { type: b.type, id: b.id, name: b.name, input: b.input || {} }
                        : b.raw ? (({ raw, ...rest }) => rest)(b) : b)
                };
            };
            return parse;
        }
    },

    // --- Google Gemini (generateContent SSE) ---

    google: {
        getHeaders() {
            return { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEYS.google };
        },

        getUrl(modelId) {
            return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
        },

        formatMessages(history) {
            return history.filter(m => m.role !== 'system').map(msg => {
                if (typeof msg.content === 'string') {
                    return {
                        role: msg.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: msg.content }]
                    };
                }
                if (Array.isArray(msg.content)) {
                    const parts = [];
                    for (const part of msg.content) {
                        if (part.type === 'text') {
                            parts.push({ text: part.text });
                        } else if (part.type === 'image') {
                            if (msg.role === 'assistant') {
                                parts.push({ text: '[Image générée]' });
                            } else {
                                parts.push({ inline_data: { mime_type: part.mimeType, data: part.data } });
                            }
                        } else if (part.type === 'file') {
                            if (part.mimeType === 'application/pdf') {
                                parts.push({ inline_data: { mime_type: 'application/pdf', data: part.data } });
                            } else {
                                parts.push({ text: `--- Contenu du fichier joint : ${part.name} ---\n${part.textContent || ''}\n--- Fin du fichier ---` });
                            }
                        }
                    }
                    return {
                        role: msg.role === 'assistant' ? 'model' : 'user',
                        parts
                    };
                }
                return {
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: msg.content }]
                };
            });
        },

        buildBody(modelId, messages, systemPrompt, webSearch, modelParams) {
            const body = { contents: messages };
            if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
            if (webSearch) body.tools = [{ google_search: {} }];
            body.generationConfig = {};
            // Gemini 3.8 rejette temperature et top_p ; Argon les ignore (Google : les retirer)
            const noSampling = modelId === 'gemini-3.8-flash' || modelId === 'gemini-4-argon';
            // thinkingLevel parmi les niveaux du modèle (binaire : minimal ou high) ; inconnu → niveau par défaut
            const reasoning = getReasoning(modelId);
            if (reasoning) {
                const thinkingConfig = { includeThoughts: true };
                const effort = modelParams?.reasoning_effort;
                if (effort) {
                    const level = reasoning.binary ? (effort === 'high' ? 'high' : 'minimal')
                        : reasoning.levels.includes(effort) ? effort : (reasoning.default || 'medium');
                    thinkingConfig.thinkingLevel = (reasoning.send && reasoning.send[level]) || level;
                }
                body.generationConfig.thinkingConfig = thinkingConfig;
            }
            if (!noSampling && modelParams?.temperature !== undefined) body.generationConfig.temperature = modelParams.temperature;
            if (!noSampling && modelParams?.top_p !== undefined) body.generationConfig.topP = modelParams.top_p;
            if (modelParams?.max_tokens !== undefined) body.generationConfig.maxOutputTokens = modelParams.max_tokens;
            return body;
        },

        // Tour du modèle renvoyé tel quel : Gemini 3 exige ses signatures de raisonnement
        addTools(body, specs) {
            body.tools = [{ functionDeclarations: specs.map(s => ({ name: s.name, description: s.description, parameters: s.parameters })) }];
            return body;
        },
        toolRound(contents, round, results) {
            return [...contents,
                { role: 'model', parts: _geminiModelParts(round.rawParts) },
                { role: 'user', parts: results.map(r => ({ functionResponse: { ...(r.id && !r.syntheticId ? { id: r.id } : {}), name: r.name, response: { result: r.result } } })) }];
        },
        noteRound(contents, round, note) {
            const parts = _geminiModelParts(round.rawParts);
            return [...contents, ...(parts.length ? [{ role: 'model', parts }] : []), { role: 'user', parts: [{ text: note }] }];
        },
        retryMalformed(contents, round) {
            const note = { text: 'Ton dernier appel de fonction était mal formé et n\'a pas été exécuté. Réessaie avec un appel valide (arguments JSON corrects ; pour un gros fichier, plusieurs edit_file plutôt qu\'un seul write_file).' };
            const parts = _geminiModelParts(round.rawParts);
            if (parts.length) return [...contents, { role: 'model', parts }, { role: 'user', parts: [note] }];
            const out = contents.slice();
            const last = out[out.length - 1];
            if (last && last.role === 'user') out[out.length - 1] = { ...last, parts: [...(last.parts || []), note] };
            else out.push({ role: 'user', parts: [note] });
            return out;
        },

        createParser() {
            let usage = { input_tokens: 0, output_tokens: 0, request_timestamp: Date.now() };
            let citations = [];
            // Parties de la réponse, renvoyées avec les résultats des fonctions
            const rawParts = [];
            const calls = [];

            function parse(parsed) {
                const events = [];
                const parts = parsed.candidates?.[0]?.content?.parts || [];
                for (const part of parts) {
                    if (!part || typeof part !== 'object') continue;
                    if (part.functionCall) {
                        calls.push({ id: part.functionCall.id || '', name: part.functionCall.name || '', args: part.functionCall.args || {} });
                        rawParts.push(JSON.parse(JSON.stringify(part)));
                        continue;
                    }
                    if (part.thought && part.text) {
                        events.push({ type: 'thinking', data: part.text });
                    } else if (part.text) {
                        events.push({ type: 'chunk', data: part.text });
                    }
                    const last = rawParts[rawParts.length - 1];
                    if (typeof part.text === 'string' && last && !last.functionCall && typeof last.text === 'string'
                        && !!last.thought === !!part.thought && !last.thoughtSignature) {
                        last.text += part.text;
                        if (part.thoughtSignature) last.thoughtSignature = part.thoughtSignature;
                    } else if (typeof part.text === 'string' || part.thoughtSignature) {
                        rawParts.push({ ...part });
                    }
                }
                if (parsed.usageMetadata) {
                    _mergeTokenUsage(usage, parsed.usageMetadata, 'google');
                }
                const finish = parsed.candidates?.[0]?.finishReason;
                if (typeof finish === 'string' && finish) usage.finish_reason = finish;
                // Demande bloquée ou erreur dans le flux : explique une réponse vide
                const blocked = parsed.promptFeedback?.blockReason;
                if (typeof blocked === 'string' && blocked) usage.finish_reason = 'SAFETY';
                if (parsed.error) usage.stream_error = String(parsed.error.message || parsed.error.status || 'erreur inconnue');
                const grounding = parsed.candidates?.[0]?.groundingMetadata;
                if (Array.isArray(grounding?.webSearchQueries)) {
                    for (const q of grounding.webSearchQueries) {
                        if (typeof q !== 'string' || !q.trim()) continue;
                        usage.web_search_queries = usage.web_search_queries || [];
                        if (!usage.web_search_queries.includes(q)) usage.web_search_queries.push(q);
                    }
                    if (usage.web_search_queries) usage.web_search_requests = usage.web_search_queries.length;
                }
                if (grounding?.groundingChunks) {
                    for (const chunk of grounding.groundingChunks) {
                        if (chunk.web?.uri) {
                            if (!citations.some(c => c.url === chunk.web.uri)) {
                                citations.push({ url: chunk.web.uri, title: chunk.web.title || '' });
                            }
                        }
                    }
                }
                return events;
            }

            parse.flush = () => [];
            parse.getResult = () => ({ usage, citations, toolCalls: calls.filter(c => c.name), rawParts,
                malformed: /MALFORMED_FUNCTION_CALL/i.test(usage.finish_reason || '') });
            return parse;
        }
    },

    // --- Perplexity (Agent API) ---
    // Chat Completions de Sonar arrêtées le 27 septembre 2026 (réponses sans en-tête CORS depuis)

    perplexity: {
        getHeaders: () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEYS.perplexity}` }),
        getUrl: () => 'https://api.perplexity.ai/v1/agent',
        formatMessages(history) {
            return formatChatCompletionsMessages(history, { textOnly: true });
        },
        buildBody(modelId, messages, systemPrompt, webSearch, modelParams) {
            // Consignes en message système : `instructions` remplacerait celles du niveau (format des renvois)
            const input = [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), ...messages]
                .map(m => ({ type: 'message', role: m.role, content: m.content }));
            const body = { effort: PERPLEXITY_EFFORT[modelId] || 'fast', input, stream: true };
            if (modelParams?.max_tokens) body.max_output_tokens = modelParams.max_tokens;
            return body;
        },
        createParser(hasThinkingCallback) {
            return createPerplexityAgentParser(hasThinkingCallback);
        }
    },

    // --- Mistral (Chat Completions) ---

    mistral: chatCompletionsProvider({
        getUrl: () => 'https://api.mistral.ai/v1/chat/completions',
        getHeaders: () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEYS.mistral}` }),
        toolMessageName: true,
        formatOptions: { trimTrailingAssistant: true },
        bodyExtras: (modelId, webSearch, modelParams) => {
            // Raisonnement binaire reasoning_effort "high"|"none" ; arrive en chunks typés dans delta.content
            const reasoning = getReasoning(modelId);
            const effort = modelParams?.reasoning_effort;
            return {
                stream_options: { include_usage: true },
                ...(reasoning && effort && { reasoning_effort: reasoning.binary ? (effort === 'minimal' ? 'none' : 'high') : effort })
            };
        }
    }),

    // --- DeepSeek (Chat Completions) ---

    deepseek: chatCompletionsProvider({
        // Sans max_tokens : 8 000 jetons hors raisonnement
        sendMaxOutput: true,
        getUrl: () => 'https://api.deepseek.com/chat/completions',
        getHeaders: () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEYS.deepseek}` }),
        bodyExtras: (modelId, webSearch, modelParams) => {
            // deepseek-chat binaire : activé, on appelle deepseek-reasoner (onModel)
            const reasoning = getReasoning(modelId);
            const isCurrentModel = !!reasoning && !reasoning.binary;
            const effort = modelParams?.reasoning_effort;
            const useReasoner = !!reasoning && reasoning.binary && !!reasoning.onModel && effort === 'high';
            return {
                stream_options: { include_usage: true },
                ...(useReasoner && { model: reasoning.onModel }),
                ...(isCurrentModel && {
                    thinking: { type: effort === 'none' ? 'disabled' : 'enabled' },
                    reasoning_effort: effort || reasoning.default || 'high',
                    temperature: undefined,
                    top_p: undefined,
                    frequency_penalty: undefined,
                    presence_penalty: undefined
                })
            };
        },
        parserOptions: {
            extractReasoning: (p) => p.choices?.[0]?.delta?.reasoning_content || null
        }
    }),

    // --- Grok / xAI ---
    // Recherche web par l'API Responses : Live Search (search_parameters) répond 410

    grok: _grokProvider(),

    // --- Z.ai / Zhipu GLM (Chat Completions) ---

    zai: chatCompletionsProvider({
        // Sans max_tokens : 65 536 jetons, pour 131 072 au plus
        sendMaxOutput: true,
        // « / » final : sans lui, le CORS de Z.ai refuse
        getUrl: () => 'https://api.z.ai/api/paas/v4/chat/completions/',
        getHeaders: () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEYS.zai}` }),
        // tool_stream : arguments reçus au fil de l'écriture
        addTools: (body, specs) => ({ ..._chatAddTools(body, specs), tool_stream: true }),
        passReasoning: true,
        bodyExtras: (modelId, webSearch, modelParams) => {
            // GLM-5.3 : raisonnement obligatoire avec niveau ; tâches annexes (sans modelParams) : sans réflexion
            const reasoning = getReasoning(modelId);
            const effort = modelParams ? (modelParams.reasoning_effort || (reasoning && reasoning.default))
                : (reasoning && reasoning.binary ? null : reasoning && reasoning.default);
            return {
                stream_options: { include_usage: true },
                ...(reasoning && reasoning.binary && { thinking: { type: effort === 'high' ? 'enabled' : 'disabled' } }),
                ...(reasoning && !reasoning.binary && {
                    thinking: { type: 'enabled' },
                    reasoning_effort: effort || reasoning.default || 'max'
                })
            };
        },
        parserOptions: {
            extractReasoning: (p) => p.choices?.[0]?.delta?.reasoning_content || null
        }
    }),

    // --- Local : Ollama ---

    ollama: chatCompletionsProvider({
        getUrl: () => `${API_KEYS.ollama.replace(/\/+$/, '')}/v1/chat/completions`,
        getHeaders: () => ({ 'Content-Type': 'application/json' }),
        formatOptions: { collapseTextOnly: true },
        bodyExtras: () => ({ stream_options: { include_usage: true } })
    }),

    // --- Local : LM Studio ---

    lmstudio: chatCompletionsProvider({
        getUrl: () => `${API_KEYS.lmstudio.replace(/\/+$/, '')}/v1/chat/completions`,
        getHeaders: () => ({ 'Content-Type': 'application/json' }),
        formatOptions: { collapseTextOnly: true },
        bodyExtras: () => ({ stream_options: { include_usage: true } })
    }),

    // --- OpenRouter (texte et images) ---

    openrouter: chatCompletionsProvider({
        orParams: true,
        getUrl: () => 'https://openrouter.ai/api/v1/chat/completions',
        getHeaders: () => ({
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEYS.openrouter}`,
            'HTTP-Referer': 'https://davidtwentyai.local/',
            'X-Title': 'DavidTwentyAI'
        }),
        // usage.cost et compteurs de cache arrivent seuls dans le dernier chunk, web_search/web_fetch compris
        bodyExtras: (modelId, webSearch, modelParams) => {
            const meta = (typeof MODELS !== 'undefined') && MODELS.find(m => m.id === modelId);
            const reasons = !!(meta && Array.isArray(meta.supportedParameters) && meta.supportedParameters.includes('reasoning'));
            // Modèle sans outils : OpenRouter refuse aussi ses outils de recherche (« No endpoints found that support tool use ») ; le globe est masqué (app.js)
            const toolsOk = !(meta && Array.isArray(meta.supportedParameters) && meta.supportedParameters.length && !meta.supportedParameters.includes('tools'));
            return {
                ...(webSearch && toolsOk && {
                    tools: [
                        { type: 'openrouter:web_search', parameters: { max_uses: webSearchMaxUses(modelParams) } },
                        { type: 'openrouter:web_fetch' }
                    ]
                }),
                ...(reasons && modelParams?.reasoning_effort && { reasoning: { effort: modelParams.reasoning_effort } })
            };
        },
        parserOptions: {
            extractCitations: _extractUrlCitations,
            accumulateCitations: true,
            // OpenRouter envoie le raisonnement à part (delta.reasoning), jamais dans le texte
            extractReasoning: (p) => {
                const r = p.choices?.[0]?.delta?.reasoning;
                return typeof r === 'string' && r ? r : null;
            }
        }
    })
};

// --- 6. streamModel() — dispatcher générique ---

// --- Cache des conversations ---
// Anthropic : marqueurs requis (4 au plus) ; OpenAI/Mistral/xAI : clé de conversation ; OpenRouter : session_id

// Empreinte du premier message : aucune donnée personnelle dans la clé
function _conversationCacheKey(history) {
    const first = Array.isArray(history) ? history.find(m => m && m.role === 'user') : null;
    const c = first && first.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n') : '';
    if (!text.trim()) return '';
    let h = 0x811c9dc5;
    const src = text.slice(0, 2000);
    for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return 'davidtwentyai-' + h.toString(16).padStart(8, '0');
}

function _markSystemMessage(messages) {
    if (!Array.isArray(messages)) return messages;
    const i = messages.findIndex(m => m && m.role === 'system');
    if (i < 0 || typeof messages[i].content !== 'string' || !messages[i].content.trim()) return messages;
    const out = messages.slice();
    out[i] = { ...messages[i], content: [{ type: 'text', text: messages[i].content, cache_control: { type: 'ephemeral' } }] };
    return out;
}

function _enableConversationCache(editeur, body, modelId, cacheKey) {
    if (editeur === 'anthropic') {
        const out = { ...body, cache_control: { type: 'ephemeral' } };
        if (typeof body.system === 'string' && body.system.trim()) out.system = [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }];
        return out;
    }
    if ((editeur === 'openai' || editeur === 'mistral') && cacheKey) return { ...body, prompt_cache_key: cacheKey };
    // Grok, API Responses : prompt_cache_key (Chat Completions : en-tête x-grok-conv-id)
    if (editeur === 'grok' && cacheKey && Array.isArray(body.input)) return { ...body, prompt_cache_key: cacheKey };
    if (editeur === 'openrouter') return _enableOpenRouterConversationCache({ ...body, ...(cacheKey && { session_id: cacheKey }) }, modelId);
    return body;
}

function _enableOpenRouterConversationCache(body, modelId) {
    if (/^~?anthropic\/claude-(?:3[.-]|(?:opus|sonnet|haiku|fable)-)/.test(modelId)) {
        // Durée par défaut de 5 minutes : ne pas imposer le tarif d'écriture 1h
        return { ...body, cache_control: { type: 'ephemeral' }, messages: _markSystemMessage(body.messages) };
    }
    // Alibaba n'accepte que des marqueurs sur les blocs : seulement les IDs documentés
    const explicitModels = ['deepseek/deepseek-v3.2', 'qwen/qwen3-max', 'qwen/qwen-plus',
        'qwen/qwen3.6-plus', 'qwen/qwen3-coder-plus', 'qwen/qwen3-coder-flash'];
    if (!explicitModels.includes(modelId) || !Array.isArray(body.messages)) return body;
    for (let i = body.messages.length - 1; i >= 0; i--) {
        const message = body.messages[i];
        const content = message.content;
        let cachedContent;
        if (typeof content === 'string' && content.trim()) {
            cachedContent = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
        } else if (Array.isArray(content)) {
            // Marquer le dernier bloc de texte, jamais une image : il cache tout le préfixe
            for (let j = content.length - 1; j >= 0; j--) {
                if (content[j]?.type !== 'text' || typeof content[j].text !== 'string' || !content[j].text.trim()) continue;
                cachedContent = content.slice();
                cachedContent[j] = { ...content[j], cache_control: { type: 'ephemeral' } };
                break;
            }
        }
        if (cachedContent) {
            const messages = body.messages.slice();
            messages[i] = { ...message, content: cachedContent };
            return { ...body, messages };
        }
    }
    return body;
}

// app.js l'affiche en bloc « Recherche web » et le retire du texte envoyé, copié ou lu
function _webSearchAnchor(from) {
    return `\n\n<div class="web-search-anchor" data-from="${from}"></div>\n\n`;
}

// onActivity : { type: 'data' | 'sources' | 'end' } ; avec lui, repère de recherche web dans le texte
// Cinq reprises au plus, comme l'exemple de la documentation d'Anthropic
const PAUSED_TURN_MAX_RESUMES = 5;

// LM Studio « Require Authentication » : DavidTwentyAI n'envoie pas de jeton
function _localAuthMessage(editeur) {
    return editeur === 'lmstudio'
        ? 'LM Studio demande un jeton d\'API, que DavidTwentyAI n\'envoie pas. Dans LM Studio, onglet Developer › Server Settings, désactivez « Require Authentication ».'
        : 'Le serveur Ollama refuse la requête (authentification demandée). Vérifiez sa configuration.';
}

async function streamModel(modelId, conversationHistory, onChunk, onDone, onError, systemPrompt, webSearch, onThinkingChunk, signal, modelParams, onActivity, opts) {
    const activity = (ev) => {
        if (typeof onActivity !== 'function') return;
        try { onActivity(ev); } catch (e) { console.error('[streamModel] onActivity :', e); }
    };
    const editeur = getModelEditeur(modelId) || getSearchModelEditeur(modelId);
    const provider = PROVIDERS[editeur];
    if (!provider) { activity({ type: 'end' }); onError(new Error(`Éditeur inconnu pour le modèle ${modelId}`)); return; }

    if (_lastLocalModel && _lastLocalModel.id !== modelId) {
        unloadLocalModel(_lastLocalModel.id, _lastLocalModel.editeur);
        _lastLocalModel = null;
    }
    if (isLocalEditeur(editeur)) _lastLocalModel = { id: modelId, editeur };

    // Pas d'outils avec la recherche web, ni chez un fournisseur sans aller-retour
    const tools = opts && opts.tools && Array.isArray(opts.tools.specs) && opts.tools.specs.length && !webSearch
        && typeof provider.addTools === 'function' && typeof provider.toolRound === 'function' ? opts.tools : null;
    // Passés aussi à un arrêt (troisième argument de onDone) : leur coût est déjà facturé
    let total = null;
    let allCitations = [];

    try {
        let messages = provider.formatMessages(conversationHistory);

        // Sinon le « Failed to fetch » du navigateur (CORS, serveur éteint) remonterait tel quel
        if (isLocalEditeur(editeur)) {
            const url = API_KEYS[editeur];
            if (!url) throw new Error(`URL du serveur ${editeur === 'ollama' ? 'Ollama' : 'LM Studio'} requise. Renseignez-la dans Configuration.`);
            const baseUrl = url.replace(/\/+$/, '');
            let pingStatus = 0;
            try {
                const ping = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
                pingStatus = ping.status;
                if (!ping.ok) throw new Error('ping-failed');
            } catch {
                if (pingStatus === 401 || pingStatus === 403) throw new Error(_localAuthMessage(editeur));
                throw new Error(`Serveur ${editeur === 'ollama' ? 'Ollama' : 'LM Studio'} injoignable. Vérifiez qu'il soit bien lancé et que CORS est activé (voir Configuration).`);
            }
        }

        total = null;
        let firstInput = 0;
        const cacheKey = _conversationCacheKey(conversationHistory);
        allCitations = [];
        let malformedRetries = 0;
        let fakeNotes = 0;
        let optionDropped = false;
        let pauses = 0;
        let sepPending = false;
        let lastEmitted = '';
        // Pour l'alerte de coût : { calls: [{ name, args }] }, { pause: true } ou { malformed: true }
        let nextStep = null;
        for (let round = 1; ; round++) {
            // Alerte de coût (app.js, turnBudgetAllows) : chaque aller-retour relit tout le contexte
            if (round > 1 && tools && typeof tools.beforeRound === 'function') {
                let go = true;
                try { go = await tools.beforeRound(total, nextStep); } catch (e) { console.error('[streamModel] alerte de coût :', e); }
                if (signal && signal.aborted) break;
                if (!go) { total.budget_stopped = true; break; }
            }
            let response;
            const requestTimestamp = Date.now();
            const thinking = !!onThinkingChunk;
            try {
                let requestBody = provider.buildBody(modelId, messages, systemPrompt, webSearch, modelParams, { tools: !!tools, thinking });
                if (tools) requestBody = provider.addTools(requestBody, tools.specs);
                requestBody = _enableConversationCache(editeur, requestBody, modelId, cacheKey);
                const headers = editeur === 'grok' && cacheKey ? { ...provider.getHeaders(), 'x-grok-conv-id': cacheKey } : provider.getHeaders();
                response = await fetch(provider.getUrl(modelId, webSearch, !!tools, { thinking }), {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(requestBody),
                    signal
                });
            } catch (netErr) {
                if (netErr?.name === 'AbortError') throw netErr;
                if (isLocalEditeur(editeur)) {
                    throw new Error(`Serveur ${editeur === 'ollama' ? 'Ollama' : 'LM Studio'} injoignable pendant l'envoi du message. Vérifiez qu'il soit toujours lancé et que CORS est activé.`);
                }
                const name = (typeof EDITEUR_LABELS !== 'undefined' && EDITEUR_LABELS[editeur]) || editeur;
                throw new Error(`Connexion à ${name} impossible. Vérifiez votre connexion réseau, puis réessayez.`);
            }

            if (!response.ok) {
                const err = await response.text();
                // Option refusée (OpenAI : résumé du raisonnement, organisation non vérifiée) : même requête sans elle
                if (!optionDropped && typeof provider.dropRefusedOption === 'function' && provider.dropRefusedOption(err, response.status)) {
                    optionDropped = true;
                    round--;
                    continue;
                }
                if (isLocalEditeur(editeur) && (response.status === 401 || response.status === 403)) throw new Error(_localAuthMessage(editeur));
                throw new Error(`${editeur} API error ${response.status}: ${err}`);
            }

            const parse = provider.createParser(!!onThinkingChunk, webSearch, !!tools, modelId);
            parse.getResult().usage.request_timestamp = requestTimestamp;

            // Repère de recherche web jamais au milieu d'une ligne : il attend la fin de la ligne
            // Modèle qui cherche avant d'écrire (Perplexity, Sonar par OpenRouter) : ses sources arrivent en cours de texte, le bloc va dessous
            const anchorsInText = editeur !== 'perplexity' && !(typeof hasBuiltInWebSearch === 'function' && hasBuiltInWebSearch(modelId));
            let sourcesSeen = 0;
            let textSinceAnchor = true;
            let atLineStart = true;
            let pendingAnchor = null;
            let roundText = '';
            const out = (text) => {
                if (!text) return;
                lastEmitted = (lastEmitted + text).slice(-2);
                onChunk(text);
            };
            const emitText = (text) => {
                roundText += text;
                if (sepPending && text.trim()) {
                    sepPending = false;
                    if (lastEmitted && !/\n\n$/.test(lastEmitted)) text = (lastEmitted.endsWith('\n') ? '\n' : '\n\n') + text.replace(/^\n+/, '');
                }
                if (pendingAnchor !== null) {
                    const nl = text.indexOf('\n');
                    if (nl < 0) { out(text); return; }
                    out(text.slice(0, nl + 1));
                    out(_webSearchAnchor(pendingAnchor));
                    pendingAnchor = null;
                    atLineStart = true;
                    text = text.slice(nl + 1);
                    if (!text) return;
                }
                out(text);
                if (text.trim()) textSinceAnchor = true;
                atLineStart = text.endsWith('\n');
            };
            // Chaque appel repasse dans l'ordre, sinon un appel bref aurait son badge après le suivant
            let progressAt = 0;
            let progressFrom = 0;
            let toolShown = '';
            // Mise à jour retenue par l'espacement de 120 ms : faite juste après, sinon fichier vide jusqu'à la fin
            let progressTimer = null;
            let streamDone = false;
            // Appels terminés appliqués aussitôt pour le volet ; pas search_web (runNow répond undefined)
            const early = new Map();
            const runFinishedCalls = () => {
                if (!tools || typeof tools.runNow !== 'function' || (signal && signal.aborted)) return;
                const calls = parse.getResult().toolCalls || [];
                for (let i = early.size; i < calls.length; i++) {
                    const c = calls[i];
                    if (!c || !c.name) return;
                    let args = c.args;
                    // Chat Completions (OpenRouter, Mistral, DeepSeek…) : arguments en texte jusqu'à la fin ; un appel est fini quand le suivant commence
                    if (args === undefined && calls[i + 1] && calls[i + 1].name) {
                        try { args = JSON.parse(c.arguments || '{}'); } catch (e) { return; }
                    }
                    if (!args || typeof args !== 'object' || Array.isArray(args)) return;
                    let res;
                    try { res = tools.runNow({ name: c.name, args }); } catch (e) { res = 'Erreur : ' + (e && e.message ? e.message : e); }
                    if (res === undefined) return;
                    early.set(i, String(res == null ? '' : res));
                    onChunk('');
                }
            };
            const showProgress = (force) => {
                if (!tools || typeof tools.progress !== 'function') return;
                const now = Date.now();
                if (!force && now - progressAt < 120) {
                    if (!progressTimer) progressTimer = setTimeout(() => { progressTimer = null; if (!streamDone) showProgress(true); }, 120 - (now - progressAt));
                    return;
                }
                if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
                const calls = parse.getResult().toolCalls || [];
                if (!calls.length) return;
                progressAt = now;
                let last = null;
                // Les appels déjà appliqués ne repassent pas (le volet les remontrerait en cours d'écriture)
                for (let i = Math.max(Math.min(progressFrom, calls.length - 1), early.size); i < calls.length; i++) {
                    const call = calls[i];
                    if (!call || !call.name) continue;
                    const args = call.args && typeof call.args === 'object' ? call.args : _partialToolArgs(call.arguments || '');
                    try { tools.progress({ name: call.name, args }); } catch (e) { console.error('[streamModel] progression d\'outil :', e); }
                    last = { name: call.name, target: typeof args.name === 'string' && args.__open !== 'name' ? args.name.trim() : '' };
                }
                progressFrom = calls.length - 1;
                if (last && last.name + '|' + last.target !== toolShown) {
                    toolShown = last.name + '|' + last.target;
                    activity({ type: 'tool', name: last.name, target: last.target });
                }
                onChunk('');
            };
            for await (const raw of readSSE(response)) {
                let wrote = false, thought = false;
                for (const event of parse(raw)) {
                    if (event.type === 'chunk') { emitText(event.data); wrote = true; }
                    else if (event.type === 'thinking' && onThinkingChunk && event.data) { onThinkingChunk(event.data); thought = true; }
                    else if (event.type === 'searching') activity({ type: 'searching', what: event.what });
                }
                if (tools) { runFinishedCalls(); showProgress(false); }
                if (wrote) activity({ type: 'data' });
                else if (thought) activity({ type: 'data', thinking: true });
                const { citations } = parse.getResult();
                if (citations.length !== sourcesSeen) {
                    if (onActivity && anchorsInText && textSinceAnchor && pendingAnchor === null && citations.length > sourcesSeen) {
                        if (atLineStart) out(_webSearchAnchor(sourcesSeen));
                        else pendingAnchor = sourcesSeen;
                        textSinceAnchor = false;
                    }
                    sourcesSeen = citations.length;
                    activity({ type: 'sources', sources: citations.slice() });
                }
            }

            streamDone = true;
            if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
            for (const event of parse.flush()) {
                if (event.type === 'chunk') emitText(event.data);
                else if (event.type === 'thinking' && onThinkingChunk && event.data) onThinkingChunk(event.data);
            }
            if (pendingAnchor !== null) out(_webSearchAnchor(pendingAnchor));

            const result = parse.getResult();
            result.usage.api_calls = 1;
            // Le seuil du tarif long contexte vaut par requête (app.js, _textCostDetails)
            result.usage.max_call_input_tokens = result.usage.input_tokens || 0;
            total = total ? _addUsage(total, result.usage) : result.usage;
            if (round === 1) firstInput = result.usage.input_tokens || 0;
            // Premier appel tel quel (Perplexity : des adresses), puis les suivants sans doublon
            if (round === 1) allCitations = result.citations || [];
            else {
                const key = c => typeof c === 'string' ? c : c && c.url;
                allCitations = allCitations.slice();
                for (const c of result.citations || []) if (c && !allCitations.some(x => key(x) === key(c))) allCitations.push(c);
            }

            const calls = tools ? (result.toolCalls || []).filter(c => c && c.name) : [];
            // pause_turn (dix recherches au plus par requête) : renvoyé tel quel, cinq fois au plus
            if (!calls.length && result.usage.finish_reason === 'pause_turn' && typeof provider.resumePaused === 'function'
                && pauses < PAUSED_TURN_MAX_RESUMES && !(signal && signal.aborted)) {
                pauses++;
                messages = provider.resumePaused(messages, { blocks: result.assistantBlocks });
                nextStep = { pause: true };
                continue;
            }
            if (!calls.length) {
                // Repère « [l'assistant a …] » écrit au lieu d'un appel : tour renvoyé avec une note, l'IA continue
                const fakeNote = tools && fakeNotes < 1 && round < ARTIFACT_TOOLS_MAX_ROUNDS && typeof tools.fakeMention === 'function'
                    && typeof provider.noteRound === 'function' && !(signal && signal.aborted) ? tools.fakeMention(roundText) : '';
                if (fakeNote) {
                    fakeNotes++;
                    messages = provider.noteRound(messages, { text: roundText, rawParts: result.rawParts, blocks: result.assistantBlocks,
                        reasoningDetails: result.reasoningDetails, reasoningContent: result.reasoningContent }, fakeNote);
                    sepPending = true;
                    nextStep = { malformed: true };
                    continue;
                }
                if (tools && result.malformed && malformedRetries < 2 && round < ARTIFACT_TOOLS_MAX_ROUNDS
                    && typeof provider.retryMalformed === 'function' && !(signal && signal.aborted)) {
                    malformedRetries++;
                    messages = provider.retryMalformed(messages, { text: roundText, rawParts: result.rawParts });
                    sepPending = true;
                    nextStep = { malformed: true };
                    continue;
                }
                break;
            }
            showProgress(true);
            const results = [];
            nextStep = { calls: [] };
            for (let i = 0; i < calls.length; i++) {
                const c = calls[i];
                if (!c.id) { c.id = `davidtwentyai_${round}_${i}`; c.syntheticId = true; }
                let args = c.args;
                if (args === undefined) {
                    try { args = c.arguments && c.arguments.trim() ? JSON.parse(c.arguments) : {}; } catch (e) { args = _lenientToolArgs(c.arguments); }
                }
                nextStep.calls.push({ name: c.name, args });
                let res;
                if (early.has(i)) {
                    res = early.get(i);
                } else if (!args || typeof args !== 'object' || Array.isArray(args)) {
                    // Compté pour l'infobulle ⓘ : coupé par la limite de longueur, ou JSON illisible
                    const key = /length|max_tokens|max_output_tokens|incomplete|context_window/i.test(String(result.usage.finish_reason || '')) ? 'tool_calls_cut' : 'tool_calls_unreadable';
                    total[key] = (total[key] || 0) + 1;
                    if (key === 'tool_calls_unreadable') {
                        let why = '';
                        try { JSON.parse(c.arguments || ''); } catch (e) { why = e.message || ''; }
                        const at = /position (\d+)/.exec(why);
                        console.info('[streamModel] appel illisible :', c.name, why, at ? JSON.stringify(String(c.arguments).slice(Math.max(0, +at[1] - 80), +at[1] + 80)) : '');
                    }
                    if (typeof tools.unreadable === 'function') {
                        try { tools.unreadable({ name: c.name, args: _partialToolArgs(c.arguments || '') }); } catch (e) { console.error('[streamModel] appel illisible :', e); }
                    }
                    res = 'Erreur : arguments illisibles (JSON invalide, ou réponse coupée pendant l\'appel). Réessaie, en plusieurs edit_file si le contenu est long.';
                } else {
                    try { res = await tools.run({ name: c.name, args }, { signal, activity, citations: allCitations.slice() }); } catch (e) { res = 'Erreur : ' + (e && e.message ? e.message : e); }
                }
                // Résultat avec sources (search_web, app.js) : repère, sources et consommation ajoutés
                if (res && typeof res === 'object') {
                    const urlOf = x => typeof x === 'string' ? x : x && x.url;
                    const fresh = (Array.isArray(res.citations) ? res.citations : []).filter(x => urlOf(x) && !allCitations.some(y => urlOf(y) === urlOf(x)));
                    if (fresh.length) {
                        out(_webSearchAnchor(allCitations.length));
                        allCitations = allCitations.concat(fresh);
                        activity({ type: 'sources', sources: allCitations.slice() });
                    }
                    if (res.usage && typeof res.usage === 'object') total = _addUsage(total, res.usage);
                    res = res.text;
                }
                res = String(res == null ? '' : res);
                results.push({ id: c.id, name: c.name, syntheticId: !!c.syntheticId, result: res, isError: /^(?:Erreur|Refusé)(?![\p{L}])/u.test(res) });
                onChunk('');
            }
            if (signal && signal.aborted) break;
            if (round >= ARTIFACT_TOOLS_MAX_ROUNDS) { total.tool_rounds_capped = true; break; }
            messages = provider.toolRound(messages, { text: roundText, calls, rawParts: result.rawParts, blocks: result.assistantBlocks, reasoningDetails: result.reasoningDetails, reasoningContent: result.reasoningContent }, results);
            sepPending = true;
        }

        if (tools && total) {
            // Ses propres outils ne sont pas un « outil que DavidTwentyAI ne propose pas »
            const own = new Set(tools.specs.map(sp => sp.name));
            if (Array.isArray(total.tool_calls)) {
                total.tool_calls = total.tool_calls.filter(n => !own.has(n));
                if (!total.tool_calls.length) delete total.tool_calls;
            }
            if (total.finish_reason && /tool/i.test(total.finish_reason) && !total.tool_rounds_capped) total.finish_reason = 'stop';
            // Jauge : taille du premier appel, les allers-retours ne restent pas dans la conversation
            total.context_input_tokens = firstInput;
        }
        activity({ type: 'end' });
        // Une erreur dans onDone n'est pas une erreur de l'API (onError la compterait deux fois)
        try { onDone(total, allCitations); } catch (e) { console.error('[streamModel] onDone :', e); }
    } catch (err) {
        activity({ type: 'end' });
        if (err.name === 'AbortError') { onDone(null, allCitations, total); return; }
        onError(err);
    }
}

// --- 7. Providers de génération d'images ---

function _b64ToBlob(b64, mime) {
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

const IMAGE_PROVIDERS = {

    // --- OpenAI Image ---

    openai: {
        async generate(modelId, prompt, referenceImages, signal, format, imageParams) {
            const sizeMap = { square: '1024x1024', vertical: '1024x1536', horizontal: '1536x1024' };
            const size = sizeMap[format] || '1024x1024';
            const quality = imageParams?.quality || 'high';
            const n = imageParams?.n || 1;
            const background = imageParams?.background || 'auto';
            const output_format = imageParams?.output_format || 'png';
            const output_compression = imageParams?.output_compression;
            const moderation = imageParams?.moderation || 'auto';
            const mimeByFormat = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
            const defaultMime = mimeByFormat[output_format] || 'image/png';

            let response;
            if (referenceImages && referenceImages.length > 0) {
                // L'outil image_generation de l'API Responses refuse gpt-image-1.5/2 (400) : /v1/images/edits
                const form = new FormData();
                form.append('model', modelId);
                form.append('prompt', prompt);
                referenceImages.forEach((img, i) => {
                    const mime = img.mimeType || 'image/png';
                    const ext = (mime.split('/')[1] || 'png').split('+')[0];
                    form.append('image[]', _b64ToBlob(img.data, mime), `reference${i + 1}.${ext}`);
                });
                form.append('n', String(n));
                form.append('size', size);
                form.append('quality', quality);
                form.append('background', background);
                form.append('output_format', output_format);
                if ((output_format === 'jpeg' || output_format === 'webp') && output_compression !== undefined) {
                    form.append('output_compression', String(output_compression));
                }
                // `moderation` n'existe pas sur /v1/images/edits : ne pas l'envoyer.

                response = await fetch('https://api.openai.com/v1/images/edits', {
                    method: 'POST',
                    // Pas de Content-Type : le navigateur pose le multipart/form-data avec son boundary
                    headers: { 'Authorization': `Bearer ${API_KEYS.openai}` },
                    body: form,
                    signal
                });
            } else {
                const body = {
                    model: modelId,
                    prompt: prompt,
                    quality,
                    output_format,
                    size,
                    n,
                    background,
                    moderation
                };
                if ((output_format === 'jpeg' || output_format === 'webp') && output_compression !== undefined) {
                    body.output_compression = output_compression;
                }

                response = await fetch('https://api.openai.com/v1/images/generations', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${API_KEYS.openai}`
                    },
                    body: JSON.stringify(body),
                    signal
                });
            }

            if (!response.ok) {
                const err = await response.text();
                throw new Error(`OpenAI Image API error ${response.status}: ${err}`);
            }

            const data = await response.json();
            const apiUsage = /^gpt-image-2\.5-/.test(modelId) && data.usage ? data.usage : null;
            const result = {
                text: '',
                images: [],
                usage: apiUsage ? {
                    input_tokens: apiUsage.input_tokens || 0,
                    output_tokens: apiUsage.output_tokens || 0,
                    input_tokens_details: apiUsage.input_tokens_details || null,
                    output_tokens_details: apiUsage.output_tokens_details || null
                } : null,
                imageCount: 0
            };

            for (const item of (data.data || [])) {
                if (item.revised_prompt && !result.text) result.text = item.revised_prompt;
                if (item.b64_json) {
                    result.images.push({ b64: item.b64_json, mimeType: defaultMime });
                    result.imageCount++;
                }
            }

            return result;
        }
    },

    // --- Google Gemini Image ---

    google: {
        async generate(modelId, prompt, referenceImages, signal, format, imageParams) {
            const aspectMap = { square: '1:1', vertical: '9:16', horizontal: '16:9' };
            const aspectRatio = imageParams?.geminiAspectRatio || aspectMap[format] || '1:1';
            const imageSize = imageParams?.imageSize || '1K';
            const thinkingLevel = imageParams?.thinkingLevel || 'minimal';

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;

            const parts = [];
            if (referenceImages && referenceImages.length > 0) {
                for (const img of referenceImages) {
                    parts.push({
                        inline_data: {
                            mime_type: img.mimeType || 'image/png',
                            data: img.data
                        }
                    });
                }
            }
            parts.push({ text: prompt });

            const generationConfig = {
                responseModalities: ['TEXT', 'IMAGE'],
                imageConfig: { aspectRatio, imageSize },
                thinkingConfig: { thinkingLevel }
            };
            const body = {
                contents: [{ role: 'user', parts }],
                generationConfig
            };

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEYS.google },
                body: JSON.stringify(body),
                signal
            });

            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Gemini Image API error ${response.status}: ${err}`);
            }

            const data = await response.json();
            const result = { text: '', images: [], usage: { input_tokens: 0, output_tokens: 0 }, imageCount: 0 };

            const responseParts = data.candidates?.[0]?.content?.parts || [];
            for (const part of responseParts) {
                if (part.text) result.text += part.text;
                const imgData = part.inline_data || part.inlineData;
                if (imgData) {
                    result.images.push({
                        b64: imgData.data,
                        mimeType: imgData.mime_type || imgData.mimeType || 'image/png'
                    });
                    result.imageCount++;
                }
            }

            if (data.usageMetadata) {
                result.usage.input_tokens = data.usageMetadata.promptTokenCount || 0;
                result.usage.output_tokens = data.usageMetadata.candidatesTokenCount || 0;
            }

            return result;
        }
    }
    ,

    // --- OpenRouter (images) ---

    openrouter: {
        async generate(modelId, prompt, referenceImages, signal, format, imageParams) {
            const aspectMap = { square: '1:1', vertical: '9:16', horizontal: '16:9' };
            const aspectRatio = imageParams?.geminiAspectRatio || aspectMap[format] || '1:1';

            const content = [];
            if (referenceImages && referenceImages.length > 0) {
                for (const img of referenceImages) {
                    content.push({
                        type: 'image_url',
                        image_url: { url: `data:${img.mimeType || 'image/png'};base64,${img.data}` }
                    });
                }
            }
            content.push({ type: 'text', text: prompt });

            const modelMeta = IMAGE_MODELS.find(x => x.id === modelId);
            const supportsTextOutput = Array.isArray(modelMeta?.outputModalities)
                && modelMeta.outputModalities.includes('text');
            const modalities = supportsTextOutput ? ['image', 'text'] : ['image'];

            const imageConfig = { aspect_ratio: aspectRatio };
            if (imageParams?.imageSize) imageConfig.image_size = imageParams.imageSize;

            const body = {
                model: modelId,
                messages: [{ role: 'user', content }],
                modalities,
                stream: false,
                image_config: imageConfig
            };

            // seed à la racine, pas dans image_config ; seulement si le modèle le déclare
            if (imageParams?.seed != null
                && Array.isArray(modelMeta?.supportedParameters)
                && modelMeta.supportedParameters.includes('seed')) {
                body.seed = imageParams.seed;
            }

            const requestTimestamp = Date.now();
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_KEYS.openrouter}`
                },
                body: JSON.stringify(body),
                signal
            });

            if (!response.ok) {
                const errText = await response.text();
                try {
                    const errJson = JSON.parse(errText);
                    const meta = errJson?.error?.metadata;
                    if (meta?.raw) {
                        try {
                            const raw = JSON.parse(meta.raw);
                            if (raw?.details?.['Moderation Reasons']?.length) {
                                const reasons = raw.details['Moderation Reasons'].join(', ');
                                throw new Error(`Votre prompt a été refusé par le fournisseur d'images (${meta.provider_name || 'inconnu'}) pour violation de sa politique de contenu.\n\nRaison : ${reasons}\n\nModifiez votre prompt et réessayez.`);
                            }
                            if (raw?.status === 'Request Moderated') {
                                throw new Error(`Votre prompt a été refusé par le fournisseur d'images (${meta.provider_name || 'inconnu'}) pour violation de sa politique de contenu.\n\nModifiez votre prompt et réessayez.`);
                            }
                        } catch (parseErr) {
                            if (parseErr.message.startsWith('Votre prompt')) throw parseErr;
                        }
                    }
                } catch (parseErr) {
                    if (parseErr.message.startsWith('Votre prompt')) throw parseErr;
                }
                throw new Error(`OpenRouter Image API error ${response.status}: ${errText}`);
            }

            const data = await response.json();
            const result = { text: '', images: [], usage: null, imageCount: 0 };

            const msg = data.choices?.[0]?.message;
            if (msg) {
                if (msg.content) result.text = msg.content;
                const imgs = msg.images || [];
                for (const img of imgs) {
                    const url = img.image_url?.url || img.url || '';
                    const match = url.match(/^data:([^;]+);base64,(.+)$/);
                    if (match) {
                        result.images.push({ b64: match[2], mimeType: match[1] });
                    } else if (url) {
                        result.images.push({ b64: url, mimeType: 'image/png' });
                    }
                    result.imageCount++;
                }
            }

            if (data.usage) {
                result.usage = {
                    input_tokens: 0,
                    output_tokens: 0,
                    cost_real: null,
                    request_timestamp: requestTimestamp
                };
                // prompt_tokens inclut lectures et créations de cache ; usage.cost est le montant final
                _mergeTokenUsage(result.usage, data.usage, 'chat');
                if (typeof data.model === 'string') result.usage.response_model = data.model;
            }

            return result;
        }
    }
};

// --- 8. generateImage() — dispatcher générique ---

async function generateImage(modelId, prompt, onDone, onError, referenceImages, signal, format, imageParams) {
    const editeur = getImageModelEditeur(modelId);
    const imageProvider = IMAGE_PROVIDERS[editeur];
    if (!imageProvider) { onError(new Error(`Éditeur inconnu pour le modèle image ${modelId}`)); return; }

    try {
        const result = await imageProvider.generate(modelId, prompt, referenceImages, signal, format, imageParams);
        onDone(result);
    } catch (err) {
        if (err.name === 'AbortError') { onDone({ text: '', images: [], usage: null, imageCount: 0 }); return; }
        onError(err);
    }
}

// --- 9. Audio (TTS + STT) + Paramètres modèles ---

let AUDIO_SETTINGS = { ttsProvider: 'system-tts', sttProvider: '', enhanceModel: '', summaryModel: '', errorExplainerModel: '', titleModel: '' };

function loadAudioSettings() {
    try {
        const stored = localStorage.getItem('minou-audio-settings');
        if (stored) Object.assign(AUDIO_SETTINGS, JSON.parse(stored));
        AUDIO_SETTINGS.ttsProvider = migrateModelId(AUDIO_SETTINGS.ttsProvider);
        AUDIO_SETTINGS.sttProvider = migrateModelId(AUDIO_SETTINGS.sttProvider);
        for (const k of ['enhanceModel', 'summaryModel', 'errorExplainerModel', 'titleModel', 'localFallbackModel']) {
            if (typeof AUDIO_SETTINGS[k] === 'string' && RENAMED_MODEL_IDS[AUDIO_SETTINGS[k]]) AUDIO_SETTINGS[k] = RENAMED_MODEL_IDS[AUDIO_SETTINGS[k]];
        }
        const migrateByEditeur = (value, category) => {
            if (!value) return value;
            if (MODELS_DATA[category].some(m => m.id === value)) return value;
            if (value === 'system') return 'system-tts';
            const match = MODELS_DATA[category].find(m => m.editeur === value);
            return match ? match.id : value;
        };
        const beforeTts = AUDIO_SETTINGS.ttsProvider;
        const beforeStt = AUDIO_SETTINGS.sttProvider;
        AUDIO_SETTINGS.ttsProvider = migrateByEditeur(AUDIO_SETTINGS.ttsProvider, 'tts');
        AUDIO_SETTINGS.sttProvider = migrateByEditeur(AUDIO_SETTINGS.sttProvider, 'stt');
        if (AUDIO_SETTINGS.ttsProvider !== beforeTts || AUDIO_SETTINGS.sttProvider !== beforeStt) {
            localStorage.setItem('minou-audio-settings', JSON.stringify(AUDIO_SETTINGS));
        }
    } catch (e) {
        console.warn('Lecture des paramètres audio impossible (localStorage corrompu) :', e);
    }
}

function saveAudioSettings(settings) {
    Object.assign(AUDIO_SETTINGS, settings);
    localStorage.setItem('minou-audio-settings', JSON.stringify(AUDIO_SETTINGS));
}

function pcmToWavBlob(pcmBase64, sampleRate = 24000) {
    const raw = atob(pcmBase64);
    const pcm = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) pcm[i] = raw.charCodeAt(i);
    const numChannels = 1, bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const buf = new ArrayBuffer(44 + pcm.length);
    const v = new DataView(buf);
    const s = (off, str) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); };
    s(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true);
    s(8, 'WAVE'); s(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, numChannels, true); v.setUint32(24, sampleRate, true);
    v.setUint32(28, byteRate, true); v.setUint16(32, numChannels * bitsPerSample / 8, true);
    v.setUint16(34, bitsPerSample, true);
    s(36, 'data'); v.setUint32(40, pcm.length, true);
    new Uint8Array(buf).set(pcm, 44);
    return new Blob([buf], { type: 'audio/wav' });
}

async function ttsSpeak(text, onDone, onError, silent = false, onPlayingStart = null, onPlayingEnd = null) {
    const ttsModel = MODELS_DATA.tts.find(m => m.id === AUDIO_SETTINGS.ttsProvider);
    const ttsEditeur = ttsModel?.editeur;
    if (ttsEditeur === 'system') {
        try {
            if (!window.speechSynthesis) throw new Error('La synthèse vocale native n\'est pas supportée par ce navigateur.');
            const utterance = new SpeechSynthesisUtterance(text);
            // Voix choisie dans la Configuration (voix.js)
            const voice = typeof getSystemVoice === 'function' ? getSystemVoice() : null;
            utterance.lang = voice?.lang || 'fr-FR';
            if (voice) utterance.voice = voice;
            utterance.onend = () => onDone(null, text.length);
            utterance.onerror = (e) => {
                // Une interruption manuelle (cancel) ne doit pas remonter d'erreur
                if (e.error === 'interrupted' || e.error === 'canceled') {
                    onDone(null, text.length);
                    return;
                }
                onError(new Error('Erreur synthèse vocale système : ' + e.error));
            };
            window.speechSynthesis.speak(utterance);
        } catch (err) { onError(err); }
        return;
    }

    if (ttsEditeur === 'google') {
        try {
            const googleRequestTimestamp = Date.now();
            const isGemini38Tts = /^gemini-3\.8-flash(?:-lite)?-tts$/.test(ttsModel.id);
            if (isGemini38Tts) {
                const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': API_KEYS.google
                    },
                    body: JSON.stringify({
                        model: ttsModel.id,
                        input: [{
                            type: 'user_input',
                            content: [{
                                type: 'text',
                                text,
                                annotations: [{ type: 'speech_metadata', style: 'Français de France, naturel et fluide' }]
                            }]
                        }],
                        response_format: { type: 'audio' },
                        generation_config: { speech_config: [{ voice: 'Kore' }] }
                    })
                });
                if (!response.ok) {
                    const err = await response.text();
                    throw new Error(`Google TTS error ${response.status}: ${err}`);
                }
                const data = await response.json();
                const audioPart = (data.steps || [])
                    .flatMap(step => step.content || [])
                    .filter(part => part.type === 'audio' && part.data)
                    .pop();
                if (!audioPart) throw new Error('Réponse Google TTS invalide');
                const blob = _b64ToBlob(audioPart.data, audioPart.mime_type || 'audio/wav');
                onDone(blob, text.length, false, _googleAudioUsage(data.usage, true, googleRequestTimestamp));
                return;
            }

            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ttsModel.id)}:generateContent`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEYS.google },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text }] }],
                        generationConfig: {
                            responseModalities: ['AUDIO'],
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
                        }
                    })
                }
            );
            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Google TTS error ${response.status}: ${err}`);
            }
            const data = await response.json();
            const part = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
            if (!part) throw new Error('Réponse Google TTS invalide');
            const blob = pcmToWavBlob(part.data);
            onDone(blob, text.length, false, _googleAudioUsage(data.usageMetadata, false, googleRequestTimestamp));
        } catch (err) { onError(err); }
        return;
    }

    if (ttsEditeur === 'mistral') {
        let stopped = false;
        let reader = null;
        let audioCtx = null;
        const sources = [];
        const stopHandle = () => {
            stopped = true;
            try { reader?.cancel(); } catch (e) {}
            for (const s of sources) { try { s.stop(); } catch (e) {} }
            if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
        };
        try {
            const response = await fetch('https://api.mistral.ai/v1/audio/speech', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_KEYS.mistral}`
                },
                body: JSON.stringify({
                    model: ttsModel.id,
                    input: text,
                    response_format: 'pcm',
                    // Marie de Voxtral 3 (fr_marie_neutral : celle de Voxtral 2)
                    voice_id: 'voice_592',
                    stream: true
                })
            });
            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Mistral TTS error ${response.status}: ${err}`);
            }
            audioCtx = silent ? null : new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
            const pcmChunks = [];
            let nextStartTime = audioCtx ? audioCtx.currentTime : 0;
            let playStarted = false;
            reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (!stopped) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    if (stopped) break;
                    if (!line.startsWith('data: ')) continue;
                    const json = line.slice(6).trim();
                    if (json === '[DONE]') continue;
                    try {
                        const evt = JSON.parse(json);
                        const b64 = evt.audio_data;
                        if (!b64) continue;
                        const raw = atob(b64);
                        const buf = new ArrayBuffer(raw.length);
                        const pcmBytes = new Uint8Array(buf);
                        for (let i = 0; i < raw.length; i++) pcmBytes[i] = raw.charCodeAt(i);
                        pcmChunks.push(pcmBytes);
                        if (audioCtx) {
                            const dv = new DataView(buf);
                            const numSamples = buf.byteLength / 4;
                            const samples = new Float32Array(numSamples);
                            for (let i = 0; i < numSamples; i++) samples[i] = dv.getFloat32(i * 4, true);
                            const abuf = audioCtx.createBuffer(1, samples.length, 24000);
                            abuf.getChannelData(0).set(samples);
                            const src = audioCtx.createBufferSource();
                            src.buffer = abuf;
                            src.connect(audioCtx.destination);
                            const when = Math.max(nextStartTime, audioCtx.currentTime);
                            src.start(when);
                            sources.push(src);
                            nextStartTime = when + abuf.duration;
                            if (!playStarted) {
                                playStarted = true;
                                if (onPlayingStart) onPlayingStart(stopHandle);
                            }
                        }
                    } catch (e) {}
                }
            }
            if (stopped) {
                if (onPlayingEnd) onPlayingEnd();
                onDone(null, text.length, true);
                return;
            }
            const totalBytes = pcmChunks.reduce((s, c) => s + c.length, 0);
            const allBytes = new Uint8Array(totalBytes);
            let off = 0;
            for (const c of pcmChunks) { allBytes.set(c, off); off += c.length; }
            const allFloats = new Float32Array(allBytes.buffer);
            const int16 = new Int16Array(allFloats.length);
            for (let i = 0; i < allFloats.length; i++) {
                const s = Math.max(-1, Math.min(1, allFloats[i]));
                int16[i] = s < 0 ? s * 32768 : s * 32767;
            }
            const pcmData = new Uint8Array(int16.buffer);
            const numCh = 1, bps = 16, sr = 24000;
            const wavBuf = new ArrayBuffer(44 + pcmData.length);
            const wv = new DataView(wavBuf);
            const ws = (o, s) => { for (let i = 0; i < s.length; i++) wv.setUint8(o + i, s.charCodeAt(i)); };
            ws(0, 'RIFF'); wv.setUint32(4, 36 + pcmData.length, true);
            ws(8, 'WAVE'); ws(12, 'fmt ');
            wv.setUint32(16, 16, true); wv.setUint16(20, 1, true);
            wv.setUint16(22, numCh, true); wv.setUint32(24, sr, true);
            wv.setUint32(28, sr * numCh * bps / 8, true);
            wv.setUint16(32, numCh * bps / 8, true); wv.setUint16(34, bps, true);
            ws(36, 'data'); wv.setUint32(40, pcmData.length, true);
            new Uint8Array(wavBuf).set(pcmData, 44);
            const wavBlob = new Blob([wavBuf], { type: 'audio/wav' });
            if (audioCtx) {
                const endDelay = Math.max(0, (nextStartTime - audioCtx.currentTime) * 1000) + 100;
                setTimeout(() => {
                    try { audioCtx?.close(); } catch (e) {}
                    if (!stopped && onPlayingEnd) onPlayingEnd();
                    onDone(wavBlob, text.length, !silent);
                }, endDelay);
            } else {
                onDone(wavBlob, text.length, !silent);
            }
        } catch (err) {
            if (stopped) return;
            onError(err);
        }
        return;
    }

    try {
        const openaiModel = ttsEditeur === 'openai' ? ttsModel : MODELS_DATA.tts.find(m => m.editeur === 'openai');
        const response = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEYS.openai}`
            },
            body: JSON.stringify({
                model: openaiModel.id,
                input: text,
                voice: 'coral',
                instructions: 'Parle en français de France, avec une prononciation native parfaite, sans aucun accent étranger. Ton naturel et fluide.'
            })
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`OpenAI TTS error ${response.status}: ${err}`);
        }
        const blob = await response.blob();
        onDone(blob, text.length);
    } catch (err) { onError(err); }
}

async function transcribeAudio(audioBlob, onDone, onError, modelId = AUDIO_SETTINGS.sttProvider) {
    const sttModel = MODELS_DATA.stt.find(m => m.id === modelId);
    const mime = (audioBlob.type || 'audio/webm').split(';')[0].toLowerCase();
    const extensions = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3' };
    const audioFilename = 'audio.' + (extensions[mime] || 'bin');
    const sttEditeur = sttModel?.editeur;
    if (sttEditeur === 'google') {
        try {
            const googleRequestTimestamp = Date.now();
            const base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(audioBlob);
            });
            const audioMimeType = (audioBlob.type || 'audio/webm').split(';')[0];
            const isGeminiTranscribe = sttModel.id === 'gemini-3.5-transcribe';
            const requestBody = isGeminiTranscribe ? {
                contents: [{ parts: [{ inlineData: { mimeType: audioMimeType, data: base64 } }] }],
                generationConfig: {
                    audioTranscriptionConfig: { languageCodes: ['fr-FR'], mode: 'SMART' }
                }
            } : {
                contents: [{
                    parts: [
                        { inlineData: { mimeType: audioMimeType, data: base64 } },
                        { text: 'Transcris cet audio en français. Réponds uniquement avec la transcription, sans commentaire.' }
                    ]
                }]
            };
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(sttModel.id)}:generateContent`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEYS.google },
                    body: JSON.stringify(requestBody)
                }
            );
            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Google STT error ${response.status}: ${err}`);
            }
            const data = await response.json();
            // Gemini Transcribe : texte dans audioTranscription, pas dans text
            const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought)
                .map(p => (p.audioTranscription?.text ?? p.text ?? '').trim()).filter(Boolean).join(' ');
            onDone(text, _googleAudioUsage(data.usageMetadata, false, googleRequestTimestamp));
        } catch (err) { onError(err); }
        return;
    }

    if (sttEditeur === 'mistral') {
        try {
            const formData = new FormData();
            formData.append('file', audioBlob, audioFilename);
            formData.append('model', sttModel.id);
            formData.append('language', 'fr');
            const response = await fetch('https://api.mistral.ai/v1/audio/transcriptions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${API_KEYS.mistral}` },
                body: formData
            });
            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Mistral STT error ${response.status}: ${err}`);
            }
            const data = await response.json();
            onDone(data.text);
        } catch (err) { onError(err); }
        return;
    }

    try {
        const openaiSttModel = sttEditeur === 'openai' ? sttModel : MODELS_DATA.stt.find(m => m.editeur === 'openai');
        const formData = new FormData();
        formData.append('file', audioBlob, audioFilename);
        formData.append('model', openaiSttModel.id);
        formData.append('language', 'fr');
        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${API_KEYS.openai}` },
            body: formData
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`OpenAI transcription API error ${response.status}: ${err}`);
        }
        const data = await response.json();
        onDone(data.text);
    } catch (err) { onError(err); }
}

// --- 10. Streaming texte multi-provider (utilitaire partagé) ---

// AbortError jamais rattrapée par le secours ; model : celui réellement utilisé (secours éventuel)
async function streamText(modelId, prompt, onDelta, opts = {}) {
    const { system = null, signal = null, modelParams, noFallback = false } = opts || {};
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    // '__local__' : premier modèle local, chez son propre serveur
    const localModel = MODELS.find(m => (modelId === '__local__' ? true : m.id === modelId) && isLocalEditeur(m.editeur));
    const isLocal = modelId === '__local__' || !!localModel;
    const model = isLocal ? null : MODELS_DATA.text.find(m => m.id === modelId);
    const editeur = isLocal
        ? (localModel?.editeur || (API_KEYS.ollama ? 'ollama' : 'lmstudio'))
        : (model?.editeur || getModelEditeur(modelId));
    // Secours jamais lui-même (boucle) ; noFallback : compactage, rien vers un autre fournisseur
    const fallback = !noFallback && AUDIO_SETTINGS.localFallbackModel && AUDIO_SETTINGS.localFallbackModel !== 'none'
        && AUDIO_SETTINGS.localFallbackModel !== modelId ? AUDIO_SETTINGS.localFallbackModel : null;
    // Modèle introuvable : local (serveur éteint) ou retiré de models.js
    if (!editeur) {
        if (fallback) {
            return streamText(fallback, prompt, onDelta, opts);
        }
        const looksLocal = /:|^llama|^qwen|^mistral|^gemma|^phi|^deepseek-r1/i.test(modelId);
        if (looksLocal) {
            throw new Error(`Modèle introuvable : "${modelId}". Vérifiez que votre serveur local est bien lancé, ou configurez un modèle de secours dans Configuration > Fonctionnalités.`);
        }
        throw new Error(`Modèle introuvable : "${modelId}". Ce modèle n'est plus disponible dans le catalogue, sélectionnez-en un autre dans le menu.`);
    }

    if (isLocalEditeur(editeur)) {
        if (!API_KEYS[editeur]) throw new Error(`URL du serveur ${editeur === 'ollama' ? 'Ollama' : 'LM Studio'} requise. Renseignez-la dans Configuration.`);
    } else {
        const key = API_KEYS[editeur] !== undefined ? editeur : 'openai';
        if (!API_KEYS[key]) throw new Error(`Clé API ${key} requise. Renseignez-la dans Configuration.`);
    }

    const provider = PROVIDERS[editeur];
    const actualModelId = isLocal ? (modelId === '__local__' ? (localModel?.id || '') : modelId) : modelId;
    const messages = provider.formatMessages([{ role: 'user', content: prompt }]);
    const body = provider.buildBody(actualModelId, messages, system || null, false, modelParams);

    let response;
    const requestTimestamp = Date.now();
    try {
        if (isLocal) {
            const baseUrl = API_KEYS[editeur].replace(/\/+$/, '');
            try {
                const ping = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
                if (!ping.ok) throw new Error();
            } catch {
                throw new Error(`Serveur ${editeur === 'ollama' ? 'Ollama' : 'LM Studio'} injoignable. Vérifiez qu'il soit bien lancé.`);
            }
        }
        if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const fetchOpts = { method: 'POST', headers: provider.getHeaders(), body: JSON.stringify(body), ...(signal && { signal }) };
        response = await fetch(provider.getUrl(actualModelId), fetchOpts);
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, 300);
            const err = new Error(`Erreur API ${editeur} : ${response.status}${detail ? ' — ' + detail : ''}`);
            err.status = response.status;
            throw err;
        }
    } catch (fetchErr) {
        if (fetchErr?.name === 'AbortError') throw fetchErr;
        // Pas de secours pour une requête trop longue : le secours cloud recevrait tout sans choix
        const tooLong = !!fetchErr?.status && /n_ctx|context|too long|too many tokens|maximum.*tokens|exceed/i.test(String(fetchErr.message));
        if (isLocal && fallback && !tooLong) {
            return streamText(fallback, prompt, onDelta, opts);
        }
        throw fetchErr;
    }

    const parse = provider.createParser(false);
    parse.getResult().usage.request_timestamp = requestTimestamp;
    let result = '';
    for await (const raw of readSSE(response)) {
        for (const event of parse(raw)) {
            if (event.type === 'chunk') {
                result += event.data;
                if (onDelta) onDelta(event.data);
            }
        }
    }
    for (const event of parse.flush()) {
        if (event.type === 'chunk') {
            result += event.data;
            if (onDelta) onDelta(event.data);
        }
    }
    const { usage } = parse.getResult();
    return { text: result, usage, model: actualModelId };
}

// --- 11. Amélioration de prompt ---

const ENHANCE_PROMPT_TEMPLATE = `Tu es un expert en prompt engineering. Voici un prompt écrit par un utilisateur pour une IA conversationnelle :\n\n---\n{TEXT}\n---\n\nAméliore ce prompt pour obtenir un meilleur résultat de l'IA. Tu dois :\n- Conserver fidèlement l'intention et le sens du prompt original\n- Ne pas dénaturer ni changer le sujet ou la demande\n- Compléter, reformuler, structurer et préciser le prompt\n- Ajouter du contexte utile si nécessaire\n- Rendre les instructions plus claires et sans ambiguïté\n\nRéponds UNIQUEMENT avec le prompt amélioré. Pas d'introduction, pas de conclusion, pas de commentaire, pas de texte avant ou après. Ne commence pas par "Voici" ou toute autre phrase d'accroche. Retourne directement le contenu du prompt optimisé, rien d'autre.`;

const ENHANCE_IMAGE_PROMPT_TEMPLATE = `Tu es un expert en génération d'images par IA. Voici un prompt de génération d'image brut :\n\n---\n{TEXT}\n---\n\nAméliore ce prompt pour obtenir une meilleure image générée par IA. Tu dois :\n- Conserver fidèlement l'intention et le sujet de l'image demandée\n- Ajouter des détails visuels précis (éclairage, angle, style, couleurs, composition, ambiance)\n- Préciser le style artistique si pertinent (photoréaliste, illustration, peinture, 3D, etc.)\n- Structurer le prompt de manière optimale pour un modèle de génération d'image\n- Rester en anglais pour une meilleure compatibilité avec les modèles d'image\n- Ne jamais citer de personnages, œuvres, marques, logos ou noms protégés par le droit d'auteur ; reformuler en décrivant les caractéristiques visuelles à la place\n\nRéponds UNIQUEMENT avec le prompt amélioré. Pas d'introduction, pas de conclusion, pas de commentaire, pas de texte avant ou après. Ne commence pas par "Voici" ou toute autre phrase d'accroche. Retourne directement le contenu du prompt optimisé, rien d'autre.`;

async function enhancePrompt(text, onDelta, onDone, onError, isImage = false) {
    const template = isImage ? ENHANCE_IMAGE_PROMPT_TEMPLATE : ENHANCE_PROMPT_TEMPLATE;
    const prompt = template.replace('{TEXT}', text);
    const modelId = AUDIO_SETTINGS.enhanceModel || 'gpt-4.1-2025-04-14';
    try {
        await streamText(modelId, prompt, onDelta);
        onDone();
    } catch (err) { onError(err); }
}

// Erreurs déjà claires : une explication du LLM hallucinerait (internet au lieu de CORS)
function isSelfExplainedError(errorMessage) {
    if (!errorMessage) return false;
    const m = String(errorMessage);
    return /injoignable|requise\. Renseignez|Modèle introuvable|catalogue, sélectionnez|Connexion à .* impossible|CORS/i.test(m);
}

async function explainError(userMessage, fileNames, modelUsed, errorMessage, modelId = AUDIO_SETTINGS.errorExplainerModel) {
    if (isSelfExplainedError(errorMessage)) return null;
    if (!modelId) return null;
    const prompt = `Tu es un assistant qui aide les utilisateurs d'une application de chat IA. L'utilisateur a envoyé un message et une erreur est survenue. Explique en 1 à 2 phrases simples et claires en français quel est le problème. Ne mentionne pas de détails techniques JSON. Sois concis et utile.

Message de l'utilisateur (extrait) : ${(userMessage || '').slice(0, 300)}
${fileNames.length ? 'Fichiers joints : ' + fileNames.join(', ') : ''}
Modèle utilisé : ${modelUsed || 'inconnu'}
Erreur retournée : ${errorMessage}

Explication :`;
    try {
        return (await streamText(modelId, prompt)).text;
    } catch (e) {
        return null;
    }
}
