// --- Conversations (IndexedDB) ---

// Base déjà en version supérieure : ouverte telle quelle, la redemander en version 2 lèverait VersionError
function openConvDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('minou_conversations', 2);
        let blocked = false;
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('conversations')) {
                db.createObjectStore('conversations');
            }
            if (!db.objectStoreNames.contains('backup_staging')) {
                db.createObjectStore('backup_staging');
            }
        };
        req.onblocked = () => {
            blocked = true;
            reject(new Error('Fermez les autres onglets DavidTwentyAI puis rechargez cette page pour terminer la mise à jour du stockage.'));
        };
        req.onsuccess = () => {
            req.result.onversionchange = () => req.result.close();
            if (blocked) { req.result.close(); return; }
            resolve(req.result);
        };
        req.onerror = event => {
            if (req.error && req.error.name === 'VersionError') {
                event.preventDefault();
                _openConvDBAsIs().then(resolve, reject);
                return;
            }
            reject(req.error);
        };
    });
}

function _openConvDBAsIs() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('minou_conversations');
        req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('conversations') || !db.objectStoreNames.contains('backup_staging')) {
                db.close();
                reject(new Error('Le stockage des conversations vient d\'une autre version de DavidTwentyAI et ne peut pas être lu.'));
                return;
            }
            db.onversionchange = () => db.close();
            if (db.objectStoreNames.contains('canvas_assets')) _moveLegacyCanvasAssets();
            resolve(db);
        };
        req.onerror = () => reject(req.error);
    });
}

// Anciens fichiers du magasin canvas_assets de la base des conversations : recopiés une fois, puis retirés
let _legacyCanvasAssetsMoved = false;
function _moveLegacyCanvasAssets() {
    if (_legacyCanvasAssetsMoved) return;
    _legacyCanvasAssetsMoved = true;
    const req = indexedDB.open('minou_conversations');
    req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('canvas_assets', 'readonly');
        const keys = tx.objectStore('canvas_assets').getAllKeys();
        const values = tx.objectStore('canvas_assets').getAll();
        tx.onabort = tx.onerror = () => db.close();
        tx.oncomplete = async () => {
            let copied = 0;
            const list = keys.result || [];
            for (let i = 0; i < list.length; i++) {
                const value = (values.result || [])[i];
                try {
                    if (value && value.blob instanceof Blob) await putCanvasAsset(String(list[i]), value.blob);
                    copied++;
                } catch (e) {
                    console.warn('[stockage] fichier des Artifacts non recopié', e);
                }
            }
            if (!list.length || copied < list.length) { db.close(); return; }
            try {
                const clear = db.transaction('canvas_assets', 'readwrite');
                clear.objectStore('canvas_assets').clear();
                clear.oncomplete = clear.onabort = clear.onerror = () => db.close();
            } catch (e) {
                db.close();
            }
        };
    };
}

// Un abort annule toute la restauration ; réglages copiés sur disque jusqu'au commit pour récupérer au démarrage
async function _withBackupStorageLock(callback) {
    if (typeof navigator === 'undefined' || !navigator.locks?.request) {
        throw new Error('La restauration sécurisée nécessite une version récente de Chrome, Safari ou Firefox.');
    }
    return navigator.locks.request('davidtwentyai-backup-import', { mode: 'exclusive' }, callback);
}

function _backupStagingRequest(db, mode, operation) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('backup_staging', mode);
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error || new Error('Préparation de la sauvegarde interrompue'));
        try {
            const request = operation(tx.objectStore('backup_staging'));
            request.onsuccess = () => { result = request.result; };
        } catch (error) {
            tx.abort();
            reject(error);
        }
    });
}

async function _recoverBackupStaging(db, restoreSettings) {
    const journal = await _backupStagingRequest(db, 'readonly', store => store.get(0));
    if (journal) restoreSettings(journal.settings);
    await _backupStagingRequest(db, 'readwrite', store => store.clear());
}

async function recoverInterruptedBackupImport(restoreSettings) {
    const db = await openConvDB();
    try {
        // Sans journal ni préparation abandonnée, aucun verrou n'est nécessaire.
        const count = await _backupStagingRequest(db, 'readonly', store => store.count());
        if (!count) return;
        await _withBackupStorageLock(() => _recoverBackupStaging(db, restoreSettings));
    } finally { db.close(); }
}

