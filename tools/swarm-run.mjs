// Ticket T-0021 stub. The run pipeline has not been extracted from tools/swarm.mjs
// because that file's source was not supplied to this job.
export const RUN_MODULE_STATUS = 'not-extracted';

export async function runPipeline() {
  throw new Error('swarm-run: pipeline not extracted; tools/swarm.mjs source was not supplied to this job');
}
