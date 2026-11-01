// rendu.js — formules mathématiques (KaTeX) et schémas Mermaid dans les réponses.
// Les formules sont mises de côté avant Markdown (qui mangerait les « \ »), puis rendues après le nettoyage HTML.
// Les blocs ```mermaid deviennent des dessins SVG ; mermaid.min.js n'est chargé qu'au premier schéma.

const MathRender = (function () {
    let saved = [];
    const MARK = i => `KXMATH${i}XK`;

    function keep(tex, display, raw) {
        saved.push({ tex, display, raw });
        return MARK(saved.length - 1);
    }

    // Hors code (blocs ``` / ~~~ et `code`) : $$…$$, \[…\], \(…\), $…$
    function protectText(text) {
        return text
            .replace(/\$\$([\s\S]+?)\$\$/g, (m, t) => keep(t, true, m))
            .replace(/\\\[([\s\S]+?)\\\]/g, (m, t) => keep(t, true, m))
            .replace(/\\\(([\s\S]+?)\\\)/g, (m, t) => keep(t, false, m))
            // $…$ : collé aux deux bords et pas suivi d'un chiffre, pour épargner les prix ($1.36 → $4.18)
            .replace(/(^|[^\\$])\$(?=\S)([^$\n]*?\S)\$(?!\d)/g, (m, pre, t) => pre + keep(t, false, m.slice(pre.length)));
    }

    function protect(markdown) {
        saved = [];
        if (typeof markdown !== 'string' || !/[$\\]/.test(markdown)) return markdown;
        return markdown.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g)
            .map((part, i) => i % 2 ? part : protectText(part))
            .join('');
    }

    function restore(html) {
        if (!saved.length) return html;
        const items = saved;
        saved = [];
        return String(html).replace(/KXMATH(\d+)XK/g, (m, i) => {
            const it = items[+i];
            if (!it) return m;
            if (typeof katex === 'undefined') return escapeHtml(it.raw);
            try {
                return katex.renderToString(it.tex, { displayMode: it.display, throwOnError: false, output: 'html', strict: 'ignore' });
            } catch (e) { return escapeHtml(it.raw); }
        });
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    return { protect, restore };
})();

(function mermaidDiagrams() {
    const KEYWORDS = /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|mindmap|timeline|journey|gitGraph|quadrantChart|xychart-beta|sankey-beta|block-beta)\b/;
    const cache = new Map();   // code → SVG (les messages sont souvent ré-affichés)
    let loading = null, counter = 0, timer = null;

    function loadMermaid() {
        if (window.mermaid) return Promise.resolve(window.mermaid);
        if (!loading) loading = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'vendor/mermaid.min.js';
            s.onload = () => {
                window.mermaid.initialize({
                    // Thème clair sur carte blanche : les modèles colorent leurs cases en pensant à un fond clair
                    startOnLoad: false, securityLevel: 'strict', theme: 'default',
                    fontFamily: getComputedStyle(document.body).fontFamily,
                });
                resolve(window.mermaid);
            };
            s.onerror = () => { loading = null; reject(new Error('mermaid indisponible')); };
            document.head.appendChild(s);
        });
        return loading;
    }

    // « \n » écrit dans les étiquettes par les modèles : vrai retour à la ligne
    const clean = code => code.replace(/\\n/g, '<br/>');

    async function renderBlock(code, pre) {
        const src = code.textContent;
        let svg = cache.get(src);
        if (!svg) {
            const mermaid = await loadMermaid();
            const { svg: out } = await mermaid.render('mmd-' + (++counter), clean(src));
            svg = out;
            cache.set(src, svg);
        }
        if (!pre.isConnected) return;
        const fig = document.createElement('div');
        fig.className = 'mermaid-diagram';
        fig.innerHTML = svg;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'mermaid-toggle';
        toggle.textContent = 'Voir le code';
        toggle.addEventListener('click', () => {
            const show = pre.hidden;
            pre.hidden = !show;
            toggle.textContent = show ? 'Masquer le code' : 'Voir le code';
        });
        pre.before(fig);
        fig.after(toggle);
        pre.hidden = true;
    }

    function scan() {
        timer = null;
        document.querySelectorAll('.message-text pre > code').forEach(code => {
            const pre = code.parentElement;
            if (pre.dataset.mermaid) return;
            const isMermaid = code.classList.contains('language-mermaid') || KEYWORDS.test(code.textContent);
            if (!isMermaid) return;
            // Réponse encore en cours d'écriture : le schéma est dessiné une fois terminée
            if (pre.closest('.streaming')) return;
            pre.dataset.mermaid = '1';
            renderBlock(code, pre).catch(() => {
                // Schéma invalide : le code reste affiché tel quel
                pre.dataset.mermaid = 'erreur';
            });
        });
    }

    const root = document.getElementById('chat-container') || document.body;
    new MutationObserver(() => {
        if (!timer) timer = setTimeout(scan, 400);
    }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    scan();
})();
