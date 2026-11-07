import { pathToFileURL } from 'node:url';

export const ORCHESTRATOR_PAT_SCOPES = Object.freeze([
  Object.freeze({ name: 'Contents', access: 'read and write' }),
  Object.freeze({ name: 'Pull requests', access: 'read and write' }),
  Object.freeze({ name: 'Metadata', access: 'read' }),
  Object.freeze({ name: 'Actions', access: 'read' }),
]);

export function formatPatScopes() {
  const lines = [
    'Before creating the token in GitHub, create a fine-grained personal access token with exactly these repository permissions:',
  ];
  for (const scope of ORCHESTRATOR_PAT_SCOPES) {
    lines.push(`  - ${scope.name}: ${scope.access}`);
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${formatPatScopes()}\n`);
}
