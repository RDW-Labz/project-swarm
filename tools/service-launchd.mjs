import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

export const LABEL = 'dev.projectswarm.service';

export function plistPath({ home = homedir(), label = LABEL } = {}) {
  return path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderPlist({ label = LABEL, nodePath, scriptPath, logDir }) {
  const args = [nodePath, scriptPath, 'serve']
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'service.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'service.err.log'))}</string>
</dict>
</plist>
`;
}

export function runLaunchctl(args) {
  return new Promise((resolve, reject) => {
    execFile('launchctl', args, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

// AC1: writes the plist and loads it into the user's gui launchd domain.
export async function installService({
  home,
  uid,
  nodePath = process.execPath,
  scriptPath,
  logDir,
  label = LABEL,
  platform = process.platform,
  launchctl = runLaunchctl,
} = {}) {
  if (platform !== 'darwin') throw new Error('swarm service install needs macOS launchd');
  if (!scriptPath) throw new Error('scriptPath is required');
  const userHome = home ?? homedir();
  const file = plistPath({ home: userHome, label });
  const dir = logDir ?? path.join(userHome, 'Library', 'Logs', 'project-swarm');
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(dir, { recursive: true });
  await writeFile(file, renderPlist({ label, nodePath, scriptPath, logDir: dir }), 'utf8');
  const domain = `gui/${uid ?? process.getuid()}`;
  await launchctl(['bootout', `${domain}/${label}`]).catch(() => {});
  await launchctl(['bootstrap', domain, file]);
  return { plist: file, label, domain };
}

// AC2: reports running only when launchctl print shows state = running.
export async function serviceStatus({ uid, label = LABEL, launchctl = runLaunchctl } = {}) {
  const domain = `gui/${uid ?? process.getuid()}`;
  let out;
  try {
    out = await launchctl(['print', `${domain}/${label}`]);
  } catch {
    return { label, loaded: false, running: false, pid: null };
  }
  const pid = /\bpid = (\d+)/.exec(out);
  const state = /\bstate = (\w+)/.exec(out);
  const running = Boolean(state) && state[1] === 'running';
  return { label, loaded: true, running, pid: pid ? Number(pid[1]) : null };
}
