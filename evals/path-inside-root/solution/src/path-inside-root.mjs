import path from 'node:path';

// Returns the absolute path of file inside root, or throws code 'outside'.
export function resolveInside(root, file) {
  const base = path.resolve(root);
  const target = path.resolve(base, file);
  const rel = path.relative(base, target);
  if (rel !== '' && (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))) {
    const err = new Error('path is outside the root');
    err.code = 'outside';
    throw err;
  }
  return target;
}
