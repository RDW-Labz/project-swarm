import { open, unlink } from 'node:fs/promises';

export async function withLock(file, fn, options = {}) {
  const handle = await open(file, 'wx');
  await handle.close();
  const result = await fn();
  await unlink(file);
  return result;
}
