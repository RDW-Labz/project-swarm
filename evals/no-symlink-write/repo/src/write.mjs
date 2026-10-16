import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// Starting point: writes directly to the target path, which follows symlinks.
export async function writeNoFollow(dir, name, text) {
  await writeFile(path.join(dir, name), text, 'utf8');
}
