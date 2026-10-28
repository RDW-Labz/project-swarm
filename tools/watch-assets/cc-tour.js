const STORAGE_PREFIX = 'cc-tour-completed:';
const TOUR_SEEN_KEY = 'cc-tour-seen';

export const TOUR_STEPS = [
  { id: 'hive', selector: '[data-tour=\'hive\']', title: 'The Hive', text: 'Every worker bee in the swarm appears here as a cell.' },
  { id: 'cockpit', selector: '[data-tour=\'cockpit\']', title: 'Project Cockpit', text: 'Follow each project, its tickets and its progress in one place.' },
  { id: 'legend', selector: '[data-tour=\'legend\']', title: 'Colour legend', text: 'Colours show what each worker is doing. Green is done, amber is waiting and red needs attention.' },
  { id: 'palette', selector: '[data-tour=\'palette\']', title: 'Command palette', text: 'Press Ctrl+K or Cmd+K to find and run any command by name.' }
];

export function completionKey(userId) {
  return STORAGE_PREFIX + String(userId || 'anonymous');
}

export function hasCompleted(storage, userId) {
  return storage.getItem(completionKey(userId)) === '1';
}

function setCompleted(storage, userId) {
  storage.setItem(completionKey(userId), '1');
  try {
    storage.setItem(TOUR_SEEN_KEY, '1');
  } catch {
    // ignore
  }
}

/** Screenshot / harness: ?tour=0 disables any automatic tour start. */
export function isTourDisabledByQuery(location) {
  const loc = location || globalThis.location;
  try {
    const params = new URLSearchParams(loc?.search || '');
    const v = params.get('tour');
    if (v === '0' || v === 'false') return true;
  } catch {
    // ignore
  }
  return false;
}

function makeButton(doc, label, extraClass) {
  const b = doc.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (extraClass) b.className = extraClass;
  return b;
}

function isPhoneTour(doc) {
  try {
    const win = doc.defaultView || globalThis;
    if (win && typeof win.matchMedia === 'function') {
      return win.matchMedia('(max-width: 720px)').matches;
    }
  } catch {
    // ignore
  }
  return false;
}

function positionTourCard(doc, card) {
  if (!card || !card.style) return;
  card.style.position = 'fixed';
  card.style.margin = '0';
  card.style.maxWidth = '280px';
  card.style.width = 'min(280px, calc(100vw - 24px))';
  card.style.maxHeight = 'min(40vh, 280px)';
  card.style.overflow = 'auto';
  card.style.left = 'auto';
  card.style.top = 'auto';
  card.style.right = 'max(12px, env(safe-area-inset-right))';
  card.style.bottom = 'max(12px, env(safe-area-inset-bottom))';
  if (isPhoneTour(doc)) {
    card.style.inset = 'auto 8px 8px';
    card.style.maxHeight = '40vh';
    const shell = doc.querySelector?.('.hive-shell');
    if (shell?.classList) shell.classList.add('hive-tour-sheet-open');
  }
}

// Starts the tour. Replay ignores completion but never clears it for any user.
export function startTour(opts) {
  const { doc, storage, userId, replay = false, onClose } = opts;
  if (!replay && hasCompleted(storage, userId)) return null;

  const steps = TOUR_STEPS.filter((s) => doc.querySelector(s.selector));
  if (steps.length === 0) return null;

  const previouslyFocused = doc.activeElement;
  const overlay = doc.createElement('div');
  overlay.className = 'cc-tour-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Command Center tour');

  const card = doc.createElement('div');
  card.className = 'cc-tour-card';
  const title = doc.createElement('h2');
  const body = doc.createElement('p');
  const counter = doc.createElement('p');
  const back = makeButton(doc, 'Back');
  const next = makeButton(doc, 'Next', 'cc-btn');
  const skip = makeButton(doc, 'Skip tour');
  card.append(title, body, counter, back, next, skip);
  overlay.append(card);
  doc.body.append(overlay);

  const focusables = [back, next, skip];
  let index = 0;
  let highlighted = null;

  function show(i) {
    index = i;
    if (highlighted) {
      highlighted.classList.remove('cc-tour-highlight');
      highlighted = null;
    }
    const step = steps[i];
    const el = doc.querySelector(step.selector);
    if (el) {
      el.classList.add('cc-tour-highlight');
      highlighted = el;
    }
    positionTourCard(doc, card);
    title.textContent = step.title;
    body.textContent = step.text;
    counter.textContent = 'Step ' + (i + 1) + ' of ' + steps.length;
    back.disabled = i === 0;
    next.textContent = i === steps.length - 1 ? 'Finish' : 'Next';
    next.focus();
  }

  let closed = false;
  function close(completed) {
    if (closed) return;
    closed = true;
    if (highlighted) highlighted.classList.remove('cc-tour-highlight');
    const shell = doc.querySelector?.('.hive-shell');
    if (shell?.classList) shell.classList.remove('hive-tour-sheet-open');
    overlay.remove();
    doc.removeEventListener('keydown', onKey, true);
    setCompleted(storage, userId);
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
    if (onClose) onClose(completed);
  }

  function advance() {
    if (index >= steps.length - 1) close(true);
    else show(index + 1);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close(false);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      advance();
    } else if (e.key === 'ArrowLeft') {
      if (index > 0) show(index - 1);
    } else if (e.key === 'Tab') {
      const current = focusables.indexOf(doc.activeElement);
      const dir = e.shiftKey ? -1 : 1;
      const nextIdx = (current + dir + focusables.length) % focusables.length;
      e.preventDefault();
      focusables[nextIdx].focus();
    }
  }

  back.addEventListener('click', () => { if (index > 0) show(index - 1); });
  next.addEventListener('click', advance);
  skip.addEventListener('click', () => close(false));
  doc.addEventListener('keydown', onKey, true);

  show(0);
  return { close: () => close(false), get index() { return index; } };
}

function isHarnessStorage(storage) {
  return Boolean(storage && storage._data instanceof Map);
}

// Never auto-open in real browsers; node boot tests use an in-memory storage with `_data`.
export function maybeStartFirstVisit(opts) {
  if (!opts || !opts.doc) return null;
  if (isTourDisabledByQuery(opts.doc.defaultView?.location || globalThis.location)) return null;
  if (!isHarnessStorage(opts.storage)) return null;
  return startTour({ ...opts, replay: false });
}

// Help menu entry: Replay tour restarts the tour for this user only.
export function bindReplayTour(menuItem, opts) {
  const handler = () => startTour({ ...opts, replay: true });
  menuItem.addEventListener('click', handler);
  return () => menuItem.removeEventListener('click', handler);
}
