/* canvas-doc.js : vue texte du Canvas (Markdown rendu, modifiable) ; s'expose via window.CanvasDoc */
(function () {
    'use strict';

    // ---------- Rendu Markdown → HTML ----------

    // Le reste est retiré par DOMPurify avant d'entrer dans le DOM de DavidTwentyAI
    const RENDER_TAGS = ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 's', 'del', 'strike',
        'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
        'input', 'span', 'sub', 'sup', 'u', 'mark', 'div'];
    const RENDER_ATTR = ['href', 'title', 'src', 'alt', 'align', 'start', 'type', 'checked', 'disabled', 'class', 'colspan', 'rowspan'];
    // Collage : la même chose, sans image ni case à cocher
    const PASTE_TAGS = RENDER_TAGS.filter(t => t !== 'img' && t !== 'input');
    const PASTE_ATTR = ['href', 'title', 'align', 'start'];

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function canRender() {
        return typeof marked !== 'undefined' && typeof marked.parse === 'function' && typeof DOMPurify !== 'undefined';
    }

    // Instance propre : le marked global d'app.js retouche liens et texte, le sérialiseur veut le rendu standard
    let engine = null;
    function mdParse(src) {
        if (!engine) {
            try { engine = typeof marked.Marked === 'function' ? new marked.Marked({ gfm: true, breaks: true }) : null; }
            catch (e) { engine = null; }
        }
        return engine ? engine.parse(src, { async: false }) : marked.parse(src, { breaks: true, gfm: true, async: false });
    }

    /* Retours à la ligne simples = sauts de ligne (breaks) ; sans DOMPurify : texte échappé, sans balise */
    function renderHtml(md) {
        const src = String(md || '');
        if (!canRender()) return '<pre class="canvas-doc-raw">' + escapeHtml(src) + '</pre>';
        let html = '';
        try { html = mdParse(src); }
        catch (e) { return '<pre class="canvas-doc-raw">' + escapeHtml(src) + '</pre>'; }
        return DOMPurify.sanitize(String(html), { ALLOWED_TAGS: RENDER_TAGS, ALLOWED_ATTR: RENDER_ATTR });
    }

    function renderElement(md) {
        const el = document.createElement('div');
        el.innerHTML = renderHtml(md);
        return el;
    }

    // Sérialiseur HTML → Markdown
    // MARK_A/MARK_B (caractères privés) repèrent une sélection : jamais échappés, ignorés comme voisins

    const MARK_A = '';
    const MARK_B = '';
    const MARKS_RE = /[]/g;
    const isMark = c => c === MARK_A || c === MARK_B;

    const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL', 'PRE', 'HR', 'TABLE',
        'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'ADDRESS',
        'DETAILS', 'SUMMARY', 'LI', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH']);
    const MARK_TAGS = { STRONG: 'strong', B: 'strong', EM: 'em', I: 'em', S: 'del', DEL: 'del', STRIKE: 'del' };
    const DELIMS = { strong: ['**', '__'], em: ['*', '_'], del: ['~~'] };
    const HTML_MARKS = { strong: 'strong', em: 'em', del: 'del' };
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'SVG', 'BUTTON', 'SELECT', 'TEXTAREA']);
    // Gardés en HTML (pas d'équivalent Markdown) : « m<sup>2</sup> » et non « m2 »
    const RAW_INLINE_TAGS = new Set(['SUP', 'SUB', 'U', 'MARK']);

    const isWs = c => !c || /\s/u.test(c);
    const isPunct = c => !!c && /[\p{P}\p{S}]/u.test(c);
    const isWordChar = c => !!c && /[\p{L}\p{N}]/u.test(c);

    // Règles CommonMark : un délimiteur peut-il ouvrir / fermer entre ces voisins ?
    function leftFlanking(prev, next) {
        return !isWs(next) && (!isPunct(next) || isWs(prev) || isPunct(prev));
    }
    function rightFlanking(prev, next) {
        return !isWs(prev) && (!isPunct(prev) || isWs(next) || isPunct(next));
    }
    function canOpen(d, prev, next) {
        if (d[0] !== '_') return leftFlanking(prev, next);
        return leftFlanking(prev, next) && (!rightFlanking(prev, next) || isPunct(prev));
    }
    function canClose(d, prev, next) {
        if (d[0] !== '_') return rightFlanking(prev, next);
        return rightFlanking(prev, next) && (!leftFlanking(prev, next) || isPunct(next));
    }

    function lastChar(s) {
        for (let i = s.length - 1; i >= 0; i--) if (!isMark(s[i])) return s[i];
        return '';
    }
    function firstChar(s) {
        for (let i = 0; i < s.length; i++) if (!isMark(s[i])) return s[i];
        return '';
    }

    function indexSkippingMarks(s, n) {
        let k = 0;
        for (let i = 0; i < s.length; i++) {
            if (isMark(s[i])) continue;
            if (k === n) return i;
            k++;
        }
        return s.length;
    }

    function escapeText(s, lineStart, table) {
        let out = '';
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (c === '\\' || c === '`' || c === '*' || c === '~') { out += '\\' + c; continue; }
            if (c === '_') {
                // Entre deux lettres (nom_de_variable) : jamais de l'italique
                const prev = lastChar(s.slice(0, i)), next = firstChar(s.slice(i + 1));
                out += isWordChar(prev) && isWordChar(next) ? c : '\\' + c;
                continue;
            }
            if (c === '[') {
                // Seulement s'il pourrait ouvrir un lien ; repères retirés, sinon « [x] » en fin de ligne n'est plus échappé
                const rest = s.slice(i + 1).replace(MARKS_RE, '');
                out += /\](?:[([:]|$)/.test(rest) || /^[ xX]\]/.test(rest) ? '\\[' : '[';
                continue;
            }
            if (c === '<' && /^[A-Za-z/!?]/.test(s.slice(i + 1).replace(MARKS_RE, ''))) { out += '\\<'; continue; }
            if (c === '&' && /^#?\w+;/.test(s.slice(i + 1).replace(MARKS_RE, ''))) { out += '\\&'; continue; }
            if (c === '|' && table) { out += '\\|'; continue; }
            out += c;
        }
        if (lineStart) out = escapeLineStart(out);
        return out;
    }

    function escapeLineStart(s) {
        const clean = s.replace(MARKS_RE, '');
        let at = -1;
        if (/^#{1,6}(?:[ \t]|$)/.test(clean)) at = 0;
        else if (/^>/.test(clean)) at = 0;
        else if (/^[-+](?:[ \t]|$)/.test(clean)) at = 0;
        else if (/^(?:=+|-+)[ \t]*$/.test(clean)) at = 0;
        else {
            const m = /^(\d{1,9})[.)](?:[ \t]|$)/.exec(clean);
            if (m) at = m[1].length;
        }
        if (at < 0) return s;
        const i = indexSkippingMarks(s, at);
        return s.slice(0, i) + '\\' + s.slice(i);
    }

    function collapseWs(s) {
        return s.replace(/[ \t\n\r\f]+/g, ' ');
    }

    function isBlockEl(n) {
        return n.nodeType === 1 && BLOCK_TAGS.has(n.tagName);
    }

    function codeLang(pre) {
        const code = pre.querySelector('code');
        const cls = (code && code.getAttribute('class')) || pre.getAttribute('class') || '';
        const m = /(?:^|\s)language-([\w#+.-]+)/.exec(cls);
        return m ? m[1] : '';
    }

    function mdUrl(url) {
        return String(url).replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/</g, '%3C').replace(/>/g, '%3E');
    }
    function mdTitle(title) {
        return title ? ' "' + String(title).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : '';
    }

    // --- Contenu en ligne : jetons ---

    function inlineTokens(nodes, out, ctx) {
        for (const n of nodes) {
            if (n.nodeType === 3) {
                const v = collapseWs(n.data);
                if (v) out.push({ t: 'text', v });
                continue;
            }
            if (n.nodeType !== 1) continue;
            const tag = n.tagName;
            if (SKIP_TAGS.has(tag)) continue;
            if (tag === 'BR') { out.push({ t: 'br' }); continue; }
            if (MARK_TAGS[tag]) {
                const m = MARK_TAGS[tag];
                out.push({ t: 'open', m });
                inlineTokens(n.childNodes, out, ctx);
                out.push({ t: 'close', m });
                continue;
            }
            if (tag === 'CODE') {
                out.push({ t: 'code', v: n.textContent });
                continue;
            }
            if (RAW_INLINE_TAGS.has(tag)) {
                const t = tag.toLowerCase();
                const keep = !!n.textContent.replace(MARKS_RE, '').trim();
                if (keep) out.push({ t: 'raw', v: '<' + t + '>' });
                inlineTokens(n.childNodes, out, ctx);
                if (keep) out.push({ t: 'raw', v: '</' + t + '>' });
                continue;
            }
            if (tag === 'A') {
                const href = (n.getAttribute('href') || '').trim();
                const text = n.textContent;
                // Lien sans adresse (javascript: retiré au collage) ou sans contenu : seulement son contenu
                if (!href || (!text.replace(MARKS_RE, '').trim() && !n.querySelector('img'))) { inlineTokens(n.childNodes, out, ctx); continue; }
                const plain = !n.querySelector('*');
                const auto = plain && /^(?:https?:\/\/|mailto:)\S+$/i.test(href) && !/[.,:;!?)"'*_~]$/.test(href)
                    && (text === href || 'mailto:' + text === href);
                const www = plain && /^www\.\S+$/i.test(text) && href === 'http://' + text && !/[.,:;!?)"'*_~]$/.test(text);
                if (auto || www) { out.push({ t: 'raw', v: text }); continue; }
                // Adresse nue finissant par « ) » ou « . » : entre chevrons, sinon le lien automatique la coupe
                if (plain && text === href && /^https?:\/\/[^\s<>]+$/i.test(href)) { out.push({ t: 'raw', v: '<' + href + '>' }); continue; }
                out.push({ t: 'lopen' });
                inlineTokens(n.childNodes, out, ctx);
                out.push({ t: 'lclose', v: '](' + mdUrl(href) + mdTitle(n.getAttribute('title')) + ')' });
                continue;
            }
            if (tag === 'IMG') {
                const src = n.getAttribute('src');
                if (!src) continue;
                const alt = (n.getAttribute('alt') || '').replace(/[\\[\]]/g, '\\$&');
                out.push({ t: 'raw', v: '![' + alt + '](' + mdUrl(src) + mdTitle(n.getAttribute('title')) + ')' });
                continue;
            }
            if (tag === 'INPUT') {
                if ((n.getAttribute('type') || '').toLowerCase() === 'checkbox') out.push({ t: 'task', v: typeof n.checked === 'boolean' ? n.checked : n.hasAttribute('checked') });
                continue;
            }
            if (isBlockEl(n) && out.length) out.push({ t: 'br' });
            inlineTokens(n.childNodes, out, ctx);
        }
        return out;
    }

    function tidyTokens(tokens) {
        let changed = true;
        let guard = 0;
        while (changed && guard++ < 50) {
            changed = false;
            for (let i = 0; i < tokens.length; i++) {
                const a = tokens[i], b = tokens[i + 1];
                if (!b) break;
                // **a****b** → **ab**
                if (a.t === 'close' && b.t === 'open' && a.m === b.m) { tokens.splice(i, 2); changed = true; break; }
                if (a.t === 'open' && b.t === 'close' && a.m === b.m) { tokens.splice(i, 2); changed = true; break; }
                if (a.t === 'open' && b.t === 'text' && /^[ \t]/.test(b.v.replace(MARKS_RE, ''))) {
                    const m = /^((?:[]*[ \t])+)/.exec(b.v);
                    if (m) {
                        const lead = m[1];
                        b.v = b.v.slice(lead.length);
                        tokens.splice(i, 0, { t: 'text', v: lead });
                        if (!b.v) tokens.splice(i + 2, 1);
                        changed = true; break;
                    }
                }
                if (a.t === 'open' && b.t === 'br') { tokens[i] = b; tokens[i + 1] = a; changed = true; break; }
                if (a.t === 'text' && b.t === 'close' && /[ \t]$/.test(a.v.replace(MARKS_RE, ''))) {
                    const m = /((?:[ \t][]*)+)$/.exec(a.v);
                    if (m) {
                        const tail = m[1];
                        a.v = a.v.slice(0, a.v.length - tail.length);
                        tokens.splice(i + 2, 0, { t: 'text', v: tail });
                        if (!a.v) tokens.splice(i, 1);
                        changed = true; break;
                    }
                }
                if (a.t === 'br' && b.t === 'close') { tokens[i] = b; tokens[i + 1] = a; changed = true; break; }
            }
        }
        return tokens;
    }

    function tokenEdge(tok, first, ctx) {
        if (!tok) return '';
        switch (tok.t) {
            case 'text': { const e = escapeText(tok.v, false, ctx.table); return first ? firstChar(e) : lastChar(e); }
            case 'br': return '\n';
            case 'open': case 'close': return '*';
            case 'code': return '`';
            case 'lopen': return '[';
            case 'lclose': return ')';
            case 'task': return first ? '[' : ']';
            default: return first ? firstChar(tok.v) : lastChar(tok.v);
        }
    }

    function firstEdgeFrom(tokens, i, ctx) {
        for (; i < tokens.length; i++) {
            const c = tokenEdge(tokens[i], true, ctx);
            if (c) return c;
        }
        return '';
    }

    function tokensToMarkdown(tokens, ctx, lineStartAtBegin) {
        tidyTokens(tokens);
        let out = '';
        let lineStart = lineStartAtBegin;
        const open = []; // délimiteurs ouverts : { m, d }
        const pair = new Map();
        const stack = [];
        tokens.forEach((t, i) => {
            if (t.t === 'open') stack.push(i);
            else if (t.t === 'close') { const j = stack.pop(); if (j != null) pair.set(j, i); }
        });
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            switch (t.t) {
                case 'text': {
                    out += escapeText(t.v, lineStart && !/\S/.test(out.slice(out.lastIndexOf('\n') + 1).replace(MARKS_RE, '')), ctx.table);
                    if (t.v.replace(MARKS_RE, '').trim()) lineStart = false;
                    break;
                }
                case 'br':
                    if (ctx.table) out += '<br>';
                    else if (ctx.heading) out += ' ';
                    else { out += '\n'; lineStart = true; }
                    break;
                case 'open': {
                    const j = pair.get(i);
                    const prev = lastChar(out) || ' ';
                    const next = firstEdgeFrom(tokens, i + 1, ctx) || ' ';
                    const cPrev = j != null ? (tokenEdge(tokens[j - 1], false, ctx) || ' ') : ' ';
                    const cNext = j != null ? (firstEdgeFrom(tokens, j + 1, ctx) || ' ') : ' ';
                    const cands = DELIMS[t.m].slice();
                    // Contre un autre délimiteur `*` : `_` d'abord (**_a_** et non ***a***)
                    if (cands.length > 1 && (prev === '*' || next === '*' || cPrev === '*' || cNext === '*')) cands.reverse();
                    let d = cands.find(c => canOpen(c, prev === '\n' ? ' ' : prev, next) && canClose(c, cPrev, cNext === '\n' ? ' ' : cNext));
                    if (!d) d = '<' + HTML_MARKS[t.m] + '>';
                    open.push({ m: t.m, d });
                    out += d;
                    lineStart = false;
                    break;
                }
                case 'close': {
                    const o = open.pop();
                    if (!o) break;
                    out += o.d[0] === '<' ? '</' + HTML_MARKS[o.m] + '>' : o.d;
                    break;
                }
                case 'code': {
                    // Dans un tableau, « | » couperait la cellule (GFM accepte \| dans le code)
                    const v = ctx.table ? t.v.replace(/\n/g, ' ').replace(/\|/g, '\\|') : t.v.replace(/\n/g, ' ');
                    const runs = v.match(/`+/g) || [];
                    const n = runs.reduce((mx, r) => Math.max(mx, r.length), 0) + 1;
                    const fence = '`'.repeat(n);
                    const clean = v.replace(MARKS_RE, '');
                    const pad = /^`|`$/.test(clean) || (/^ /.test(clean) && / $/.test(clean) && clean.trim()) ? ' ' : '';
                    out += fence + pad + v + pad + fence;
                    lineStart = false;
                    break;
                }
                case 'lopen': out += '['; lineStart = false; break;
                case 'lclose': out += t.v; break;
                case 'task': out += t.v ? '[x]' : '[ ]'; lineStart = false; break;
                default: out += t.v; lineStart = false;
            }
        }
        out = out.replace(/[ \t]+((?:[])*)\n/g, '$1\n').replace(/\n((?:[])*)[ \t]+/g, '\n$1');
        return trimKeepMarks(out);
    }

    function trimKeepMarks(s) {
        let a = 0, b = s.length;
        let lead = '', tail = '';
        while (a < b && (/[ \t\n]/.test(s[a]) || isMark(s[a]))) { if (isMark(s[a])) lead += s[a]; a++; }
        while (b > a && (/[ \t\n ]/.test(s[b - 1]) || isMark(s[b - 1]))) { if (isMark(s[b - 1])) tail = s[b - 1] + tail; b--; }
        return lead + s.slice(a, b) + tail;
    }

    function inlineMarkdown(node, ctx, lineStart) {
        return tokensToMarkdown(inlineTokens(node.childNodes, [], ctx || {}), ctx || {}, lineStart !== false);
    }

    function inlineFromNodes(nodes, ctx) {
        return tokensToMarkdown(inlineTokens(nodes, [], ctx), ctx, true);
    }

    // --- Blocs ---

    function serializeBlocks(node, ctx) {
        const blocks = [];
        let run = [];
        let prevList = null;
        const flushRun = () => {
            if (!run.length) return;
            const md = inlineFromNodes(run, ctx);
            run = [];
            if (md.replace(MARKS_RE, '').trim()) { blocks.push(md); prevList = null; }
            else if (md && blocks.length) blocks[blocks.length - 1] += md.replace(/[^]/g, '');
        };
        for (let n = node.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 1 && SKIP_TAGS.has(n.tagName)) continue;
            if (n.nodeType === 3 && !n.data.replace(MARKS_RE, '').trim() && !run.length && !/[]/.test(n.data)) continue;
            if (!isBlockEl(n)) { run.push(n); continue; }
            flushRun();
            const tag = n.tagName;
            let md = '';
            if (tag === 'UL' || tag === 'OL') {
                // Deux listes de suite : puce différente, sinon elles n'en feraient qu'une
                const alt = !!(prevList && prevList.tag === tag && !prevList.alt);
                md = serializeList(n, ctx, alt);
                if (md.replace(MARKS_RE, '').trim()) {
                    blocks.push(md);
                    prevList = { tag, alt };
                }
                continue;
            }
            if (/^H[1-6]$/.test(tag)) {
                let text = inlineMarkdown(n, { ...ctx, heading: true }, false);
                if (!text.replace(MARKS_RE, '').trim()) continue;
                if (/#$/.test(text.replace(MARKS_RE, ''))) text = text.replace(/#((?:[])*)$/, '\\#$1');
                md = '#'.repeat(Number(tag[1])) + ' ' + text;
            } else if (tag === 'PRE') {
                const code = (n.querySelector('code') || n).textContent.replace(/\n$/, '');
                const runs = code.match(/^[ \t]*`{3,}/gm) || [];
                const len = runs.reduce((mx, r) => Math.max(mx, r.trim().length), 2) + 1;
                const fence = '`'.repeat(len);
                md = fence + codeLang(n) + '\n' + code + '\n' + fence;
            } else if (tag === 'HR') {
                md = '---';
            } else if (tag === 'BLOCKQUOTE') {
                const inner = serializeBlocks(n, ctx).join('\n\n');
                if (!inner.replace(MARKS_RE, '').trim()) continue;
                md = inner.split('\n').map(l => l.replace(MARKS_RE, '') ? '> ' + l : '>' + l).join('\n');
            } else if (tag === 'TABLE') {
                md = serializeTable(n, ctx);
            } else if ((tag === 'P' || tag === 'DT' || tag === 'DD' || tag === 'FIGCAPTION' || tag === 'SUMMARY' || tag === 'ADDRESS' || tag === 'TD' || tag === 'TH' || tag === 'LI')
                && !Array.from(n.childNodes).some(isBlockEl)) {
                md = inlineMarkdown(n, ctx, true);
            } else {
                const hasBlock = Array.from(n.childNodes).some(isBlockEl);
                if (hasBlock) {
                    const inner = serializeBlocks(n, ctx);
                    if (inner.length) { blocks.push(...inner); prevList = null; }
                    continue;
                }
                md = inlineMarkdown(n, ctx, true);
            }
            if (md.replace(MARKS_RE, '').trim()) { blocks.push(md); prevList = null; }
            else if (md && blocks.length) blocks[blocks.length - 1] += md.replace(/[^]/g, '');
        }
        flushRun();
        return blocks;
    }

    function serializeList(list, ctx, alt) {
        const ordered = list.tagName === 'OL';
        let num = ordered ? parseInt(list.getAttribute('start'), 10) : 0;
        if (ordered && !Number.isFinite(num)) num = 1;
        const items = [];
        const lis = Array.from(list.children).filter(c => c.tagName === 'LI');
        // Liste « aérée » : un élément contient des paragraphes
        const loose = lis.some(li => Array.from(li.children).some(c => c.tagName === 'P'));
        for (const li of lis) {
            const marker = ordered ? (num++) + (alt ? ')' : '.') + ' ' : (alt ? '* ' : '- ');
            const blocks = serializeBlocks(li, ctx);
            if (!blocks.length || !blocks.join('').replace(MARKS_RE, '').trim()) continue;
            let body = blocks.join(loose ? '\n\n' : '\n');
            // Case à cocher : « [x] » suivi d'une seule espace ; un vrai « [ ] » de texte est échappé
            if (/^[]*\[[ x]\]/.test(body) && li.querySelector('input[type="checkbox"]')) {
                body = body.replace(/^([]*\[[ x]\])[ \t]*/, '$1 ');
            }
            const pad = ' '.repeat(marker.length);
            const lines = body.split('\n');
            items.push(marker + lines[0] + lines.slice(1).map(l => '\n' + (l.replace(MARKS_RE, '') ? pad + l : l)).join(''));
        }
        return items.join(loose ? '\n\n' : '\n');
    }

    function serializeTable(table, ctx) {
        const rows = Array.from(table.querySelectorAll('tr')).filter(tr => tr.closest('table') === table);
        if (!rows.length) return '';
        const cellsOf = tr => Array.from(tr.children).filter(c => c.tagName === 'TD' || c.tagName === 'TH');
        const head = cellsOf(rows[0]);
        const cols = Math.max(1, head.length);
        const cellText = c => c ? inlineMarkdown(c, { ...ctx, table: true }, false).replace(/\n/g, ' ') : '';
        const align = head.map(c => (c.getAttribute('align') || c.style.textAlign || '').toLowerCase());
        const line = cells => '| ' + Array.from({ length: cols }, (_, i) => cellText(cells[i])).join(' | ') + ' |';
        const sep = '| ' + Array.from({ length: cols }, (_, i) => align[i] === 'center' ? ':---:' : align[i] === 'right' ? '---:' : align[i] === 'left' ? ':---' : '---').join(' | ') + ' |';
        return [line(head), sep].concat(rows.slice(1).map(tr => line(cellsOf(tr)))).join('\n');
    }

    function serialize(root) {
        if (!root) return '';
        return serializeBlocks(root, {}).join('\n\n');
    }

    function normalize(md) {
        if (!canRender()) return String(md || '');
        return serialize(renderElement(md));
    }

    // ---------- Texte brut (Télécharger en .txt, Copier) ----------

    function plainBlocks(node) {
        const out = [];
        let run = '';
        const flush = () => { const t = run.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim(); if (t) out.push(t); run = ''; };
        for (let n = node.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3) { run += collapseWs(n.data); continue; }
            if (n.nodeType !== 1 || SKIP_TAGS.has(n.tagName)) continue;
            if (n.tagName === 'BR') { run += '\n'; continue; }
            if (!isBlockEl(n)) { run += plainInline(n); continue; }
            flush();
            const tag = n.tagName;
            if (tag === 'UL' || tag === 'OL') {
                let k = parseInt(n.getAttribute('start'), 10) || 1;
                const items = Array.from(n.children).filter(c => c.tagName === 'LI').map(li => {
                    const box = li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
                    const mark = tag === 'OL' ? (k++) + '. ' : box ? (box.checked ? '☑ ' : '☐ ') : '• ';
                    return mark + plainBlocks(li).join('\n').replace(/\n/g, '\n   ');
                });
                out.push(items.join('\n'));
            } else if (tag === 'PRE') {
                out.push(n.textContent.replace(/\n$/, ''));
            } else if (tag === 'HR') {
                out.push('* * *');
            } else if (tag === 'TABLE') {
                out.push(Array.from(n.querySelectorAll('tr')).map(tr => Array.from(tr.children).map(c => plainInline(c).trim()).join('\t')).join('\n'));
            } else if (tag === 'BLOCKQUOTE') {
                out.push(plainBlocks(n).join('\n\n').split('\n').map(l => '    ' + l).join('\n'));
            } else {
                const inner = Array.from(n.childNodes).some(isBlockEl) ? plainBlocks(n).join('\n\n') : plainInline(n).trim();
                if (inner) out.push(inner);
            }
        }
        flush();
        return out;
    }

    function plainInline(node) {
        let s = '';
        for (let n = node.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3) s += collapseWs(n.data);
            else if (n.nodeType === 1 && n.tagName === 'BR') s += '\n';
            else if (n.nodeType === 1 && n.tagName === 'IMG') s += n.getAttribute('alt') || '';
            else if (n.nodeType === 1 && !SKIP_TAGS.has(n.tagName)) s += plainInline(n);
        }
        return s;
    }

    function toPlainText(md) {
        if (!canRender()) return String(md || '');
        return plainBlocks(renderElement(md)).join('\n\n').replace(MARKS_RE, '');
    }

    function countWords(md) {
        const text = String(md || '')
            .replace(/^```.*$/gm, '')
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/^[ \t]*(?:#{1,6}|>+|[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
            .replace(/^[ \t]*\|?[ \t:-]*-{3,}[ \t:|-]*$/gm, '')
            .replace(/[*_~`|\\]+/g, '')
            .replace(/\n{2,}/g, '\n')
            .trim();
        const words = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
        return { words: words.length, chars: text.replace(/\n/g, ' ').length };
    }

    function plainExcerpt(md) {
        return String(md || '')
            .replace(/^[ \t]*(?:#{1,6}|>+|[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/(^|[^\\])(?:\*\*?|__|~~|`+)/g, '$1')
            .replace(/(^|[^\\\p{L}\p{N}])_(?=\S)|(\S)_(?![\p{L}\p{N}])/gu, '$1$2')
            .replace(/\\([\\`*_~[\]<>#+\-.!|&()])/g, '$1')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // ---------- Comparaison par blocs (modifications, surlignage) ----------

    function renderBlocks(md) {
        const el = renderElement(md);
        return Array.from(el.children).map(b => ({ el: b, key: JSON.stringify(b.outerHTML.replace(/\s+/g, ' ')) }));
    }

    function blockDiff(aKeys, bKeys, lineDiff) {
        if (!aKeys.length) return bKeys.map((k, j) => ({ type: 'added', b: j }));
        if (!bKeys.length) return aKeys.map((k, i) => ({ type: 'removed', a: i }));
        const d = typeof lineDiff === 'function' ? lineDiff(aKeys.join('\n'), bKeys.join('\n')) : null;
        if (!d) return null;
        let i = 0, j = 0;
        return d.map(e => e.type === 'equal' ? { type: 'equal', a: i++, b: j++ }
            : e.type === 'removed' ? { type: 'removed', a: i++ } : { type: 'added', b: j++ });
    }

    // ---------- Vue texte (zone modifiable, barre de mise en forme) ----------

    const SVG = (inner, size) => '<svg width="' + (size || 14) + '" height="' + (size || 14) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
    const ICONS = {
        bold: '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
        italic: '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
        strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/>',
        code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
        link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
        chevron: '<path d="m6 9 6 6 6-6"/>',
        sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
        send: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
        check: '<polyline points="20 6 9 17 4 12"/>'
    };
    const BLOCK_STYLES = [
        { block: 'h1', label: 'Titre 1' }, { block: 'h2', label: 'Titre 2' }, { block: 'h3', label: 'Titre 3' },
        { block: 'p', label: 'Paragraphe' }, { block: 'blockquote', label: 'Citation' },
        { block: 'ul', label: 'Liste à puces' }, { block: 'ol', label: 'Liste numérotée' }
    ];
    // Suggestions rapides de « Demander à l'IA » : une consigne complète, envoyée aussitôt
    const ASK_CHIPS = [
        { label: 'Corriger', text: 'Corrige l\'orthographe, la grammaire et la ponctuation, sans changer le style.' },
        { label: 'Raccourcir', text: 'Raccourcis ce passage en gardant l\'essentiel.' },
        { label: 'Développer', text: 'Développe ce passage avec plus de détails, dans le même style.' },
        { label: 'Plus formel', text: 'Reformule ce passage dans un registre plus formel.' },
        { label: 'Plus simple', text: 'Simplifie ce passage pour qu\'il soit plus facile à lire.' },
        { label: 'Reformuler', text: 'Reformule ce passage autrement, sans en changer le sens.' }
    ];
    // Mises en forme en ligne : une sélection qui en coupe une est étendue à l'élément entier
    const INLINE_FMT = new Set(['STRONG', 'B', 'EM', 'I', 'S', 'DEL', 'STRIKE', 'CODE', 'A']);
    const HIGHLIGHT_FOCUS = 'canvas-doc-focus';
    const HIGHLIGHT_REVEAL = 'canvas-doc-reveal';
    const FLASH_MS = 2600;

    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
    const KEY = isMac ? '⌘' : 'Ctrl+';
    const SHIFT_KEY = isMac ? '⇧⌘' : 'Ctrl+Maj+';

    const canHighlight = () => typeof Highlight === 'function' && typeof CSS !== 'undefined' && !!CSS.highlights;

    function closestIn(node, tag, stop) {
        for (let n = node; n && n !== stop; n = n.parentNode) {
            if (n.nodeType === 1 && n.tagName === tag) return n;
        }
        return null;
    }

    function pathTo(root, node) {
        const path = [];
        for (let n = node; n && n !== root; n = n.parentNode) {
            if (!n.parentNode) return null;
            path.unshift(Array.prototype.indexOf.call(n.parentNode.childNodes, n));
        }
        return path;
    }

    function follow(root, path) {
        let n = root;
        for (const i of path) { n = n && n.childNodes[i]; }
        return n || null;
    }

    function insertMark(root, path, offset, mark) {
        const n = follow(root, path);
        if (!n) return false;
        if (n.nodeType === 3) n.data = n.data.slice(0, offset) + mark + n.data.slice(offset);
        else n.insertBefore(document.createTextNode(mark), n.childNodes[offset] || null);
        return true;
    }

    /** Adresse saisie pour un lien : https:// ajouté au besoin ; '' si refusée. */
    function normalizeUrl(raw) {
        const v = String(raw || '').trim();
        if (!v) return '';
        if (/^(?:javascript|data|vbscript):/i.test(v)) return '';
        if (/^(?:https?:|mailto:|tel:|#|\/)/i.test(v)) return v;
        if (/^[^\s@/]+@[^\s@/]+\.[a-z]{2,}$/i.test(v)) return 'mailto:' + v;
        return 'https://' + v;
    }

    /** Ouvre un lien du texte dans un nouvel onglet (adresses web et e-mail seulement). */
    function openUrl(href) {
        const url = String(href || '');
        if (!/^(?:https?:|mailto:)/i.test(url)) return;
        try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (e) { }
    }

    function cleanPastedHtml(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const body = doc.body;
        let images = body.querySelectorAll('img').length;
        // Google Docs : <b style="font-weight:normal"> autour de tout
        for (const b of Array.from(body.querySelectorAll('b, strong'))) {
            const w = (b.getAttribute('style') || '').match(/font-weight\s*:\s*(\w+)/i);
            if (w && /^(?:normal|[1-4]00)$/i.test(w[1])) b.replaceWith(...b.childNodes);
        }
        for (const el of Array.from(body.querySelectorAll('[style]'))) {
            const st = el.getAttribute('style') || '';
            const wrap = (tag) => { const w = doc.createElement(tag); while (el.firstChild) w.appendChild(el.firstChild); el.appendChild(w); };
            if (/font-weight\s*:\s*(?:bold|[6-9]00)/i.test(st) && !/^(?:B|STRONG|H\d|TH)$/.test(el.tagName)) wrap('strong');
            if (/font-style\s*:\s*italic/i.test(st) && !/^(?:I|EM)$/.test(el.tagName)) wrap('em');
            if (/text-decoration[^;]*line-through/i.test(st)) wrap('s');
        }
        const clean = DOMPurify.sanitize(body.innerHTML, { ALLOWED_TAGS: PASTE_TAGS, ALLOWED_ATTR: PASTE_ATTR });
        return { html: clean, images };
    }

    function plainTextToHtml(text) {
        return String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/)
            .map(p => '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>').join('');
    }

    // ---------- Import d'un document (canvas.js) ----------

    function inertRoot() {
        return new DOMParser().parseFromString('<div></div>', 'text/html').body.firstChild;
    }

    // Paragraphe qui commence par une puce tapée (« • », listes de TextEdit)
    const TYPED_BULLET_RE = /^[ \t\u00a0]*[•◦▪▫●○‣∙⁃][ \t\u00a0]+/;

    /* Document HTML importé : nettoyé comme un collage, sans nav/aside/footer ; puces tapées → liste */
    function htmlToMarkdown(html) {
        const src = new DOMParser().parseFromString(String(html || ''), 'text/html');
        const title = (src.title || '').replace(/\s+/g, ' ').trim();
        if (src.body) src.body.querySelectorAll('nav, aside, footer, form').forEach(el => el.remove());
        const c = cleanPastedHtml(src.body ? src.body.innerHTML : '');
        const root = inertRoot();
        root.innerHTML = c.html;
        const doc = root.ownerDocument;
        let list = null;
        for (const el of Array.from(root.querySelectorAll('p'))) {
            const first = el.firstChild;
            if (!first || first.nodeType !== 3 || !TYPED_BULLET_RE.test(first.data)) { list = null; continue; }
            if (!list || el.previousElementSibling !== list) {
                list = doc.createElement('ul');
                el.before(list);
            }
            first.data = first.data.replace(TYPED_BULLET_RE, '');
            const li = doc.createElement('li');
            while (el.firstChild) li.appendChild(el.firstChild);
            list.appendChild(li);
            el.remove();
        }
        return { text: serialize(root), title, images: c.images };
    }

    /* Blocs de texte brut (PDF) : [{ type: 'h1'|'h2'|'p'|'li', text }] ; « \n » = retour à la ligne */
    function blocksToMarkdown(blocks) {
        const root = inertRoot();
        const doc = root.ownerDocument;
        let list = null;
        for (const b of blocks || []) {
            const text = String(b && b.text || '').trim();
            if (!text) continue;
            const fill = el => text.split('\n').forEach((line, i) => {
                if (i) el.appendChild(doc.createElement('br'));
                el.appendChild(doc.createTextNode(line));
            });
            if (b.type === 'li') {
                if (!list) { list = doc.createElement('ul'); root.appendChild(list); }
                const li = doc.createElement('li');
                fill(li);
                list.appendChild(li);
                continue;
            }
            list = null;
            const el = doc.createElement(b.type === 'h1' || b.type === 'h2' ? b.type : 'p');
            fill(el);
            root.appendChild(el);
        }
        return serialize(root);
    }

    /* Monte la vue texte ; host : { root, page, scroller } ; hooks fournis par canvas.js */
    function createView(host, hooks) {
        const root = host.root, page = host.page, scroller = host.scroller;
        const v = {
            text: null,
            mode: 'edit',
            editable: false,
            layer: null,         // calque ouvert de la barre : 'menu' | 'link' | 'linkinfo' | 'ask'
            savedRange: null,    // sélection gardée pendant la saisie d'un lien ou d'une demande
            linkEl: null,
            askFocus: null,
            frame: 0,
            flashTimer: 0,
            revealTimer: 0,
            docked: false,
            dragInside: false,
            // Cmd+Z d'une action de la barre en plusieurs commandes natives : { n, before, after, undone }
            group: null,
            building: null,
            // Collage nettoyé hors pile native : { before, after, caretBefore, caretAfter, undone }
            domStep: null,
            replaying: false
        };
        try {
            document.execCommand('defaultParagraphSeparator', false, 'p');
            document.execCommand('styleWithCSS', false, false);
        } catch (e) { }

        // --- Barre de mise en forme ---
        const bar = document.createElement('div');
        bar.className = 'cdoc-toolbar';
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', 'Mise en forme du texte');
        bar.hidden = true;
        const btn = (cmd, label, icon, extra) => `<button type="button" class="cdoc-tb-btn" data-cmd="${cmd}" aria-label="${label}" title="${label}${extra ? ' (' + extra + ')' : ''}">${SVG(icon)}</button>`;
        bar.innerHTML =
            '<div class="cdoc-tb-main">' +
                `<button type="button" class="cdoc-tb-btn cdoc-tb-style" data-cmd="style" aria-haspopup="menu" aria-expanded="false" title="Style du paragraphe"><span>Style</span>${SVG(ICONS.chevron, 12)}</button>` +
                '<span class="cdoc-tb-sep" aria-hidden="true"></span>' +
                btn('bold', 'Gras', ICONS.bold, KEY + 'B') +
                btn('italic', 'Italique', ICONS.italic, KEY + 'I') +
                btn('strike', 'Barré', ICONS.strike, SHIFT_KEY + 'X') +
                btn('code', 'Code', ICONS.code) +
                btn('link', 'Lien', ICONS.link, KEY + 'K') +
                '<span class="cdoc-tb-sep cdoc-tb-sep-ask" aria-hidden="true"></span>' +
                `<button type="button" class="cdoc-tb-ask" data-cmd="ask">${SVG(ICONS.sparkles)}<span>Demander à l'IA</span></button>` +
            '</div>' +
            '<div class="cdoc-tb-menu" role="menu" hidden>' +
                BLOCK_STYLES.map(s => `<button type="button" class="cdoc-tb-menu-item cdoc-style-${s.block}" role="menuitem" data-block="${s.block}">${s.label}</button>`).join('') +
            '</div>' +
            '<div class="cdoc-tb-link" hidden>' +
                '<input type="text" class="cdoc-tb-input cdoc-link-input" placeholder="Adresse du lien (https://…)" aria-label="Adresse du lien" spellcheck="false" autocomplete="off" autocapitalize="off">' +
                `<button type="button" class="cdoc-tb-btn" data-cmd="link-ok" aria-label="Valider le lien" title="Valider (Entrée)">${SVG(ICONS.check)}</button>` +
            '</div>' +
            '<div class="cdoc-tb-linkinfo" hidden>' +
                '<span class="cdoc-tb-url"></span>' +
                '<button type="button" class="cdoc-tb-text" data-cmd="link-open">Ouvrir</button>' +
                '<button type="button" class="cdoc-tb-text" data-cmd="link-edit">Modifier</button>' +
                '<button type="button" class="cdoc-tb-text" data-cmd="link-remove">Retirer le lien</button>' +
            '</div>' +
            '<div class="cdoc-tb-askpanel" hidden>' +
                '<div class="cdoc-tb-askrow">' +
                    '<input type="text" class="cdoc-tb-input cdoc-ask-input" placeholder="Une modification, une question ?" aria-label="Modification à faire ou question sur ce passage" autocomplete="off">' +
                    `<button type="button" class="cdoc-tb-btn cdoc-ask-send" data-cmd="ask-send" aria-label="Envoyer la demande" title="Envoyer (Entrée)">${SVG(ICONS.send)}</button>` +
                '</div>' +
                '<div class="cdoc-tb-chips">' +
                    ASK_CHIPS.map((c, i) => `<button type="button" class="cdoc-tb-chip" data-chip="${i}" title="${escapeHtml(c.text)}">${c.label}</button>`).join('') +
                '</div>' +
            '</div>';
        root.appendChild(bar);
        const q = sel => bar.querySelector(sel);
        const els = {
            main: q('.cdoc-tb-main'), menu: q('.cdoc-tb-menu'), style: q('.cdoc-tb-style'),
            link: q('.cdoc-tb-link'), linkInput: q('.cdoc-link-input'), linkInfo: q('.cdoc-tb-linkinfo'), url: q('.cdoc-tb-url'),
            ask: q('.cdoc-tb-askpanel'), askInput: q('.cdoc-ask-input'), askBtn: q('.cdoc-tb-ask')
        };

        // Écran tactile : barre fixe en haut de la vue texte, toujours visible
        const coarseMq = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;
        function applyDocked() {
            v.docked = !!(coarseMq && coarseMq.matches);
            bar.classList.toggle('is-docked', v.docked);
            if (v.docked) root.insertBefore(bar, scroller);
            else root.appendChild(bar);
            bar.style.left = bar.style.top = '';
            schedule();
        }
        if (coarseMq) {
            if (typeof coarseMq.addEventListener === 'function') coarseMq.addEventListener('change', applyDocked);
            else if (typeof coarseMq.addListener === 'function') coarseMq.addListener(applyDocked);
        }

        // --- Sélection ---

        function currentRange() {
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) return null;
            const r = sel.getRangeAt(0);
            return page.contains(r.commonAncestorContainer) ? r : null;
        }

        function selectRange(r) {
            if (!r) return;
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(r);
        }

        function restoreSelection() {
            if (document.activeElement !== page) page.focus({ preventScroll: true });
            if (v.savedRange) selectRange(v.savedRange);
        }

        function expandRange(r) {
            const sc = r.startContainer, ec = r.endContainer;
            if (sc.nodeType === 3) {
                let o = r.startOffset;
                const t = sc.data;
                while (o < t.length && /\s/.test(t[o]) && !(sc === ec && o >= r.endOffset)) o++;
                while (o > 0 && isWordChar(t[o - 1]) && isWordChar(t[o])) o--;
                r.setStart(sc, o);
            }
            if (ec.nodeType === 3) {
                let o = r.endOffset;
                const t = ec.data;
                while (o > 0 && /\s/.test(t[o - 1]) && !(ec === r.startContainer && o <= r.startOffset)) o--;
                while (o < t.length && isWordChar(t[o - 1]) && isWordChar(t[o])) o++;
                r.setEnd(ec, o);
            }
            for (let n = r.startContainer; n && n !== page; n = n.parentNode) {
                if (n.nodeType === 1 && INLINE_FMT.has(n.tagName) && !n.contains(r.endContainer)) r.setStartBefore(n);
            }
            for (let n = r.endContainer; n && n !== page; n = n.parentNode) {
                if (n.nodeType === 1 && INLINE_FMT.has(n.tagName) && !n.contains(r.startContainer)) r.setEndAfter(n);
            }
            return r;
        }

        /* Passage de la sélection dans le texte enregistré ; texte d'abord remis sous forme canonique sans nouvelle version */
        function computeFocus(r) {
            const s0 = serialize(page);
            if (s0 !== hooks.getText()) {
                v.text = s0;
                hooks.normalizeText(s0);
            }
            const ps = pathTo(page, r.startContainer), pe = pathTo(page, r.endContainer);
            if (!ps || !pe) return null;
            const copy = page.cloneNode(true);
            insertMark(copy, pe, r.endOffset, MARK_B);
            insertMark(copy, ps, r.startOffset, MARK_A);
            const s1 = serialize(copy);
            const a = s1.indexOf(MARK_A), b = s1.indexOf(MARK_B);
            if (a < 0 || b < a) return null;
            let start = a, end = b - 1;
            const clean = s1.replace(MARKS_RE, '');
            if (clean !== s0) {
                // Garde-fou : le passage est cherché dans le texte, au plus près
                const piece = s1.slice(a + 1, b).replace(MARKS_RE, '');
                let best = -1;
                for (let i = s0.indexOf(piece); i >= 0 && piece; i = s0.indexOf(piece, i + 1)) {
                    if (best < 0 || Math.abs(i - a) < Math.abs(best - a)) best = i;
                }
                if (best < 0) return null;
                start = best;
                end = best + piece.length;
            }
            while (start < end && /\s/.test(s0[start])) start++;
            while (end > start && /\s/.test(s0[end - 1])) end--;
            if (end <= start) return null;
            return { start, end, excerpt: s0.slice(start, end) };
        }

        // --- Surlignages (API CSS Custom Highlight : le DOM n'est pas touché) ---

        function setHighlight(name, r) {
            if (!canHighlight()) return;
            try { CSS.highlights.set(name, new Highlight(r)); } catch (e) { }
        }
        function clearHighlight(name) {
            if (canHighlight()) CSS.highlights.delete(name);
        }

        // --- Rendu ---

        function updateEmpty() {
            page.classList.toggle('is-empty', v.mode === 'edit' && !v.text);
        }

        /* Rendu refait seulement si le texte a changé (ou force) : jamais pendant la frappe */
        function setText(md, force) {
            md = String(md || '');
            // Rendu refait aussi si DOMPurify est arrivé ou reparti entre-temps
            const raw = !canRender();
            if (v.mode === 'edit' && v.text === md && v.raw === raw && !force) return false;
            const keep = v.mode === 'edit' && v.text != null ? scroller.scrollTop : null;
            // Écriture de l'IA suivie jusqu'en bas : le texte fini se relit depuis le début
            const followed = v.mode === 'stream' && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
            v.mode = 'edit';
            v.text = md;
            v.raw = raw;
            page.innerHTML = md ? renderHtml(md) : '<p><br></p>';
            prepareEditable();
            clearHighlight(HIGHLIGHT_FOCUS);
            clearHighlight(HIGHLIGHT_REVEAL);
            updateEmpty();
            if (keep != null) scroller.scrollTop = keep;
            else if (followed) scroller.scrollTop = 0;
            hide();
            return true;
        }

        function prepareEditable() {
            for (const box of page.querySelectorAll('input[type="checkbox"]')) {
                if (v.editable) box.removeAttribute('disabled');
                else box.setAttribute('disabled', '');
            }
        }

        function setEditable(on) {
            on = !!on && v.mode === 'edit' && canRender();
            const was = v.editable;
            v.editable = on;
            page.contentEditable = on ? 'true' : 'false';
            page.classList.toggle('is-editable', on);
            if (on) {
                page.setAttribute('role', 'textbox');
                page.setAttribute('aria-multiline', 'true');
            } else {
                page.removeAttribute('role');
                page.removeAttribute('aria-multiline');
            }
            prepareEditable();
            if (on && !was) clearHighlight(HIGHLIGHT_FOCUS);
            if (!on) { closeLayer(true); hide(); }
            schedule();
        }

        /* La vue ne suit le bas pendant l'écriture que si l'on y était déjà */
        function setStreaming(md) {
            const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
            v.mode = 'stream';
            v.text = null;
            v.editable = false;
            page.contentEditable = 'false';
            page.classList.remove('is-editable', 'is-empty');
            page.innerHTML = renderHtml(md);
            if (atBottom) scroller.scrollTop = scroller.scrollHeight;
            closeLayer(true);
            hide();
        }

        /** Modifications par rapport à `oldMd` : blocs retirés (rouge, barrés)
         *  et ajoutés (vert). Lecture seule. */
        function showDiff(oldMd, newMd) {
            v.mode = 'diff';
            v.text = null;
            v.editable = false;
            page.contentEditable = 'false';
            page.classList.remove('is-editable', 'is-empty');
            closeLayer(true);
            hide();
            const A = renderBlocks(oldMd || ''), B = renderBlocks(newMd || '');
            const d = blockDiff(A.map(x => x.key), B.map(x => x.key), hooks.lineDiff);
            page.textContent = '';
            if (!d) { page.innerHTML = renderHtml(newMd); return; }
            for (const e of d) {
                const el = e.type === 'removed' ? A[e.a].el : B[e.b].el;
                if (e.type === 'added') el.classList.add('cdoc-added');
                else if (e.type === 'removed') el.classList.add('cdoc-removed');
                page.appendChild(el);
            }
        }

        function flashChanges(oldMd, newMd) {
            if (v.mode !== 'edit' || v.text !== newMd) return 0;
            const A = renderBlocks(oldMd || ''), B = renderBlocks(newMd || '');
            const d = blockDiff(A.map(x => x.key), B.map(x => x.key), hooks.lineDiff);
            if (!d) return 0;
            const kids = page.children;
            const changed = d.filter(e => e.type === 'added').map(e => kids[e.b]).filter(Boolean);
            if (!changed.length) return 0;
            for (const el of page.querySelectorAll('.cdoc-flash')) el.classList.remove('cdoc-flash');
            for (const el of changed) el.classList.add('cdoc-flash');
            clearTimeout(v.flashTimer);
            v.flashTimer = setTimeout(() => {
                for (const el of page.querySelectorAll('.cdoc-flash')) el.classList.remove('cdoc-flash');
            }, FLASH_MS);
            const first = changed[0];
            const fr = first.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
            if (fr.bottom < sr.top || fr.top > sr.bottom) scroller.scrollTop += fr.top - sr.top - 24;
            return changed.length;
        }

        /* Plage DOM de [start, end[ : texte rendu avec des marqueurs aux bornes, dans une copie de même structure */
        function rangeFromSource(start, end) {
            const text = v.text || '';
            // Pas de marqueur au milieu d'une syntaxe de début de ligne (# , > , - …)
            const ls = text.lastIndexOf('\n', start - 1) + 1;
            const pre = /^(?:[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+))+/.exec(text.slice(ls));
            if (pre && start < ls + pre[0].length) start = Math.min(end, ls + pre[0].length);
            const el = renderElement(text.slice(0, start) + MARK_A + text.slice(start, end) + MARK_B + text.slice(end));
            const found = {};
            const walk = (node) => {
                for (const n of node.childNodes) {
                    if (n.nodeType === 3) {
                        const ia = n.data.indexOf(MARK_A), ib = n.data.indexOf(MARK_B);
                        if (ia >= 0) found.a = { path: pathTo(el, n), offset: ia, data: n.data };
                        if (ib >= 0) found.b = { path: pathTo(el, n), offset: ib, data: n.data };
                    } else walk(n);
                }
            };
            walk(el);
            if (!found.a || !found.b) return null;
            const na = follow(page, found.a.path), nb = follow(page, found.b.path);
            if (!na || !nb || na.nodeType !== 3 || nb.nodeType !== 3) return null;
            if (na.data !== found.a.data.replace(MARKS_RE, '') || nb.data !== found.b.data.replace(MARKS_RE, '')) return null;
            const oa = found.a.offset;
            const ob = found.b.offset - (na === nb && found.b.data.indexOf(MARK_A) >= 0 && found.b.data.indexOf(MARK_A) < found.b.offset ? 1 : 0);
            const r = document.createRange();
            r.setStart(na, Math.min(oa, na.data.length));
            r.setEnd(nb, Math.min(ob, nb.data.length));
            return r;
        }

        /** Montre un passage du texte (citation d'une demande cliquée dans la
         *  discussion) : surligné quelques secondes s'il existe encore. */
        function revealFocus(focus) {
            if (!focus || typeof focus.excerpt !== 'string' || v.mode !== 'edit' || !v.text) return false;
            const text = v.text;
            let start = Number(focus.start), end = Number(focus.end);
            if (!(Number.isFinite(start) && text.slice(start, end) === focus.excerpt)) {
                start = -1;
                for (let i = text.indexOf(focus.excerpt); i >= 0; i = text.indexOf(focus.excerpt, i + 1)) {
                    if (start < 0 || Math.abs(i - focus.start) < Math.abs(start - focus.start)) start = i;
                }
                if (start < 0) return false;
                end = start + focus.excerpt.length;
            }
            const r = rangeFromSource(start, end);
            clearTimeout(v.revealTimer);
            if (r) {
                setHighlight(HIGHLIGHT_REVEAL, r);
                const box = r.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
                if (box.top < sr.top + 8 || box.bottom > sr.bottom - 8) scroller.scrollTop += box.top - sr.top - sr.height / 3;
                v.revealTimer = setTimeout(() => clearHighlight(HIGHLIGHT_REVEAL), FLASH_MS);
                return true;
            }
            // Repli : le bloc qui contient le début du passage
            const head = plainExcerpt(focus.excerpt).slice(0, 40);
            const block = Array.from(page.children).find(b => head && b.textContent.replace(/\s+/g, ' ').includes(head));
            if (!block) return false;
            block.scrollIntoView({ block: 'center' });
            block.classList.add('cdoc-flash');
            v.revealTimer = setTimeout(() => block.classList.remove('cdoc-flash'), FLASH_MS);
            return true;
        }

        // --- Frappe ---

        function onInput() {
            if (v.mode !== 'edit' || !v.editable) return;
            const md = serialize(page);
            const was = v.text;
            v.text = md;
            updateEmpty();
            if (md !== was) hooks.onEdit(md);
            schedule();
        }

        page.addEventListener('beforeinput', (e) => {
            if (!v.editable) { e.preventDefault(); return; }
            if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') replayHistory(e);
        });
        page.addEventListener('input', (e) => {
            if (!v.building && !v.replaying && !/^history/.test(e.inputType || '')) { v.group = null; v.domStep = null; }
            onInput();
        });

        /* Cmd+Z après une action groupée de la barre : tout défait d'un coup ; après un collage nettoyé : texte d'avant */
        function replayHistory(e) {
            const undo = e.inputType === 'historyUndo';
            const g = v.group;
            if (g && g.undone === !undo && v.text === (undo ? g.after : g.before)) {
                e.preventDefault();
                g.undone = undo;
                v.replaying = true;
                setTimeout(() => {
                    try { for (let i = 0; i < g.n; i++) document.execCommand(undo ? 'undo' : 'redo'); }
                    catch (err) { }
                    v.replaying = false;
                    onInput();
                }, 0);
                return;
            }
            const d = v.domStep;
            if (d && d.undone === !undo && v.text === (undo ? d.after : d.before)) {
                e.preventDefault();
                d.undone = undo;
                const md = undo ? d.before : d.after;
                setText(md, true);
                hooks.onEdit(md);
                placeCaret(undo ? d.caretBefore : d.caretAfter);
                schedule();
            }
        }

        function caretOffset() {
            const r = currentRange();
            if (!r) return null;
            const pre = document.createRange();
            pre.selectNodeContents(page);
            try { pre.setEnd(r.endContainer, r.endOffset); } catch (err) { return null; }
            return pre.toString().length;
        }
        function placeCaret(offset) {
            if (offset == null || !v.editable) return;
            page.focus({ preventScroll: true });
            const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
            let left = offset, node, last = null;
            while ((node = walker.nextNode())) {
                last = node;
                if (left <= node.data.length) break;
                left -= node.data.length;
            }
            const r = document.createRange();
            if (node) r.setStart(node, Math.min(left, node.data.length));
            else if (last) r.setStart(last, last.data.length);
            else r.selectNodeContents(page);
            r.collapse(true);
            selectRange(r);
        }

        /* Chrome ajoute des <span> et styles en ligne au collage ; retirés hors pile native (Cmd+Z : voir replayHistory) */
        function cleanInserted(before, caretBefore) {
            let changed = false;
            for (const el of Array.from(page.querySelectorAll('[style]'))) { el.removeAttribute('style'); changed = true; }
            for (const el of Array.from(page.querySelectorAll('span, font'))) {
                if (el.tagName === 'SPAN' && el.attributes.length) continue;
                const r = currentRange();
                const keep = r && el.contains(r.endContainer) ? { node: r.endContainer, offset: r.endOffset } : null;
                el.replaceWith(...el.childNodes);
                if (keep && page.contains(keep.node)) { const nr = document.createRange(); nr.setStart(keep.node, keep.offset); nr.collapse(true); selectRange(nr); }
                changed = true;
            }
            onInput();
            v.group = null;
            v.domStep = changed ? { before, after: v.text, caretBefore, caretAfter: caretOffset(), undone: false } : null;
        }
        page.addEventListener('change', onInput);
        page.addEventListener('blur', () => { if (typeof hooks.onBlur === 'function') hooks.onBlur(); });
        page.addEventListener('mousedown', () => {
            if (!v.editable && v.mode === 'edit' && typeof hooks.onReadOnlyClick === 'function') hooks.onReadOnlyClick();
        });

        // Liens : jamais suivis pendant la modification (Cmd/Ctrl+clic : nouvel onglet)
        page.addEventListener('click', (e) => {
            const a = e.target && e.target.closest ? e.target.closest('a') : null;
            if (!a || !page.contains(a)) return;
            e.preventDefault();
            if (e.metaKey || e.ctrlKey || !v.editable) openUrl(a.getAttribute('href'));
        });

        page.addEventListener('paste', (e) => {
            if (!v.editable) { e.preventDefault(); return; }
            const dt = e.clipboardData;
            if (!dt) return;
            const html = dt.getData('text/html');
            const text = dt.getData('text/plain');
            const hasFile = Array.from(dt.items || []).some(it => it.kind === 'file');
            e.preventDefault();
            if (!html && !text) {
                if (hasFile && hooks.flash) hooks.flash('Le Canvas ne contient que du texte : image non collée', true);
                return;
            }
            const before = v.text, caretBefore = caretOffset();
            if (html && typeof DOMPurify !== 'undefined') {
                const c = cleanPastedHtml(html);
                if (c.images && hooks.flash) hooks.flash('Images non collées : le Canvas ne contient que du texte', true);
                if (c.html.trim()) document.execCommand('insertHTML', false, c.html);
            } else if (/\n/.test(text)) {
                document.execCommand('insertHTML', false, plainTextToHtml(text));
            } else {
                document.execCommand('insertText', false, text);
            }
            cleanInserted(before, caretBefore);
        });

        page.addEventListener('dragstart', () => { v.dragInside = true; });
        page.addEventListener('dragend', () => { v.dragInside = false; });
        page.addEventListener('drop', (e) => {
            const dt = e.dataTransfer;
            if (!dt || Array.from(dt.types || []).includes('Files')) return; // fichiers : import (volet)
            if (!v.editable) { e.preventDefault(); return; }
            if (v.dragInside) return;
            const html = dt.getData('text/html');
            const text = dt.getData('text/plain');
            e.preventDefault();
            const at = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
            if (at && page.contains(at.startContainer)) { page.focus({ preventScroll: true }); selectRange(at); }
            const before = v.text, caretBefore = caretOffset();
            if (html && typeof DOMPurify !== 'undefined') {
                const c = cleanPastedHtml(html);
                if (c.html.trim()) document.execCommand('insertHTML', false, c.html);
            } else if (text) {
                document.execCommand('insertText', false, text);
            }
            cleanInserted(before, caretBefore);
        });

        page.addEventListener('keydown', (e) => {
            if (e.isComposing || e.keyCode === 229) {
                // Échap pendant une composition (touche morte, IME) l'annule seulement, sans atteindre le volet
                if (e.key === 'Escape') e.stopPropagation();
                return;
            }
            if (e.key === 'Escape') {
                // Boîte de dialogue ouverte par-dessus : Échap n'est pas pour le texte
                if (typeof hooks.modalOpen === 'function' && hooks.modalOpen()) return;
                // Jamais la fermeture du volet : d'abord le calque, puis la sélection, puis la zone
                e.preventDefault();
                e.stopPropagation();
                if (closeLayer()) return;
                const sel = window.getSelection();
                if (sel && sel.rangeCount && !sel.isCollapsed && currentRange()) { sel.collapseToEnd(); hide(); return; }
                page.blur();
                return;
            }
            const mod = e.metaKey || e.ctrlKey;
            if (!v.editable) return;
            if (mod && !e.altKey) {
                const k = e.key.toLowerCase();
                // Rétablir un collage annulé : la pile native est vide, Chrome n'émettrait rien
                if (((k === 'z' && e.shiftKey) || (k === 'y' && !e.shiftKey)) && v.domStep && v.domStep.undone && v.text === v.domStep.before) {
                    e.preventDefault();
                    replayHistory({ inputType: 'historyRedo', preventDefault() {} });
                    return;
                }
                if (k === 's' && !e.shiftKey) { e.preventDefault(); if (hooks.save) hooks.save(); return; }
                if (k === 'b' && !e.shiftKey) { e.preventDefault(); command('bold'); return; }
                if (k === 'i' && !e.shiftKey) { e.preventDefault(); command('italic'); return; }
                if (k === 'u' && !e.shiftKey) { e.preventDefault(); return; } // pas de souligné en Markdown
                if (k === 'k' && !e.shiftKey) { e.preventDefault(); command('link'); return; }
                if (k === 'x' && e.shiftKey) { e.preventDefault(); command('strike'); return; }
            }
            if (e.key === 'Tab' && !mod && !e.altKey) {
                const r = currentRange();
                if (r && closestIn(r.startContainer, 'LI', page)) {
                    e.preventDefault();
                    document.execCommand(e.shiftKey ? 'outdent' : 'indent');
                    onInput();
                }
            }
        });

        // --- Commandes de la barre ---

        function used() {
            if (typeof hooks.onToolbarUsed === 'function') hooks.onToolbarUsed();
        }

        // Commandes par execCommand pour entrer dans la pile d'annulation native ; regroupées par grouped
        function exec(cmd, val) {
            // Sélection gardée (champ du lien…) remise seulement si le texte l'a perdue
            if (document.activeElement !== page || !currentRange()) restoreSelection();
            const was = v.building ? page.innerHTML : null;
            try { document.execCommand(cmd, false, val); } catch (e) { }
            if (v.building && page.innerHTML !== was) v.building.n++;
            onInput();
        }

        function grouped(fn) {
            const before = v.text;
            v.building = { n: 0 };
            try { fn(); } finally {
                const n = v.building.n;
                v.building = null;
                v.domStep = null;
                v.group = n > 1 ? { n, before, after: v.text, undone: false } : null;
            }
        }

        function toggleCode() {
            const r = currentRange();
            if (!r) return;
            const code = closestIn(r.commonAncestorContainer, 'CODE', page);
            if (code) {
                // Retiré par une commande native (annulable), sur tout le code
                const nr = document.createRange();
                nr.selectNodeContents(code);
                selectRange(nr);
                exec('removeFormat');
                return;
            }
            const text = r.toString();
            if (!text.trim()) return;
            exec('insertHTML', '<code>' + escapeHtml(text.replace(/\n+/g, ' ')) + '</code>');
        }

        /* DOM jamais modifié à la main, pour Cmd+Z ; un <p><ul> de Chrome est lu comme conteneur puis remis en place */
        function applyBlock(block) {
            restoreSelection();
            const r = currentRange();
            if (!r) return;
            grouped(() => {
                const li = closestIn(r.startContainer, 'LI', page);
                const listTag = li && li.parentElement ? li.parentElement.tagName : '';
                if (block === 'ul' || block === 'ol') {
                    // Liste de l'autre type : tous ses éléments sélectionnés, changée en une seule commande
                    const want = block === 'ul' ? 'UL' : 'OL';
                    if (li && listTag && listTag !== want) {
                        const items = Array.from(li.parentElement.children).filter(c => c.tagName === 'LI');
                        const all = document.createRange();
                        all.setStart(items[0], 0);
                        all.setEnd(items[items.length - 1], items[items.length - 1].childNodes.length);
                        selectRange(all);
                    } else if (!li && ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].some(t => closestIn(r.startContainer, t, page))) {
                        // Un titre devient d'abord un paragraphe (sinon la liste est créée dedans)
                        exec('formatBlock', '<p>');
                    }
                    exec(block === 'ul' ? 'insertUnorderedList' : 'insertOrderedList');
                    return;
                }
                if (li) exec(listTag === 'OL' ? 'insertOrderedList' : 'insertUnorderedList');
                const quote = closestIn((currentRange() || r).startContainer, 'BLOCKQUOTE', page);
                if (quote && block !== 'blockquote') exec('outdent');
                const cur = closestIn((currentRange() || r).startContainer, block.toUpperCase(), page);
                if (!cur || block === 'blockquote') exec('formatBlock', '<' + block + '>');
            });
        }

        function command(cmd) {
            if (!v.editable) return;
            used();
            switch (cmd) {
                case 'bold': exec('bold'); break;
                case 'italic': exec('italic'); break;
                case 'strike': exec('strikeThrough'); break;
                case 'code': toggleCode(); break;
                case 'link': openLinkEditor(); return;
                default: return;
            }
            schedule();
        }

        // --- Lien en ligne ---

        function openLinkEditor() {
            const r = currentRange() || v.savedRange;
            if (!r) return;
            const a = closestIn(r.startContainer, 'A', page);
            v.linkEl = a;
            v.savedRange = r.cloneRange();
            els.linkInput.value = a ? a.getAttribute('href') || '' : '';
            setLayer('link');
            els.linkInput.focus();
            els.linkInput.select();
        }

        function applyLink() {
            const raw = els.linkInput.value;
            const url = normalizeUrl(raw);
            if (raw.trim() && !url) { els.linkInput.classList.add('is-invalid'); return; }
            els.linkInput.classList.remove('is-invalid');
            const a = v.linkEl && page.contains(v.linkEl) ? v.linkEl : null;
            setLayer(null);
            restoreSelection();
            v.savedRange = null;
            if (a) {
                const r = document.createRange();
                r.selectNodeContents(a);
                selectRange(r);
            }
            if (!url) { if (a) exec('unlink'); }
            else {
                const r = currentRange();
                if (r && r.collapsed && !a) exec('insertHTML', '<a href="' + escapeHtml(url) + '">' + escapeHtml(raw.trim()) + '</a>');
                else exec('createLink', url);
            }
            v.linkEl = null;
            v.savedRange = null;
            schedule();
        }

        // --- Demander à l'IA ---

        function askReason() {
            const why = typeof hooks.askBlocker === 'function' ? hooks.askBlocker() : '';
            if (why) return why;
            const r = currentRange();
            if (v.layer !== 'ask' && (!r || r.collapsed)) return 'Sélectionnez d\'abord un passage';
            return '';
        }

        function openAsk() {
            const why = askReason();
            if (why) { if (hooks.flash) hooks.flash(why, true); schedule(); return; }
            const r = currentRange();
            if (!r || r.collapsed) return;
            const range = expandRange(r.cloneRange());
            const focus = computeFocus(range);
            if (!focus) { if (hooks.flash) hooks.flash('Impossible de repérer ce passage dans le texte', true); return; }
            used();
            v.askFocus = focus;
            v.savedRange = range;
            selectRange(range);
            setHighlight(HIGHLIGHT_FOCUS, range);
            els.askInput.value = '';
            setLayer('ask');
            els.askInput.focus();
        }

        function submitAsk(instruction) {
            const text = String(instruction || '').trim();
            if (!text || !v.askFocus) { els.askInput.focus(); return; }
            const why = typeof hooks.askBlocker === 'function' ? hooks.askBlocker() : '';
            if (why) { if (hooks.flash) hooks.flash(why, true); return; }
            const focus = v.askFocus, range = v.savedRange, shown = v.text;
            // Barre fermée avant l'envoi (qui rend le texte non modifiable) ; le passage reste surligné
            v.askFocus = null;
            v.savedRange = null;
            setLayer(null);
            const sel = window.getSelection();
            if (sel) sel.removeAllRanges();
            hide();
            const reopen = () => {
                v.askFocus = focus;
                v.savedRange = range;
                els.askInput.value = text;
                setLayer('ask');
                els.askInput.focus();
            };
            // Garde-fou annulé : la demande se rouvre si le texte n'a pas bougé, sinon le surlignage est retiré
            const onCancel = () => {
                if (v.layer === 'ask' && v.askFocus === focus) return;
                if (v.mode === 'edit' && v.editable && !v.layer && v.text === shown && range && page.contains(range.commonAncestorContainer)) {
                    selectRange(range);
                    setHighlight(HIGHLIGHT_FOCUS, range);
                    reopen();
                } else clearHighlight(HIGHLIGHT_FOCUS);
            };
            if (!hooks.sendAsk(text, focus, onCancel)) {
                reopen();
                return;
            }
            if (range) setHighlight(HIGHLIGHT_FOCUS, range);
        }

        // --- Calques de la barre ---

        function setLayer(name) {
            v.layer = name;
            bar.dataset.layer = name || '';
            els.menu.hidden = name !== 'menu';
            els.style.setAttribute('aria-expanded', String(name === 'menu'));
            els.main.hidden = name === 'link' || name === 'linkinfo' || name === 'ask';
            els.link.hidden = name !== 'link';
            els.linkInfo.hidden = name !== 'linkinfo';
            els.ask.hidden = name !== 'ask';
            if (name) bar.hidden = false;
            position();
        }

        /** Ferme le calque ouvert de la barre (Échap) : true s'il y en avait un. */
        function closeLayer(silent) {
            if (!v.layer) return false;
            const was = v.layer;
            if (was === 'ask') { v.askFocus = null; clearHighlight(HIGHLIGHT_FOCUS); }
            setLayer(null);
            if (!silent && (was === 'link' || was === 'ask') && v.savedRange && v.editable) restoreSelection();
            v.savedRange = null;
            v.linkEl = null;
            if (!silent) schedule();
            return true;
        }

        function hide() {
            if (v.layer) return;
            if (v.docked && v.mode === 'edit' && v.editable) { bar.hidden = false; updateStates(null); return; }
            bar.hidden = true;
        }

        function updateStates(r) {
            const has = !!(r && !r.collapsed);
            const state = (cmd) => { try { return document.queryCommandState(cmd); } catch (e) { return false; } };
            const set = (cmd, on) => {
                const b = bar.querySelector(`[data-cmd="${cmd}"]`);
                if (!b) return;
                b.classList.toggle('is-active', !!on);
                b.setAttribute('aria-pressed', String(!!on));
            };
            set('bold', has && state('bold'));
            set('italic', has && state('italic'));
            set('strike', has && state('strikeThrough'));
            set('code', has && !!closestIn(r.commonAncestorContainer, 'CODE', page));
            set('link', !!(r && closestIn(r.startContainer, 'A', page)));
            for (const b of bar.querySelectorAll('.cdoc-tb-main .cdoc-tb-btn')) {
                b.disabled = !v.editable || (v.docked && !has);
            }
            // « Demander à l'IA » : désactivé avec sa raison
            const why = askReason();
            els.askBtn.classList.toggle('is-disabled', !!why || !v.editable);
            els.askBtn.setAttribute('aria-disabled', String(!!why || !v.editable));
            els.askBtn.title = why || 'Demander une retouche de ce passage à l\'IA';
            let cur = 'p';
            if (r) {
                const li = closestIn(r.startContainer, 'LI', page);
                const h = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].map(t => closestIn(r.startContainer, t, page)).find(Boolean);
                if (li) cur = li.parentElement && li.parentElement.tagName === 'OL' ? 'ol' : 'ul';
                else if (h) cur = h.tagName.toLowerCase();
                else if (closestIn(r.startContainer, 'BLOCKQUOTE', page)) cur = 'blockquote';
            }
            for (const it of els.menu.querySelectorAll('[data-block]')) {
                it.classList.toggle('is-current', it.dataset.block === cur);
                it.setAttribute('aria-checked', String(it.dataset.block === cur));
            }
        }

        function position(r) {
            if (v.docked || bar.hidden) return;
            const range = r || (v.layer && v.savedRange) || currentRange() || v.savedRange;
            if (!range) return;
            let rect = range.getBoundingClientRect();
            if (!rect.width && !rect.height) {
                const rects = range.getClientRects();
                if (rects.length) rect = rects[0];
                else if (range.startContainer.nodeType === 1) rect = range.startContainer.getBoundingClientRect();
            }
            const box = root.getBoundingClientRect();
            const area = scroller.getBoundingClientRect();
            // Jamais plus large que la vue, marges comprises (la barre passe à la ligne)
            bar.style.maxWidth = Math.max(160, Math.floor(box.width - 16)) + 'px';
            const w = bar.offsetWidth, h = bar.offsetHeight;
            let left = rect.left + rect.width / 2 - w / 2 - box.left;
            left = Math.max(8, Math.min(left, box.width - w - 8));
            let top = rect.top - box.top - h - 8;
            if (rect.top - h - 8 < area.top + 4) top = rect.bottom - box.top + 8;
            top = Math.max(area.top - box.top + 4, Math.min(top, area.bottom - box.top - h - 4));
            bar.style.left = Math.round(left) + 'px';
            bar.style.top = Math.round(top) + 'px';
            // Menu des styles vers le haut quand il dépasserait le bas de la vue (listes coupées)
            if (!els.menu.hidden) {
                const need = els.menu.offsetHeight + 4;
                const below = area.bottom - (box.top + top + h);
                els.menu.classList.toggle('is-up', below < need && box.top + top - area.top > below);
            }
        }

        function refresh() {
            v.frame = 0;
            if (v.layer === 'link' || v.layer === 'ask') { position(); return; }
            const r = currentRange();
            if (v.mode !== 'edit' || !v.editable) { if (v.layer) closeLayer(true); bar.hidden = true; return; }
            if (!r) {
                // La barre garde son menu ouvert le temps d'un clic dedans
                if (v.layer === 'menu' && bar.contains(document.activeElement)) return;
                if (v.layer) closeLayer(true);
                hide();
                return;
            }
            const a = closestIn(r.startContainer, 'A', page);
            if (r.collapsed && a && !v.docked) {
                v.linkEl = a;
                els.url.textContent = a.getAttribute('href') || '';
                els.url.title = a.getAttribute('href') || '';
                setLayer('linkinfo');
                position(r);
                return;
            }
            if (v.layer === 'linkinfo') setLayer(null);
            if (r.collapsed && !v.docked) { if (v.layer) closeLayer(true); hide(); return; }
            bar.hidden = false;
            updateStates(r);
            position(r);
        }

        function schedule() {
            if (v.frame) return;
            v.frame = requestAnimationFrame(refresh);
        }

        document.addEventListener('selectionchange', () => {
            if (v.layer === 'link' || v.layer === 'ask') return;
            schedule();
        });
        scroller.addEventListener('scroll', () => { if (!bar.hidden && !v.docked) position(); }, { passive: true });
        window.addEventListener('resize', () => { if (!bar.hidden) position(); });

        // Clics dans la barre : la sélection reste dans le texte
        bar.addEventListener('mousedown', (e) => {
            if (e.target.closest('input')) return;
            e.preventDefault();
        });
        bar.addEventListener('click', (e) => {
            const chip = e.target.closest('[data-chip]');
            if (chip) { submitAsk(ASK_CHIPS[Number(chip.dataset.chip)].text); return; }
            const item = e.target.closest('[data-block]');
            if (item) { used(); setLayer(null); applyBlock(item.dataset.block); schedule(); return; }
            const b = e.target.closest('[data-cmd]');
            if (!b || b.disabled) return;
            const cmd = b.dataset.cmd;
            if (cmd === 'style') { setLayer(v.layer === 'menu' ? null : 'menu'); updateStates(currentRange()); return; }
            if (cmd === 'ask') { openAsk(); return; }
            if (cmd === 'ask-send') { submitAsk(els.askInput.value); return; }
            if (cmd === 'link-ok') { applyLink(); return; }
            if (cmd === 'link-open') { if (v.linkEl) openUrl(v.linkEl.getAttribute('href')); return; }
            if (cmd === 'link-edit') { openLinkEditor(); return; }
            if (cmd === 'link-remove') {
                const a = v.linkEl;
                setLayer(null);
                if (a && page.contains(a)) {
                    const r = document.createRange();
                    r.selectNodeContents(a);
                    page.focus({ preventScroll: true });
                    selectRange(r);
                    exec('unlink');
                }
                schedule();
                return;
            }
            command(cmd);
        });
        bar.addEventListener('keydown', (e) => {
            if (e.isComposing || e.keyCode === 229) {
                if (e.key === 'Escape') e.stopPropagation();
                return;
            }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLayer(); return; }
            if (e.key !== 'Enter') return;
            if (e.target === els.linkInput) { e.preventDefault(); applyLink(); }
            else if (e.target === els.askInput) { e.preventDefault(); submitAsk(els.askInput.value); }
        });
        els.linkInput.addEventListener('input', () => els.linkInput.classList.remove('is-invalid'));

        applyDocked();

        return {
            setText,
            setEditable,
            setStreaming,
            showDiff,
            flashChanges,
            revealFocus,
            closeLayer,
            hasLayer() { return !!v.layer || (!bar.hidden && !v.docked); },
            dismiss() {
                if (closeLayer()) return true;
                if (!bar.hidden && !v.docked) {
                    const sel = window.getSelection();
                    if (sel && currentRange()) sel.collapseToEnd();
                    bar.hidden = true;
                    return true;
                }
                return false;
            },
            focusEnd() {
                if (!v.editable) return;
                page.focus({ preventScroll: true });
                const r = document.createRange();
                r.selectNodeContents(page);
                r.collapse(false);
                selectRange(r);
            },
            serialize() { return serialize(page); },
            get mode() { return v.mode; },
            get text() { return v.text; },
            get editable() { return v.editable; },
            _expandRange: expandRange,
            _computeFocus: computeFocus,
            _toolbar: bar
        };
    }

    window.CanvasDoc = {
        canRender,
        renderHtml,
        serialize,
        normalize,
        htmlToMarkdown,
        blocksToMarkdown,
        toPlainText,
        countWords,
        plainExcerpt,
        createView
    };
})();
