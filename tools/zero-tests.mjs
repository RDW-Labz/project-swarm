// SPDX-License-Identifier: Apache-2.0
export function countTests(output) {
  const text = String(output ?? '');
  // node:test: the tap reporter prints "# tests N", the spec reporter prints "ℹ tests N".
  let m = /^[#ℹ]\s*tests\s+(\d+)/im.exec(text);
  if (m) return { runner: 'node', count: Number(m[1]) };
  // A top-level TAP plan of zero tests (column 0 only: an empty nested subtest is not the whole run).
  if (/^1\.\.0\b/m.test(text)) return { runner: 'tap', count: 0 };
  // vitest: the Tests line counts passed and failed (skipped tests did not run); real counts win over "no test files" of one workspace project.
  m = /^\s*Tests\s{2,}(.*)$/m.exec(text);
  if (m) {
    const passed = /(\d+)\s+passed/i.exec(m[1]);
    const failed = /(\d+)\s+failed/i.exec(m[1]);
    return { runner: 'vitest', count: (passed ? Number(passed[1]) : 0) + (failed ? Number(failed[1]) : 0) };
  }
  if (/no test files found/i.test(text)) return { runner: 'vitest', count: 0 };
  m = /Test Files\s+(\d+)/i.exec(text);
  if (m) return { runner: 'vitest', count: Number(m[1]) };
  if (/no tests found/i.test(text)) return { runner: 'jest', count: 0 };
  m = /^Tests:\s+.*?(\d+)\s+total/im.exec(text) || /^Tests:\s+(\d+)/im.exec(text);
  if (m) return { runner: 'jest', count: Number(m[1]) };
  if (/no tests ran/i.test(text) || /collected 0 items/i.test(text)) return { runner: 'pytest', count: 0 };
  // go: packages without tests print "[no test files]" next to real "ok" lines; only a run with no ok and no PASS line ran nothing.
  const goOk = text.match(/^ok\s+\S+/gm);
  const goPass = text.match(/^\s*--- PASS/gm);
  if (goOk || goPass) return { runner: 'go', count: (goOk ? goOk.length : 0) + (goPass ? goPass.length : 0) };
  const passed = /(\d+)\s+passed/i.exec(text);
  const failed = /(\d+)\s+failed/i.exec(text);
  if (passed || failed) {
    return { runner: 'pytest', count: (passed ? Number(passed[1]) : 0) + (failed ? Number(failed[1]) : 0) };
  }
  if (/no test files/i.test(text)) return { runner: 'go', count: 0 };
  return { runner: null, count: null };
}

export function isTestCheck(name) {
  return typeof name === 'string' && (name === 'test' || name === 'tests' || name.startsWith('test:'));
}

export function zeroTestGuard(check, result) {
  if (!isTestCheck(check?.name)) return result;
  if (result?.status !== 'passed') return result;
  const { count } = countTests(result.tail);
  if (count !== 0) return result;
  const line = 'no-tests: the check passed but ran 0 tests (wrong test runner for these files?)';
  const old = result.tail ?? '';
  const tail = old ? old + '\n' + line : line;
  return { ...result, status: 'failed', noTests: true, tail };
}

export function detectTestCommand({ pkg, files = [] } = {}) {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const has = (k) => Object.prototype.hasOwnProperty.call(deps, k);
  const testScript = String(pkg?.scripts?.test ?? '');
  const list = Array.isArray(files) ? files : [];
  if (has('vitest')) return { runner: 'vitest', command: ['npx', 'vitest', 'run', '{tests}'] };
  if (has('jest')) return { runner: 'jest', command: ['npx', 'jest', '{tests}'] };
  if (has('@playwright/test')) return { runner: 'playwright', command: ['npx', 'playwright', 'test', '{tests}'] };
  if (testScript.includes('node --test')) return { runner: 'node', command: ['node', '--test', '{tests}'] };
  if (list.includes('pyproject.toml') || list.includes('pytest.ini')) return { runner: 'pytest', command: ['pytest', '{tests}'] };
  return null;
}
