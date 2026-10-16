import path from 'node:path';

// Returns the absolute path of file inside root, or throws code 'outside'.
export function resolveInside(root, file) {
  const base = path.resolve(root);
  const target = path.resolve(base, file);
  if (!target.startsWith(base)) {
    const err = new Error('path is outside the root');
    err.code = 'outside';
    throw err;
  }
  return target;
}
