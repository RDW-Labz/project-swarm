const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function badName() {
  const err = new Error('invalid schema name');
  err.code = 'bad-name';
  return err;
}

export function validatorSource(names) {
  if (!Array.isArray(names)) throw badName();
  for (const name of names) {
    if (typeof name !== 'string' || !NAME.test(name)) throw badName();
  }
  return names.map((name) => `export const validate${name} = () => true;\n`).join('');
}
