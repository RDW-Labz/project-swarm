import { promises as fs, constants as fsc } from 'node:fs';
import path from 'node:path';

const MARKER = '# project-swarm defaults';

const BLOCKS = {
  node: [
    'node_modules/',
    '.next/',
    'out/',
    'dist/',
    'coverage/',
    '*.tsbuildinfo',
    'next-env.d.ts',
    '.env*',
  ],
  python: [
    '__pycache__/',
    '.venv/',
    '*.pyc',
  ],
};

export function gitignoreBlock(stacks) {
  const lines = [MARKER];
  const seen = new Set();
  for (const stack of stacks ?? []) {
    const entries = BLOCKS[stack];
    if (!entries) continue;
    for (const line of entries) {
      if (!seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
  }
  return lines.join('\n') + '\n';
}

function gitignoreError(message) {
  const err = new Error(message);
  err.code = 'gitignore-unsafe';
  return err;
}

async function readExisting(file) {
  let st;
  try {
    st = await fs.lstat(file);
  } catch (e) {
    if (e && e.code === 'ENOENT') return '';
    throw e;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw gitignoreError('gitignore-unsafe: .gitignore is a symlink or not a regular file');
  }
  return fs.readFile(file, 'utf8');
}

export async function ensureGitignore(root, stacks) {
  const file = path.join(root, '.gitignore');
  const current = await readExisting(file);
  const present = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const hasEnvNegation = current.split(/\r?\n/).some((l) => l.trim().startsWith('!.env'));

  const block = gitignoreBlock(stacks).split('\n').filter((l) => l.length > 0);
  const added = [];
  const skipped = [];
  for (const line of block) {
    if (line === MARKER) continue;
    if (line === '.env*' && hasEnvNegation) {
      skipped.push(line);
      continue;
    }
    if (!present.has(line.trim())) {
      added.push(line);
      present.add(line.trim());
    }
  }

  if (added.length === 0) {
    return { changed: false, added: [], skipped };
  }

  const addedLines = [];
  if (!present.has(MARKER) && !current.split(/\r?\n/).some((l) => l.trim() === MARKER)) {
    addedLines.push(MARKER);
  }
  addedLines.push(...added);

  let prefix = current;
  if (prefix.length > 0 && !prefix.endsWith('\n')) prefix += '\n';
  if (prefix.length > 0) prefix += '\n';
  const next = prefix + addedLines.join('\n') + '\n';

  const tmp = path.join(root, `.gitignore.${process.pid}.${Date.now()}.tmp`);
  const flags = fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW;
  const handle = await fs.open(tmp, flags, 0o644);
  try {
    await handle.writeFile(next, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }

  return { changed: true, added: addedLines, skipped };
}
