// Ported from https://github.com/fayazara/robot-heads (src/ticker.ts), commit 58ebf6439a8125a769f63b22ffd35bc18834b1b5. MIT License, Copyright (c) 2026 Fayaz Ahmed (see ROBOT-HEADS-LICENSE.txt).
// Only the TypeScript types were removed and the import paths changed.
/* One shared animation loop for every head on the page. Each subscriber
   gets the seconds since the last frame; the loop sleeps while the tab is
   hidden or nobody is listening. */

                                 

/** Where the pointer last was on the page, NaN while it is away. */
export const pointer = { x: NaN, y: NaN };
import { mountAmbientMotion } from './cc-hive-stage.js';

const subscribers = new Set      ();
let motion = null;
let listening = false;

function start() {
  if (motion || typeof document === 'undefined') return;
  motion = mountAmbientMotion({ element: document.documentElement, frameMs: 1000 / 15, freezeCss: false,
    draw: dt => subscribers.forEach(fn => fn(dt)) });
}

function stop() {
  motion?.destroy();
  motion = null;
}

function listen() {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  const away = () => {
    pointer.x = NaN;
    pointer.y = NaN;
  };
  document.addEventListener('pointermove', (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
  }, { passive: true });
  document.addEventListener('pointerleave', away);
  window.addEventListener('blur', away);
}

export function subscribe(fn      )             {
  listen();
  subscribers.add(fn);
  start();
  return () => {
    subscribers.delete(fn);
    if (!subscribers.size) stop();
  };
}