// Sauvegarde importée : champs affichés gardés à leur type (XSS) ; le reste est rendu par marked et DOMPurify
const _MODEL_ID_RE = /^[\w.:\/@+~-]{1,200}$/;
function _sanitizeConversationData(value) {
    const wasString = typeof value === 'string';
    let data = value;
    if (wasString) {
        try { data = JSON.parse(value); } catch (e) { throw new Error('Conversation illisible dans la sauvegarde'); }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Conversation invalide dans la sauvegarde');
    const isNum = v => typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(v.trim());
    const num = (o, k) => { if (!(k in o)) return; if (isNum(o[k])) o[k] = Number(o[k]); else delete o[k]; };
    const text = (o, k) => { if (k in o && o[k] != null && typeof o[k] !== 'string') delete o[k]; };
    const model = (o, k) => { if (k in o && o[k] != null && !(typeof o[k] === 'string' && _MODEL_ID_RE.test(o[k]))) delete o[k]; };
    const plain = v => v && typeof v === 'object' && !Array.isArray(v);
    // Date en texte ISO : les listes la trient comme du texte
    const date = (o, k) => {
        if (!(k in o)) return;
        const v = o[k];
        const d = typeof v === 'string' ? (v.length < 40 && !isNaN(Date.parse(v)) ? v : null)
            : typeof v === 'number' && Number.isFinite(v) && !isNaN(new Date(v).getTime()) ? new Date(v).toISOString() : null;
        if (d) o[k] = d; else delete o[k];
    };
    const KEEP_TEXT = new Set(['finish_reason', 'stream_error', 'response_model', 'source']);
    const counters = (o, depth = 0) => {
        if (!plain(o) || depth > 4) return null;
        const out = {};
        for (const [k, v] of Object.entries(o)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            if (isNum(v)) out[k] = Number(v);
            else if (typeof v === 'boolean' || v === null) out[k] = v;
            else if (typeof v === 'string' && KEEP_TEXT.has(k)) out[k] = v.slice(0, 500);
            else if (k === 'audioRequests' && Array.isArray(v)) out[k] = v.filter(r => plain(r) && isNum(r.cost)).slice(0, 10000).map(r => ({
                cost: Number(r.cost),
                ...(typeof r.model === 'string' && _MODEL_ID_RE.test(r.model) ? { model: r.model } : {}),
                ...(typeof r.source === 'string' ? { source: r.source.slice(0, 50) } : {}),
                ...(plain(r.usage) ? { usage: counters(r.usage, depth + 1) } : {})
            }));
            else if (Array.isArray(v)) out[k] = v.filter(x => typeof x === 'string').map(x => x.slice(0, 300)).slice(0, 50);
            else if (plain(v)) { const c = counters(v, depth + 1); if (c) out[k] = c; }
        }
        return out;
    };
    for (const k of ['tokens_entree', 'tokens_sortie', 'totalCost', 'cout_images', 'cout_audio', 'cout_titre', 'cout_estime_usd']) num(data, k);
    for (const k of ['id', 'titre', 'category', 'system_prompt_text']) text(data, k);
    model(data, 'modele');
    model(data, 'titre_modele');
    for (const k of ['date', 'lastActivity']) date(data, k);
    if ('deleted' in data) data.deleted = data.deleted === true;
    if ('cost_by_model' in data) {
        const out = {};
        if (plain(data.cost_by_model)) {
            for (const [k, v] of Object.entries(data.cost_by_model)) {
                if (!_MODEL_ID_RE.test(k)) continue;
                const c = counters(v);
                if (c) out[k] = c;
            }
        }
        data.cost_by_model = out;
    }
    if ('compaction' in data) {
        const c = data.compaction;
        if (!plain(c)) delete data.compaction;
        else {
            num(c, 'count');
            date(c, 'createdAt');
            for (const k of ['summary', 'untilId', 'previousSummary']) text(c, k);
            model(c, 'model');
            if ('keptIds' in c) c.keptIds = Array.isArray(c.keptIds) ? c.keptIds.filter(x => typeof x === 'string') : [];
        }
    }
    if ('messages' in data) {
        data.messages = (Array.isArray(data.messages) ? data.messages : []).filter(m => plain(m) && ['user', 'assistant', 'system'].includes(m.role));
        for (const m of data.messages) {
            model(m, 'model');
            for (const k of ['generationTime', 'outputTokens']) num(m, k);
            if ('sentAt' in m && !(typeof m.sentAt === 'string' && m.sentAt.length < 40 && !isNaN(Date.parse(m.sentAt)))) delete m.sentAt;
            if ('canvasStateHash' in m && !(typeof m.canvasStateHash === 'string' && /^[0-9a-f]{8}-\d+$/.test(m.canvasStateHash))) delete m.canvasStateHash;
            for (const k of ['usage', 'billing']) {
                if (!(k in m)) continue;
                const c = counters(m[k]);
                if (c) m[k] = c; else delete m[k];
            }
            if (!Array.isArray(m.content)) continue;
            for (const part of m.content) {
                if (!plain(part) || (part.type !== 'image' && part.type !== 'file')) continue;
                let had = false, kept = false;
                for (const k of ['dataUrl', 'data', 'b64']) {
                    if (!(k in part) || part[k] == null) continue;
                    had = true;
                    const v = part[k];
                    const ok = typeof v === 'string' && (k === 'dataUrl' ? /^data:[^,]*,/i.test(v) : /^[A-Za-z0-9+/=\s]*$/.test(v));
                    if (ok) kept = true; else delete part[k];
                }
                if (had && !kept) part.omitted = true;
                if ('mimeType' in part && part.mimeType != null && !(typeof part.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(part.mimeType))) delete part.mimeType;
                text(part, 'name');
            }
        }
    }
    return wasString ? JSON.stringify(data) : data;
}

async function importConversationsAtomically(produce, snapshotSettings, applySettings, restoreSettings) {
    return _withBackupStorageLock(async () => {
        const db = await openConvDB();
        let snapshot = null;
        let settingsTouched = false;
        let committed = false;
        let recovered = false;
        try {
            await _recoverBackupStaging(db, restoreSettings);
            recovered = true;
            let index = 0;
            await produce(async (key, value) => {
                if (typeof key !== 'string' || !key) throw new Error('Nom de conversation invalide');
                value = _sanitizeConversationData(value);
                await _backupStagingRequest(db, 'readwrite', store => store.put({ key, value }, ++index));
            });
            await Promise.all(Array.from(_writeQueues.values()));
            snapshot = snapshotSettings();
            await _backupStagingRequest(db, 'readwrite', store => store.put({ settings: snapshot }, 0));

            await new Promise((resolve, reject) => {
                const tx = db.transaction(['conversations', 'backup_staging'], 'readwrite');
                const target = tx.objectStore('conversations');
                const staging = tx.objectStore('backup_staging');
                let failure = null;
                tx.oncomplete = () => resolve();
                tx.onabort = () => reject(failure || tx.error || new Error('Restauration interrompue'));
                const abort = error => { failure = error; tx.abort(); };
                const request = staging.openCursor();
                request.onsuccess = () => {
                    const cursor = request.result;
                    try {
                        if (!cursor) {
                            settingsTouched = true;
                            // Doit rester synchrone : aucun await dans une transaction IDB.
                            const result = applySettings();
                            if (result && typeof result.then === 'function') {
                                throw new Error('Application des réglages asynchrone non prise en charge');
                            }
                            staging.delete(0);
                            return;
                        }
                        if (cursor.key === 0) { cursor.continue(); return; }
                        const { key, value } = cursor.value;
                        const put = target.put(value, key);
                        put.onsuccess = () => {
                            cursor.delete();
                            cursor.continue();
                        };
                    } catch (error) { abort(error); }
                };
            });
            committed = true;
            _convMetaManifest.clear();
            _convMetaSeeded = false;
            _convMetaSeedPromise = null;
            if (_onConvMutated) { try { _onConvMutated(); } catch (e) { console.warn(e); } }
        } catch (error) {
            // Réglages importés libérés avant de rétablir les anciens : un quota localStorage bloquerait la récupération
            if (!committed && recovered) {
                try {
                    if (settingsTouched) restoreSettings(snapshot);
                    await _backupStagingRequest(db, 'readwrite', store => store.clear());
                } catch (recoveryError) {
                    // Conserver le journal pour la récupération au redémarrage.
                    throw new Error('Les conversations ont été conservées, mais les réglages doivent être récupérés au rechargement de DavidTwentyAI.', { cause: recoveryError });
                }
            }
            throw error;
        } finally { db.close(); }
    });
}

// Écritures sérialisées par conversation : sinon deux read-modify-write concurrents perdent des mises à jour
const _writeQueues = new Map();

// --- Manifeste des métadonnées en mémoire, tenu à jour par les écritures (évite de relire toute la base) ---
const _convMetaManifest = new Map();
let _convMetaSeeded = false;
let _convMetaSeedPromise = null;

let _onConvMutated = null;
function setOnConvMutated(fn) { _onConvMutated = fn; }

function _parseConvRaw(raw) {
    if (raw == null) return null;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return null; }
}

