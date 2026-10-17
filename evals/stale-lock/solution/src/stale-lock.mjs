import { open, unlink, stat } from 'node:fs/promises';

async function createExclusive(file) {
  const handle = await open(file, 'wx');
  await handle.close();
}

function busyError(file) {
  const err = new Error('lock is busy: ' + file);
  err.code = 'busy';
  return err;
}

export async function withLock(file, fn, options = {}) {
  const staleMs = options.staleMs ?? 600000;
  try {
    await createExclusive(file);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let age = 0;
    try {
      const st = await stat(file);
      age = Date.now() - st.mtimeMs;
    } catch (statErr) {
      if (statErr.code !== 'ENOENT') throw statErr;
      throw busyError(file);
    }
    if (age < staleMs) throw busyError(file);
    await unlink(file).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
    try {
      await createExclusive(file);
    } catch (e2) {
      if (e2.code === 'EEXIST') throw busyError(file);
      throw e2;
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(file).catch(() => {});
  }
}
