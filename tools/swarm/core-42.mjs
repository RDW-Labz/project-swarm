import { resolveCliHosts } from '../cli-host.mjs';
import { loadLocalConfig } from '../local-config.mjs';
import { isPackagingFile, packagingKeyChanges } from '../packaging-check.mjs';
import { execFileAsync } from './core-1.mjs';
import { bytesAt } from './core-31.mjs';
import { doctor } from './core-32.mjs';
import { AGENTS, MAX_FILE } from './patterns.mjs';

// `skipRemote`: a provider that runs on another machine over ssh is not probed (an unreachable host would take minutes: ssh retries), it is reported "remote-unchecked".
// Bare `swarm` and `swarm status` use it so they answer at once; `swarm doctor AGENT` still does the real check.
export async function doctorAll(options={}){
  const providers=[];
  const hosts=options.skipRemote?resolveCliHosts(loadLocalConfig({env:options.env??process.env}).cliHosts):{};
  for(const agent of AGENTS)if(hosts[agent]){providers.push({agent,status:'remote-unchecked',liveVerified:false,host:hosts[agent].target,note:`Runs on ${hosts[agent].target}; not probed here. swarm doctor ${agent} checks it.`});continue;}
  else try{providers.push({agent,...await doctor({...options,agent})});}catch{providers.push({agent,status:'unavailable',liveVerified:false,note:'Provider compatibility check failed; run doctor for this provider for details.'});}
  return {status:'report',providers};
}

// Field lesson #159: each packaging file a change touched, with the packaging keys it moved.
async function packagingChangesSince(root, baseRevision, files) {
  const changes = [];
  for (const file of files.filter(isPackagingFile)) {
    let before = '';
    if (baseRevision) { try { before = (await execFileAsync('git', ['-C', root, 'show', `${baseRevision}:${file}`], { encoding: 'utf8', maxBuffer: MAX_FILE })).stdout; } catch { before = ''; } }
    const after = (await bytesAt(root, file))?.toString('utf8') ?? '';
    changes.push({ file, keys: packagingKeyChanges(file, before, after) });
  }
  return changes;
}

export { packagingChangesSince };
