import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("package.json test script has isolate import and bounded test timeout", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const script = pkg.scripts.test;
  assert.match(script, /--import \.\/tests\/_isolate-config\.mjs/);
  const m = script.match(/--test-timeout=(\d+)/);
  assert.ok(m, "expected --test-timeout=<ms>");
  const ms = Number(m[1]);
  assert.ok(ms >= 60000 && ms <= 1800000, `timeout ${ms} outside 60000–1800000`);
});

test("ci.yml bounds test job and limits push to main", () => {
  const yml = readFileSync(".github/workflows/ci.yml", "utf8");
  const jobBlock = yml.slice(yml.indexOf("  test:"));
  assert.match(jobBlock, /timeout-minutes:\s*(\d+)/);
  const tm = Number(jobBlock.match(/timeout-minutes:\s*(\d+)/)[1]);
  assert.ok(tm >= 10 && tm <= 60, `timeout-minutes ${tm} outside 10–60`);
  assert.match(yml, /push:\s*\n\s+branches:\s*\n\s+-\s+main/);
  assert.match(yml, /pull_request:/);
});
