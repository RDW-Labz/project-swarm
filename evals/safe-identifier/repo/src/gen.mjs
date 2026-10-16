export function validatorSource(names) {
  return names.map((name) => `export const validate${name} = () => true;`).join('\n') + '\n';
}
