export async function mutantProblems(mutants, readText) {
  const problems = [];
  for (const mutant of mutants) {
    if (mutant.find === mutant.replace) { problems.push({ name: mutant.name, file: mutant.file, code: 'no-op' }); continue; }
    const text = await readText(mutant.file);
    const count = text === null ? 0 : text.split(mutant.find).length - 1;
    if (count === 0) problems.push({ name: mutant.name, file: mutant.file, code: 'invalid-find', count, ...(text === null ? { missingFile: true } : {}) });
    else if (count > 1) problems.push({ name: mutant.name, file: mutant.file, code: 'ambiguous-find', count });
  }
  return problems;
}

const describeMutantProblem = problem => `${problem.name}: ${problem.code} (${problem.file}${problem.missingFile ? ' missing' : problem.code === 'no-op' ? ': find equals replace' : `: find matched ${problem.count} times`})`;

async function refuseInvalidMutants(mutants, readText) {
  const problems = await mutantProblems(mutants, readText);
  if (problems.length) throw Object.assign(new Error(`Refusing to run mutants: ${problems.length} invalid mutant(s), nothing mutated: ${problems.map(describeMutantProblem).join('; ')}`), { details: { mutantProblems: problems } });
}

// The mutant's file is written, checked, then always restored byte-for-byte (try/finally,
// including on a check timeout or spawn error) so a mutation check can never leave a real edit.
// Field lesson #162: the mutant's own `check` wins over the shared check for that mutant only;
// the result names which one ran (and so which one killed it).
const mutantCheckSpec = (mutant, checkSpec) => mutant.check ? { argv: mutant.check, timeoutMs: checkSpec?.timeoutMs, source: 'mutant' } : { ...checkSpec, source: 'default' };

export { describeMutantProblem, mutantCheckSpec, refuseInvalidMutants };
