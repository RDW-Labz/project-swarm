export function isHost(url, host) {
  if (typeof url !== 'string' || typeof host !== 'string' || host === '') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.hostname.toLowerCase() === host.toLowerCase();
}
