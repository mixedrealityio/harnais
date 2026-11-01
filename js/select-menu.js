/* Menu aux couleurs du thème sur le <select> d'origine (gardé, input/change émis) ; liste native sur tactile et data-native-picker */
(function () {
    'use strict';

    const finePointer = window.matchMedia ? window.matchMedia('(pointer: fine)') : null;
    const MAX_HEIGHT = 320;

    let menu = null;
    let owner = null;
    let items = [];         // options affichées : { el, index, disabled, label }
    let active = -1;        // option survolée ou choisie au clavier (rang dans items)
    let typed = '';         // lettres tapées à la suite (recherche par le début)
    let typedTimer = 0;

    function eligible(select) {
        return select instanceof HTMLSelectElement && !select.multiple && select.size <= 1 &&
            !select.disabled && !select.hasAttribute('data-native-picker') &&
            (!finePointer || finePointer.matches);
    }

    function build(select) {
        const el = document.createElement('div');
        el.className = 'davidtwentyai-select-menu';
        el.setAttribute('role', 'listbox');
        el.style.fontSize = getComputedStyle(select).fontSize;
        items = [];
        const addOption = (opt, group) => {
            if (opt.hidden) return;
            const row = document.createElement('div');
            const disabled = opt.disabled || !!(group && group.disabled);
            const label = opt.label || opt.text;
            row.className = 'davidtwentyai-select-option' + (disabled ? ' is-disabled' : '');
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', String(opt.index === select.selectedIndex));
            if (disabled) row.setAttribute('aria-disabled', 'true');
            row.textContent = label;
            row.title = label;
            el.appendChild(row);
            items.push({ el: row, index: opt.index, disabled, label: label.trim().toLowerCase() });
        };
        for (const child of select.children) {
            if (child.tagName === 'OPTGROUP') {
                const title = document.createElement('div');
                title.className = 'davidtwentyai-select-group';
                title.textContent = child.label;
                el.appendChild(title);
                for (const opt of child.children) {
                    if (opt.tagName === 'OPTION') addOption(opt, child);
                }
            } else if (child.tagName === 'OPTION') {
                addOption(child, null);
            }
        }
        return el;
    }

    /** Sous le champ, ou au-dessus s'il y a plus de place, dans la fenêtre. */
    function place() {
        if (!menu || !owner) return;
        const r = owner.getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;
        const gap = 4, margin = 8;
        menu.style.minWidth = Math.round(r.width) + 'px';
        menu.style.maxWidth = Math.round(Math.max(r.width, Math.min(420, vw - 2 * margin))) + 'px';
        menu.style.maxHeight = '';
        const below = vh - r.bottom - gap - margin;
        const above = r.top - gap - margin;
        const wanted = Math.min(menu.scrollHeight, MAX_HEIGHT);
        const up = wanted > below && above > below;
        menu.style.maxHeight = Math.max(80, Math.min(MAX_HEIGHT, up ? above : below)) + 'px';
        menu.style.top = Math.round(up ? r.top - gap - menu.offsetHeight : r.bottom + gap) + 'px';
        menu.style.left = Math.round(Math.max(margin, Math.min(r.left, vw - margin - menu.offsetWidth))) + 'px';
    }

    function setActive(i, scroll) {
        if (items[active]) items[active].el.classList.remove('is-active');
        active = items[i] ? i : -1;
        if (active < 0) return;
        const row = items[active].el;
        row.classList.add('is-active');
        // Défilement du menu seul (scrollIntoView ferait aussi défiler la page)
        if (!scroll) return;
        if (row.offsetTop < menu.scrollTop) menu.scrollTop = row.offsetTop - 4;
        else if (row.offsetTop + row.offsetHeight > menu.scrollTop + menu.clientHeight) {
            menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight + 4;
        }
    }

    function move(delta, steps) {
        let i = active < 0 ? (delta > 0 ? -1 : items.length) : active;
        let target = active;
        for (let n = 0; n < (steps || 1); n++) {
            do { i += delta; } while (i >= 0 && i < items.length && items[i].disabled);
            if (i < 0 || i >= items.length) break;
            target = i;
        }
        if (target !== active) setActive(target, true);
    }

    function moveToEdge(last) {
        const order = items.map((_, i) => last ? items.length - 1 - i : i);
        const i = order.find(k => !items[k].disabled);
        if (i !== undefined) setActive(i, true);
    }

    function typeahead(char) {
        clearTimeout(typedTimer);
        typedTimer = setTimeout(() => { typed = ''; }, 700);
        typed += char.toLowerCase();
        const start = typed.length === 1 ? active + 1 : Math.max(active, 0);
        for (let n = 0; n < items.length; n++) {
            const i = (start + n) % items.length;
            if (!items[i].disabled && items[i].label.startsWith(typed)) {
                setActive(i, true);
                return;
            }
        }
    }

    function open(select) {
        close();
        owner = select;
        menu = build(select);
        document.body.appendChild(menu);
        select.classList.add('is-menu-open');
        place();
        setActive(items.findIndex(it => it.index === select.selectedIndex), true);
        // Le focus reste sur le <select> : le clavier continue d'y arriver
        menu.addEventListener('mousedown', (e) => e.preventDefault());
        menu.addEventListener('mousemove', (e) => {
            const row = e.target.closest('.davidtwentyai-select-option');
            const i = items.findIndex(it => it.el === row);
            if (i >= 0 && i !== active && !items[i].disabled) setActive(i, false);
        });
        menu.addEventListener('click', (e) => {
            const row = e.target.closest('.davidtwentyai-select-option');
            const i = items.findIndex(it => it.el === row);
            if (i >= 0) choose(i);
        });
    }

    function close() {
        if (!menu) return;
        menu.remove();
        if (owner) owner.classList.remove('is-menu-open');
        menu = null;
        owner = null;
        items = [];
        active = -1;
        typed = '';
    }

    function choose(i) {
        const item = items[i];
        if (!item || item.disabled || !owner) return;
        const select = owner;
        close();
        if (select.selectedIndex !== item.index) {
            select.selectedIndex = item.index;
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        select.focus({ preventScroll: true });
    }

    document.addEventListener('mousedown', (e) => {
        const select = e.target && e.target.closest ? e.target.closest('select') : null;
        if (menu && !menu.contains(e.target) && select !== owner) close();
        if (!select || e.button !== 0 || !eligible(select)) return;
        e.preventDefault();
        select.focus({ preventScroll: true });
        if (owner === select) close();
        else open(select);
    }, true);

    // Échap referme le menu sans fermer la fenêtre autour
    document.addEventListener('keydown', (e) => {
        const select = e.target;
        if (!(select instanceof HTMLSelectElement)) return;
        if (menu && owner === select) {
            switch (e.key) {
                case 'ArrowDown': move(1); break;
                case 'ArrowUp': move(-1); break;
                case 'PageDown': move(1, 8); break;
                case 'PageUp': move(-1, 8); break;
                case 'Home': moveToEdge(false); break;
                case 'End': moveToEdge(true); break;
                case 'Enter':
                case ' ':
                    if (active >= 0) choose(active);
                    else close();
                    break;
                case 'Escape': close(); break;
                case 'Tab': close(); return;
                default:
                    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
                    typeahead(e.key);
            }
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        const opens = e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === ' ' ||
            e.key === 'Enter' || e.key === 'F4';
        if (!opens || e.ctrlKey || e.metaKey || !eligible(select)) return;
        e.preventDefault();
        e.stopPropagation();
        open(select);
    }, true);

    document.addEventListener('focusout', (e) => {
        if (menu && e.target === owner) close();
    }, true);
    document.addEventListener('scroll', (e) => {
        if (menu && !(e.target instanceof Node && menu.contains(e.target))) close();
    }, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
})();