// Texte borné : ne pas garder de grosses images base64 dans le manifeste
function _extractFirstMessageText(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return '';
    const content = messages[0].content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
        for (const part of content) {
            if (part && part.type === 'text' && part.text) { text = part.text; break; }
        }
    }
    return text.length > 200 ? text.slice(0, 200) : text;
}

// Modèle du titre (statistiques) : noté sur la première réponse (titleAccounting) ou gardé à la suppression
function _titleModelOf(data) {
    if (data && typeof data.titre_modele === 'string') return data.titre_modele;
    const msgs = data && Array.isArray(data.messages) ? data.messages : [];
    const m = msgs.find(x => x && x.titleAccounting && typeof x.titleAccounting.model === 'string');
    return m ? m.titleAccounting.model : null;
}

function _extractConvMetadata(filename, data) {
    return {
        filename,
        id: data.id,
        titre: data.titre || null,
        date: data.date,
        lastActivity: data.lastActivity || data.date,
        modele: data.modele,
        firstMessage: _extractFirstMessageText(data.messages),
        tokens_entree: Number(data.tokens_entree) || 0,
        tokens_sortie: Number(data.tokens_sortie) || 0,
        cout_estime_usd: Number(data.cout_estime_usd) || 0,
        cout_titre: Number(data.cout_titre) || 0,
        titre_modele: _titleModelOf(data),
        cost_by_model: data.cost_by_model || null,
        category: data.category || null,
        pinned: data.pinned || null,
        deleted: data.deleted || false
    };
}

