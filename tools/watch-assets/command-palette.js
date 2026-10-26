/**
 * DOM-injectable command palette (Ctrl+K / Cmd+K per platform).
 */

export function isMacPlatform(platform) {
  const p = platform !== undefined && platform !== null
    ? String(platform)
    : (typeof navigator !== 'undefined' && navigator.platform ? String(navigator.platform) : '');
  return /Mac|iPhone|iPod|iPad/i.test(p);
}

/** @returns {'meta' | 'ctrl'} */
export function paletteModifierForPlatform(platform) {
  return isMacPlatform(platform) ? 'meta' : 'ctrl';
}

export function isPaletteToggleEvent(event, platform) {
  if (!event || (event.key !== 'k' && event.key !== 'K')) return false;
  const mac = isMacPlatform(platform);
  if (mac) return Boolean(event.metaKey) && !event.ctrlKey;
  return Boolean(event.ctrlKey) && !event.metaKey;
}

function itemCount(items) {
  return Array.isArray(items) ? items.length : 0;
}

export function createCommandPalette(opts) {
  const { doc, items = [], onNavigate, platform } = opts;
  let open = false;
  let selectedIndex = 0;
  let overlay = null;
  let rowNodes = [];
  let bound = false;

  function updateSelection() {
    for (let i = 0; i < rowNodes.length; i += 1) {
      const row = rowNodes[i];
      if (row.classList) {
        if (i === selectedIndex) row.classList.add('cc-palette-item--selected');
        else row.classList.remove('cc-palette-item--selected');
      }
      if (row.setAttribute) row.setAttribute('aria-selected', i === selectedIndex ? 'true' : 'false');
    }
  }

  function buildOverlay() {
    overlay = doc.createElement('div');
    overlay.className = 'cc-palette-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Command palette');
    overlay.setAttribute('data-cc-palette', 'open');

    const panel = doc.createElement('div');
    panel.className = 'cc-palette-panel';

    const list = doc.createElement('ul');
    list.className = 'cc-palette-list';
    list.setAttribute('role', 'listbox');

    rowNodes = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const row = doc.createElement('li');
      row.className = 'cc-palette-item';
      row.setAttribute('role', 'option');
      row.setAttribute('data-command-id', String(item.id ?? ''));
      row.textContent = String(item.label ?? item.id ?? '');
      list.appendChild(row);
      rowNodes.push(row);
    }

    panel.appendChild(list);
    overlay.appendChild(panel);
    doc.body.appendChild(overlay);
    updateSelection();
  }

  function closePalette() {
    if (!open) return;
    open = false;
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    rowNodes = [];
  }

  function openPalette() {
    if (open) return;
    if (itemCount(items) === 0) return;
    open = true;
    selectedIndex = 0;
    buildOverlay();
  }

  function togglePalette() {
    if (open) closePalette();
    else openPalette();
  }

  function onKeydown(e) {
    if (isPaletteToggleEvent(e, platform)) {
      e.preventDefault();
      togglePalette();
      return;
    }
    if (!open) return;

    const n = itemCount(items);
    if (n === 0) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % n;
      updateSelection();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + n) % n;
      updateSelection();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = items[selectedIndex];
      closePalette();
      if (onNavigate && selected) onNavigate(selected);
    }
  }

  function bind() {
    if (bound) return;
    bound = true;
    doc.addEventListener('keydown', onKeydown, true);
  }

  function unbind() {
    if (!bound) return;
    bound = false;
    doc.removeEventListener('keydown', onKeydown, true);
    closePalette();
  }

  return {
    bind,
    unbind,
    open: openPalette,
    close: closePalette,
    toggle: togglePalette,
    get isOpen() { return open; },
    get selectedIndex() { return selectedIndex; },
  };
}
