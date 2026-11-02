import { lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export async function writeNoFollow(dir, name, text) {
  const target = path.join(dir, name);
  let st = null;
  try {
    st = await lstat(target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (st && st.isSymbolicLink()) {
    const e = new Error('refusing to write through symlink: ' + name);
    e.code = 'symlink';
    throw e;
  }
  const tmp = path.join(dir, '.' + name + '.' + randomBytes(8).toString('hex') + '.tmp');
  let fh = null;
  try {
    fh = await open(tmp, 'wx', 0o644);
    await fh.writeFile(text, 'utf8');
    await fh.sync();
    await fh.close();
    fh = null;
    await rename(tmp, target);
  } catch (err) {
    if (fh) await fh.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