async function _seedConvMetaManifest() {
    if (_convMetaSeeded) return;
    if (_convMetaSeedPromise) return _convMetaSeedPromise;
    _convMetaSeedPromise = (async () => {
        try {
            const db = await openConvDB();
            const tx = db.transaction('conversations', 'readonly');
            const store = tx.objectStore('conversations');
            const [keys, allValues] = await Promise.all([
                new Promise((resolve) => {
                    const req = store.getAllKeys();
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => resolve([]);
                }),
                new Promise((resolve) => {
                    const req = store.getAll();
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => resolve([]);
                })
            ]);
            for (let i = 0; i < keys.length; i++) {
                // Une écriture concurrente pendant le seed est plus récente que sa lecture
                if (_convMetaManifest.has(keys[i])) continue;
                const data = _parseConvRaw(allValues[i]);
                if (!data) continue;
                _convMetaManifest.set(keys[i], _extractConvMetadata(keys[i], data));
            }
            _convMetaSeeded = true;
        } catch (e) {
            console.error('Erreur seed manifest:', e);
            _convMetaSeedPromise = null;
        }
    })();
    return _convMetaSeedPromise;
}

function _updateConvMetaInManifest(filename, content) {
    const data = _parseConvRaw(content);
    if (!data) return;
    _convMetaManifest.set(filename, _extractConvMetadata(filename, data));
}

function _afterConvWrite(filename, content) {
    _updateConvMetaInManifest(filename, content);
    if (_onConvMutated) {
        try { _onConvMutated(filename); } catch (e) { console.warn(e); }
    }
}

async function writeConversationFile(filename, content) {
    const prev = _writeQueues.get(filename) || Promise.resolve();
    const next = prev.then(async () => {
        try {
            // Conversation supprimée : jamais réécrite (enregistrement tardif d'une réponse ou d'un titre)
            const meta = _convMetaManifest.get(filename);
            if (meta && meta.deleted && !(content && typeof content === 'object' && content.deleted === true)) return false;
            // Textes des fichiers écrits avant la conversation qui désigne leurs empreintes
            content = _convContentForDisk(content);
            await flushPendingTexts();
            const db = await openConvDB();
            const tx = db.transaction('conversations', 'readwrite');
            tx.objectStore('conversations').put(content, filename);
            return new Promise((resolve) => {
                tx.oncomplete = () => {
                    _afterConvWrite(filename, content);
                    resolve(true);
                };
                // Annulée (quota dépassé…) : la file d'attente continue
                tx.onerror = () => resolve(false);
                tx.onabort = () => resolve(false);
            });
        } catch (e) {
            console.error('Erreur écriture conversation:', e);
            return false;
        }
    });
    const guarded = next.catch(() => {});
    _writeQueues.set(filename, guarded);
    guarded.finally(() => {
        if (_writeQueues.get(filename) === guarded) _writeQueues.delete(filename);
    });
    return next;
}

async function listConversationFiles(includeDeleted = false) {
    try {
        await _seedConvMetaManifest();
        const conversations = [];
        for (const meta of _convMetaManifest.values()) {
            if (meta.deleted && !includeDeleted) continue;
            // Copie défensive : les consommateurs ne doivent pas pouvoir muter le cache.
            conversations.push({ ...meta });
        }
        conversations.sort((a, b) => String(b.lastActivity || b.date || '').localeCompare(String(a.lastActivity || a.date || '')));
        return conversations;
    } catch (e) {
        console.error('Erreur lecture conversations:', e);
        return [];
    }
}

function getConvMetadata(filename) {
    const meta = _convMetaManifest.get(filename);
    return meta ? { ...meta } : null;
}

async function loadConvFullTexts() {
    try {
        const db = await openConvDB();
        const tx = db.transaction('conversations', 'readonly');
        const store = tx.objectStore('conversations');
        const [keys, allValues] = await Promise.all([
            new Promise((r) => { const req = store.getAllKeys(); req.onsuccess = () => r(req.result); req.onerror = () => r([]); }),
            new Promise((r) => { const req = store.getAll(); req.onsuccess = () => r(req.result); req.onerror = () => r([]); })
        ]);
        const result = {};
        for (let i = 0; i < keys.length; i++) {
            try {
                const raw = allValues[i];
                if (!raw) continue;
                const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (data.deleted) continue;
                let fullText = '';
                if (data.messages) {
                    for (const msg of data.messages) {
                        if (typeof msg.content === 'string') {
                            fullText += msg.content + ' ';
                        } else if (Array.isArray(msg.content)) {
                            for (const p of msg.content) {
                                if (p.type === 'text') fullText += p.text + ' ';
                            }
                        }
                    }
                }
                result[keys[i]] = fullText.toLowerCase();
            } catch (e) { console.warn('Erreur extraction texte conversation:', keys[i], e); }
        }
        return result;
    } catch (e) {
        console.warn('Erreur chargement textes conversations:', e);
        return {};
    }
}

