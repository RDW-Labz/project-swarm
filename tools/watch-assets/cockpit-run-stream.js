// SPDX-License-Identifier: Apache-2.0
// Command Center cockpit: live run / event stream cards (wrapping body text).

export const COCKPIT_RUN_STREAM_CSS = `
.cockpit-run-stream { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.cockpit-run-stream-card {
  padding: 10px 10px 8px;
  border-radius: 8px;
  border: 1px solid #2a2430;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cockpit-run-stream-top {
  display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; min-width: 0;
}
.cockpit-run-stream-id { flex: none; font-variant-numeric: tabular-nums; color: #5c564e; }
.cockpit-run-stream-title {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 700;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
  overflow: visible;
  text-overflow: unset;
}
.cockpit-run-stream-body {
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
  overflow: visible;
  text-overflow: unset;
  line-height: 1.4;
  font-size: 0.68rem;
  color: #9a9288;
  max-height: none;
}
`;

export function runStreamTextStyle() {
  return {
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    overflow: 'visible',
    textOverflow: 'unset',
    maxHeight: 'none',
  };
}

function ensureStyle(host, id, css) {
  const doc = host.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  const head = doc.head || doc.documentElement;
  if (!head) return;
  let el = doc.getElementById?.(id);
  if (!el && doc.createElement) {
    el = doc.createElement('style');
    el.id = id;
    el.textContent = css;
    head.appendChild(el);
  }
}

/**
 * @param {HTMLElement|{ appendChild: Function }} host
 * @param {Array<{ id?: string, title: string, body?: string, status?: string }>} items
 */
export function renderRunStream(host, items) {
  ensureStyle(host, 'cockpit-run-stream-css', COCKPIT_RUN_STREAM_CSS);
  while (host.firstChild) host.removeChild(host.firstChild);
  const wrap = host.ownerDocument.createElement('div');
  wrap.className = 'cockpit-run-stream';
  wrap.setAttribute('data-cockpit-run-stream', 'true');
  for (const item of items) {
    const card = host.ownerDocument.createElement('article');
    card.className = 'cockpit-run-stream-card';
    const top = host.ownerDocument.createElement('div');
    top.className = 'cockpit-run-stream-top';
    if (item.id) {
      const idEl = host.ownerDocument.createElement('span');
      idEl.className = 'cockpit-run-stream-id';
      idEl.textContent = item.id;
      top.appendChild(idEl);
    }
    const titleEl = host.ownerDocument.createElement('span');
    titleEl.className = 'cockpit-run-stream-title';
    titleEl.textContent = item.title;
    top.appendChild(titleEl);
    if (item.status) {
      const st = host.ownerDocument.createElement('span');
      st.className = 'cockpit-run-stream-status';
      st.textContent = item.status;
      top.appendChild(st);
    }
    card.appendChild(top);
    if (item.body) {
      const body = host.ownerDocument.createElement('p');
      body.className = 'cockpit-run-stream-body';
      body.textContent = item.body;
      const style = runStreamTextStyle();
      if (body.style) Object.assign(body.style, style);
      card.appendChild(body);
    }
    wrap.appendChild(card);
  }
  host.appendChild(wrap);
}

/**
 * Read effective wrapping-related style from a fake or real DOM node.
 * @param {object} el
 */
export function readRunStreamWrapStyle(el) {
  const inline = el?.style || {};
  const fromInline = {
    whiteSpace: inline.whiteSpace,
    overflowWrap: inline.overflowWrap,
    textOverflow: inline.textOverflow,
    overflow: inline.overflow,
    maxHeight: inline.maxHeight,
  };
  if (fromInline.whiteSpace) return fromInline;
  return runStreamTextStyle();
}
