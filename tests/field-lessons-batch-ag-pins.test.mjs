import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { runCheckPins } from '../tools/check-pins.mjs';

function makeZip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name);
    const header = Buffer.alloc(30);
    const crc = zlib.crc32(data);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    local.push(header, nameBuf, data);
    central.push({ nameBuf, crc, size: data.length, offset });
    offset += header.length + nameBuf.length + data.length;
  }
  const centralStart = offset;
  const centralParts = [];
  for (const entry of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
    header.writeUInt32LE(entry.crc, 16); header.writeUInt32LE(entry.size, 20); header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.nameBuf.length, 28); header.writeUInt32LE(entry.offset, 42);
    centralParts.push(header, entry.nameBuf);
    offset += header.length + entry.nameBuf.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length, 8); eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - centralStart, 12); eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...local, ...centralParts, eocd]);
}

async function writeWheel(root, name, version, requirements = []) {
  const vendor = path.join(root, 'vendor');
  await fs.mkdir(vendor, { recursive: true });
  const metadata = [`Metadata-Version: 2.1`, `Name: ${name}`, `Version: ${version}`, ...requirements.map(value => `Requires-Dist: ${value}`)].join('\n') + '\n';
  const filename = `${name.replace(/-/g, '_')}-${version}-py3-none-any.whl`;
  await fs.writeFile(path.join(vendor, filename), makeZip([{ name: `${name}-${version}.dist-info/METADATA`, data: Buffer.from(metadata) }]));
  return filename;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-pins-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('L343 application vendoring core reports a missing runtime wheel', async t => {
  const cases = [
    ['missing dependency', '[project]\nname = "acme-app"\ndependencies = []\n', true],
    ['sources-only dependency', '[project]\nname = "acme-app"\ndependencies = []\n\n[tool.uv.sources]\nruntime = { path = "../runtime" }\n', true],
    ['build-system-only dependency', '[project]\nname = "acme-app"\ndependencies = []\n\n[build-system]\nrequires = ["runtime>=1"]\n', true],
    ['direct dependency', '[project]\nname = "acme-app"\ndependencies = ["runtime>=1"]\n', false],
    ['vendored dependency', '[project]\nname = "acme-app"\ndependencies = []\n', false],
  ];
  for (const [label, pyproject, missing] of cases) {
    await t.test(label, async subtest => {
      const root = await fixture(subtest);
      await fs.writeFile(path.join(root, 'pyproject.toml'), pyproject);
      const coreWheel = await writeWheel(root, 'acme-core', '0.5.1', ['runtime[extra]>=1', 'pytest>=7 ; extra == "test"']);
      if (label === 'vendored dependency') await writeWheel(root, 'runtime', '1.2.0');
      const result = await runCheckPins({ root, core: 'acme_core' });
      const findings = result.findings.filter(finding => finding.rule === 'vendored-core-missing-runtime-wheels');
      if (missing) {
        assert.equal(result.exitCode, 1);
        assert.deepEqual(findings, [{
          rule: 'vendored-core-missing-runtime-wheels',
          file: `vendor/${coreWheel}`,
          package: 'runtime',
          message: `vendored core wheel ${coreWheel} requires runtime, which is neither vendored nor a direct project dependency`,
        }]);
      } else {
        assert.deepEqual(findings, []);
      }
    });
  }
});

test('L343 unconfigured core reports the runtime rule as skipped', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "acme-app"\ndependencies = []\n');
  await writeWheel(root, 'acme-core', '0.5.1', ['runtime>=1']);
  const result = await runCheckPins({ root });
  assert.deepEqual(result.skippedRules, ['library-exact-core-pin', 'wheel-requirement-unsatisfied', 'vendored-core-missing-runtime-wheels']);
  assert.ok(!result.findings.some(finding => finding.rule === 'vendored-core-missing-runtime-wheels'));
});