// read, merge et write dans la même file ; mergeFn renvoie null pour ne rien écrire
async function updateConversationFile(filename, mergeFn) {
    const prev = _writeQueues.get(filename) || Promise.resolve();
    const next = prev.then(async () => {
        try {
            const db = await openConvDB();
            const txR = db.transaction('conversations', 'readonly');
            const reqR = txR.objectStore('conversations').get(filename);
            const raw = await new Promise((resolve) => {
                reqR.onsuccess = () => resolve(reqR.result);
                reqR.onerror = () => resolve(null);
            });
            const current = raw == null ? null : (typeof raw === 'string' ? JSON.parse(raw) : raw);
            if (current && current.deleted) return false;
            let updated = await mergeFn(current);
            if (updated == null) return false;
            updated = _convContentForDisk(updated);
            await flushPendingTexts();
            const txW = db.transaction('conversations', 'readwrite');
            txW.objectStore('conversations').put(updated, filename);
            return new Promise((resolve) => {
                txW.oncomplete = () => {
                    _afterConvWrite(filename, updated);
                    resolve(true);
                };
                txW.onerror = () => resolve(false);
                txW.onabort = () => resolve(false);
            });
        } catch (e) {
            console.error('Erreur update conversation:', e);
            return false;
        }
    });
    const guarded = next.catch(() => {});
    _writeQueues.set(filename, guarded);
    guarded.finally(() => {
        if (_writeQueues.get(filename) === guarded) _writeQueues.delete(filename);
    });
    return next;
}

async function readConversationFile(filename) {
    try {
        const db = await openConvDB();
        const tx = db.transaction('conversations', 'readonly');
        const req = tx.objectStore('conversations').get(filename);
        return new Promise((resolve) => {
            req.onsuccess = () => {
                const raw = req.result;
                if (!raw) { resolve(null); return; }
                try { resolve(typeof raw === 'string' ? JSON.parse(raw) : raw); }
                catch (e) { console.error('Conversation illisible :', filename, e); resolve(null); }
            };
            req.onerror = () => resolve(null);
        });
    } catch (e) {
        console.error('Erreur lecture conversation:', e);
        return null;
    }
}

// Supprimée : on garde coûts, compteurs, catégorie et modèle du titre (statistiques), aucun texte
function archivedConversation(existing) {
    const archived = { messages: [], deleted: true };
    for (const k of ['id', 'modele', 'date', 'lastActivity', 'tokens_entree', 'tokens_sortie', 'totalCost',
        'cout_images', 'cout_audio', 'cout_titre', 'cout_estime_usd', 'cost_by_model', 'category']) if (existing && existing[k] !== undefined) archived[k] = existing[k];
    const titleModel = _titleModelOf(existing);
    if (titleModel) archived.titre_modele = titleModel;
    return archived;
}

async function deleteConversationFile(filename) {
    try {
        const existing = await readConversationFile(filename);
        if (existing) {
            // Contenus à part de ses fichiers libérés ensuite par gcCanvasAssets
            const archived = archivedConversation(existing);
            const done = await writeConversationFile(filename, archived);
            if (typeof window !== 'undefined' && typeof window.scheduleCanvasAssetGc === 'function') window.scheduleCanvasAssetGc();
            return done;
        }
        return false;
    } catch (e) {
        console.error('Erreur suppression conversation:', e);
        return false;
    }
}

// --- Fichiers des Artifacts que l'IA ne lit pas ---
// Base à part, un Blob par empreinte ({ blob, type, size }) ; inutilisés retirés par app.js (gcCanvasAssets)

function openCanvasAssetDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('davidtwentyai_artifacts_files', 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains('canvas_assets')) req.result.createObjectStore('canvas_assets');
        };
        req.onsuccess = () => {
            req.result.onversionchange = () => req.result.close();
            resolve(req.result);
        };
        req.onblocked = () => reject(new Error('Fermez les autres onglets DavidTwentyAI puis rechargez cette page.'));
        req.onerror = () => reject(req.error);
    });
}

function _canvasAssetRequest(mode, operation) {
    return openCanvasAssetDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction('canvas_assets', mode);
        let result;
        tx.oncomplete = () => { db.close(); resolve(result); };
        tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || new Error('Stockage des fichiers impossible')); };
        const req = operation(tx.objectStore('canvas_assets'));
        if (req) req.onsuccess = () => { result = req.result; };
    }));
}

async function putCanvasAsset(hash, blob) {
    const exists = await _canvasAssetRequest('readonly', store => store.count(hash));
    if (exists) return true;
    await _canvasAssetRequest('readwrite', store => store.put({ blob, type: blob.type || '', size: blob.size }, hash));
    return true;
}

async function getCanvasAsset(hash) {
    const value = await _canvasAssetRequest('readonly', store => store.get(hash));
    return value && value.blob instanceof Blob ? value.blob : null;
}

async function listCanvasAssetSizes() {
    const out = new Map();
    await _canvasAssetRequest('readonly', store => {
        const req = store.openCursor();
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return;
            out.set(String(cursor.key), Number(cursor.value && cursor.value.size) || 0);
            cursor.continue();
        };
        return null;
    });
    return out;
}

async function deleteCanvasAssets(hashes) {
    const list = Array.from(hashes || []);
    if (!list.length) return;
    await _canvasAssetRequest('readwrite', store => { for (const h of list) store.delete(h); return null; });
}

