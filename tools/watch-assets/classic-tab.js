// Classic tab wrapper for Swarm Watch (T-0291).
// Wraps existing views under a Classic tab without changing their routes.

export const CLASSIC_TAB_ID = 'classic';
export const CLASSIC_TAB_LABEL = 'Classic';
export const CLASSIC_PANEL_ID = 'classic-panel';

export function wrapClassicView(html) {
  if (typeof html !== 'string') {
    throw new TypeError('wrapClassicView expects an HTML string');
  }
  return '<nav class="tabs" role="tablist">'
    + '<button type="button" role="tab" id="' + CLASSIC_TAB_ID + '-tab" aria-selected="true" aria-controls="' + CLASSIC_PANEL_ID + '">'
    + CLASSIC_TAB_LABEL + '</button></nav>'
    + '<section id="' + CLASSIC_PANEL_ID + '" role="tabpanel" aria-labelledby="' + CLASSIC_TAB_ID + '-tab">'
    + html
    + '</section>';
}

// Returns a new route map with the same keys as the input. Each handler's
// string result is wrapped in the Classic tab; other results pass through.
export function wrapClassicRoutes(routes) {
  if (routes === null || typeof routes !== 'object') {
    throw new TypeError('wrapClassicRoutes expects an object of route handlers');
  }
  const wrapped = {};
  for (const path of Object.keys(routes)) {
    const handler = routes[path];
    if (typeof handler !== 'function') {
      throw new TypeError('route ' + path + ' has no handler function');
    }
    wrapped[path] = async (...args) => {
      const result = await handler(...args);
      return typeof result === 'string' ? wrapClassicView(result) : result;
    };
  }
  return wrapped;
}