// --- Textes des Artifacts et du Canvas : une fois par empreinte, la conversation n'en garde que les refs ---

// Empreinte synchrone (l'écriture d'une conversation l'est) : deux cyrb53 et la longueur
function _cyrb53(str, seed) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
const _textRefCache = new Map();
const _textByRef = new Map();
let _textByRefChars = 0;
const _pendingTexts = new Map();     // empreinte → texte, à écrire avant la conversation
const _storedTextRefs = new Set();

function textRefOf(text) {
    const s = String(text);
    let ref = _textRefCache.get(s);
    if (ref) return ref;
    ref = 't' + _cyrb53(s, 1) + _cyrb53(s, 2) + s.length.toString(36);
    if (_textRefCache.size > 5000) _textRefCache.clear();
    _textRefCache.set(s, ref);
    return ref;
}

function _rememberText(ref, text) {
    if (_textByRef.has(ref)) return _textByRef.get(ref);
    if (_textByRefChars > 64e6) { _textByRef.clear(); _textByRefChars = 0; }
    _textByRef.set(ref, text);
    _textByRefChars += text.length;
    return text;
}

/* Textes absents de la base : en attente jusqu'à l'écriture suivante (flushPendingTexts) */
function _filesToRefs(files) {
    const refs = {};
    for (const name of Object.keys(files || {})) {
        const text = files[name];
        if (typeof text !== 'string') continue;
        const ref = textRefOf(text);
        refs[name] = ref;
        _rememberText(ref, text);
        if (!_storedTextRefs.has(ref)) _pendingTexts.set(ref, text);
    }
    return refs;
}

// Champs des messages et du canvas : texte complet en mémoire, empreintes sur disque
const _MSG_FILE_FIELDS = [['canvasBefore', 'canvasBeforeRefs'], ['canvasAfter', 'canvasAfterRefs']];
const _CANVAS_FILE_FIELDS = [['files', 'fileRefs'], ['aiFiles', 'aiFileRefs']];

/* Ne modifie pas data (souvent l'état en mémoire) ; le renvoie tel quel s'il n'y a rien à convertir */
function conversationFilesToRefs(data) {
    if (!data || typeof data !== 'object') return data;
    let out = data;
    const own = () => { if (out === data) out = { ...data }; return out; };
    if (data.canvas && typeof data.canvas === 'object' && _CANVAS_FILE_FIELDS.some(([f]) => data.canvas[f] && typeof data.canvas[f] === 'object')) {
        const canvas = { ...data.canvas };
        for (const [f, r] of _CANVAS_FILE_FIELDS) {
            if (canvas[f] && typeof canvas[f] === 'object') { canvas[r] = _filesToRefs(canvas[f]); delete canvas[f]; }
        }
        own().canvas = canvas;
    }
    if (Array.isArray(data.messages) && data.messages.some(m => m && _MSG_FILE_FIELDS.some(([f]) => m[f] && typeof m[f] === 'object'))) {
        own().messages = data.messages.map(m => {
            if (!m || !_MSG_FILE_FIELDS.some(([f]) => m[f] && typeof m[f] === 'object')) return m;
            const c = { ...m };
            for (const [f, r] of _MSG_FILE_FIELDS) {
                if (c[f] && typeof c[f] === 'object') { c[r] = _filesToRefs(c[f]); delete c[f]; }
            }
            return c;
        });
    }
    return out;
}

// Conversation encore en clair (écriture qui ne passe pas par formatConversationFile)
const _INLINE_FILES_RE = /"(?:canvasBefore|canvasAfter|aiFiles|files)"\s*:\s*\{/;

function _convContentForDisk(content) {
    if (typeof content === 'string') {
        if (!_INLINE_FILES_RE.test(content)) return content;
        try { return JSON.stringify(conversationFilesToRefs(JSON.parse(content)), null, 2); }
        catch { return content; }
    }
    return content && typeof content === 'object' ? conversationFilesToRefs(content) : content;
}

/* Écriture refusée : textes laissés en attente et la conversation n'est pas écrite (exception) */
async function flushPendingTexts() {
    if (!_pendingTexts.size) return;
    const batch = [..._pendingTexts];
    await _canvasAssetRequest('readwrite', store => {
        // Taille en octets pour le panneau Stockage et la sauvegarde
        for (const [ref, text] of batch) store.put({ text, size: new Blob([text]).size, kind: 'text' }, ref);
        return null;
    });
    for (const [ref, text] of batch) {
        _storedTextRefs.add(ref);
        if (_pendingTexts.get(ref) === text) _pendingTexts.delete(ref);
    }
}

async function readTexts(refs) {
    const out = new Map();
    const missing = [];
    for (const ref of new Set(refs)) {
        if (_textByRef.has(ref)) out.set(ref, _textByRef.get(ref));
        else if (_pendingTexts.has(ref)) out.set(ref, _pendingTexts.get(ref));
        else missing.push(ref);
    }
    if (missing.length) {
        await _canvasAssetRequest('readonly', store => {
            for (const ref of missing) {
                const req = store.get(ref);
                req.onsuccess = () => {
                    const v = req.result;
                    if (v && typeof v.text === 'string') {
                        out.set(ref, _rememberText(ref, v.text));
                        _storedTextRefs.add(ref);
                    }
                };
            }
            return null;
        });
    }
    return out;
}

/* Renvoie les noms des fichiers introuvables ; une ancienne conversation en clair reste telle quelle */
async function conversationRefsToFiles(data) {
    if (!data || typeof data !== 'object') return [];
    const holders = [];
    if (data.canvas && typeof data.canvas === 'object') {
        for (const [f, r] of _CANVAS_FILE_FIELDS) if (data.canvas[r] && typeof data.canvas[r] === 'object') holders.push([data.canvas, f, r]);
    }
    for (const m of Array.isArray(data.messages) ? data.messages : []) {
        if (!m || typeof m !== 'object') continue;
        for (const [f, r] of _MSG_FILE_FIELDS) if (m[r] && typeof m[r] === 'object') holders.push([m, f, r]);
    }
    if (!holders.length) return [];
    const texts = await readTexts(holders.flatMap(([o, , r]) => Object.values(o[r])));
    const missing = new Set();
    for (const [o, f, r] of holders) {
        const files = {};
        for (const [name, ref] of Object.entries(o[r])) {
            if (texts.has(ref)) files[name] = texts.get(ref);
            else if (f === 'files') missing.add(name);
        }
        o[f] = files;
        delete o[r];
    }
    return [...missing];
}

function conversationTextRefs(data) {
    const out = [];
    const add = refs => { for (const v of Object.values(refs || {})) if (typeof v === 'string') out.push(v); };
    if (data && data.canvas) for (const [, r] of _CANVAS_FILE_FIELDS) add(data.canvas[r]);
    for (const m of Array.isArray(data && data.messages) ? data.messages : []) {
        if (m) for (const [, r] of _MSG_FILE_FIELDS) add(m[r]);
    }
    return out;
}

/* Jamais retirées par le nettoyage */
function sessionTextRefs() {
    return new Set([..._textByRef.keys(), ..._pendingTexts.keys(), ..._storedTextRefs]);
}

async function getStoredText(ref) {
    const texts = await readTexts([ref]);
    return texts.has(ref) ? texts.get(ref) : null;
}

async function putStoredText(ref, text) {
    if (typeof text !== 'string' || textRefOf(text) !== ref) throw new Error('Texte des Artifacts altéré dans la sauvegarde');
    _pendingTexts.set(ref, text);
    await flushPendingTexts();
}

/* Conversion unique des conversations aux fichiers en clair : réécrites avec des empreintes */
async function convertInlineConversationFiles() {
    const db = await openConvDB();
    const keys = await new Promise((resolve, reject) => {
        const req = db.transaction('conversations', 'readonly').objectStore('conversations').getAllKeys();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
    db.close();
    let converted = 0;
    for (const key of keys) {
        await updateConversationFile(key, raw => {
            if (!raw) return null;
            const out = conversationFilesToRefs(raw);
            if (out === raw) return null;
            converted++;
            return JSON.stringify(out, null, 2);
        });
    }
    return converted;
}

// --- Gestion des System Prompts (localStorage) ---

const SP_STORAGE_KEY = 'minou-systemprompts';

function _getSpStore() {
    try {
        return JSON.parse(localStorage.getItem(SP_STORAGE_KEY)) || {};
    } catch (e) {
        return {};
    }
}

function _saveSpStore(store) {
    localStorage.setItem(SP_STORAGE_KEY, JSON.stringify(store));
}

async function listSystemPrompts() {
    const store = _getSpStore();
    const prompts = Object.entries(store).map(([filename, data]) => ({
        filename,
        nom: data.nom,
        contenu: data.contenu,
        ecraserInstructions: !!data.ecraserInstructions
    }));
    prompts.sort((a, b) => a.nom.localeCompare(b.nom));
    return prompts;
}

async function readSystemPrompt(filename) {
    const store = _getSpStore();
    return store[filename] || null;
}

// Champ non transmis conservé ; ecraserInstructions écrit seulement s'il est vrai
async function writeSystemPrompt(filename, data) {
    const store = _getSpStore();
    const entry = { ...(store[filename] || {}), ...data };
    if (!entry.ecraserInstructions) delete entry.ecraserInstructions;
    store[filename] = entry;
    _saveSpStore(store);
    return true;
}

async function deleteSystemPromptFile(filename) {
    const store = _getSpStore();
    delete store[filename];
    _saveSpStore(store);
    return true;
}

async function importDefaultSystemPrompts() {
    const store = _getSpStore();
    if (Object.keys(store).length > 0) return;
    const defaults = [
        { filename: 'sympote.json', nom: 'sympote', contenu: 'tu es mon pote, on s\'écrit un peu en langage sms, cool, friendly, marrant.' }
    ];
    for (const sp of defaults) {
        store[sp.filename] = { nom: sp.nom, contenu: sp.contenu };
    }
    _saveSpStore(store);
}

// --- Gestion des Prompts enregistrés (localStorage) ---

const PROMPT_STORAGE_KEY = 'minou-savedprompts';

function _getPromptStore() {
    try {
        return JSON.parse(localStorage.getItem(PROMPT_STORAGE_KEY)) || {};
    } catch (e) {
        return {};
    }
}

function _savePromptStore(store) {
    localStorage.setItem(PROMPT_STORAGE_KEY, JSON.stringify(store));
}

async function listSavedPrompts() {
    const store = _getPromptStore();
    const prompts = Object.entries(store).map(([filename, data]) => ({
        filename,
        nom: data.nom,
        contenu: data.contenu
    }));
    prompts.sort((a, b) => a.nom.localeCompare(b.nom));
    return prompts;
}

async function readSavedPrompt(filename) {
    const store = _getPromptStore();
    return store[filename] || null;
}

async function writeSavedPrompt(filename, data) {
    const store = _getPromptStore();
    store[filename] = { nom: data.nom, contenu: data.contenu };
    _savePromptStore(store);
    return true;
}

async function deleteSavedPrompt(filename) {
    const store = _getPromptStore();
    delete store[filename];
    _savePromptStore(store);
    return true;
}

// --- Gestion des Catégories (localStorage) ---

const CAT_STORAGE_KEY = 'minou-categories';

function _getCatStore() {
    try {
        return JSON.parse(localStorage.getItem(CAT_STORAGE_KEY)) || {};
    } catch (e) {
        return {};
    }
}

function _saveCatStore(store) {
    localStorage.setItem(CAT_STORAGE_KEY, JSON.stringify(store));
}

function listCategories() {
    const store = _getCatStore();
    return Object.entries(store).map(([id, data]) => ({
        id,
        nom: data.nom,
        couleur: data.couleur,
        icone: data.icone
    }));
}

function readCategory(id) {
    const store = _getCatStore();
    return store[id] || null;
}

function writeCategory(id, data) {
    const store = _getCatStore();
    store[id] = { nom: data.nom, couleur: data.couleur, icone: data.icone };
    _saveCatStore(store);
}

function deleteCategory(id) {
    const store = _getCatStore();
    delete store[id];
    _saveCatStore(store);
}

// pinnedAt : date ISO qui ordonne les épinglées, null pour désépingler ; dans la file d'écriture
async function updateConversationPinned(filename, pinnedAt) {
    await updateConversationFile(filename, data => {
        if (!data) return null;
        if (pinnedAt) data.pinned = pinnedAt;
        else delete data.pinned;
        return data;
    });
}

// Pour une conversation qui répond en arrière-plan
async function updateConversationCostAlertOff(filename) {
    await updateConversationFile(filename, data => data ? { ...data, cost_alert_off: true } : null);
}

async function updateConversationCategory(filename, categoryId) {
    await updateConversationFile(filename, data => {
        if (!data) return null;
        if (categoryId) data.category = categoryId;
        else delete data.category;
        return data;
    });
}

function formatConversationFile(data) {
    const imgCost = data.totalImageCost || 0;
    const audioCost = data.totalAudioCost || 0;
    const titleCost = data.totalTitleCost || 0;
    const extraCost = imgCost + audioCost + titleCost;
    let cost = null;
    if (data.totalCost != null) {
        cost = Math.round((data.totalCost + extraCost) * 10000) / 10000;
    } else {
        // Anciennes conversations sans coût par segment
        const tarif = getTarif(data.model) || getImageTarif(data.model) || getSearchTarif(data.model);
        if (tarif) {
            cost = (data.totalInputTokens / 1_000_000) * tarif.inputPer1M
                 + (data.totalOutputTokens / 1_000_000) * tarif.outputPer1M
                 + extraCost;
            cost = Math.round(cost * 10000) / 10000;
        } else if (extraCost > 0) {
            cost = Math.round(extraCost * 10000) / 10000;
        }
    }
    const obj = {
        id: data.id,
        titre: data.title || null,
        modele: data.model,
        date: data.startTime,
        tokens_entree: data.totalInputTokens,
        tokens_sortie: data.totalOutputTokens,
        totalCost: data.totalCost || 0,
        cout_images: imgCost,
        cout_audio: audioCost,
        cout_titre: titleCost,
        cout_estime_usd: cost,
        cost_by_model: data.costByModel || null,
        messages: data.messages
    };
    if (data.lastActivity) obj.lastActivity = data.lastActivity;
    if (data.systemPrompt) obj.system_prompt = data.systemPrompt;
    if (data.systemPrompt && typeof data.systemPromptText === 'string' && data.systemPromptText) obj.system_prompt_text = data.systemPromptText;
    if (data.category) obj.category = data.category;
    if (data.pinned) obj.pinned = data.pinned;
    if (data.costAlertOff) obj.cost_alert_off = true;
    if (data.canvas) obj.canvas = data.canvas;
    if (data.compaction) obj.compaction = data.compaction;
    return JSON.stringify(conversationFilesToRefs(obj), null, 2);
}
