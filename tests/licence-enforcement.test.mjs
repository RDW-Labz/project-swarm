// T-0158: regression tests for R-033 licence and attribution swarm checks
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  DATA_SOURCE_LICENCE_SWARM_CHECK,
  evaluateDataSourceLicence,
  runDataSourceLicenceSwarmCheck,
  validateDataSourcesConfig,
} from '../tools/data-source-licence.mjs';
import {
  LICENCE_PRODUCT_SWARM_CHECK,
  runLicenceProductSwarmCheck,
} from '../tools/licence-product-check.mjs';
import {
  DATA_SOURCE_ATTRIBUTION_SWARM_CHECK,
  attributionPresenceViolations,
  dataSourceAttributionShipGate,
  runDataSourceAttributionSwarmCheck,
} from '../tools/attribution-check.mjs';

async function withTempRoot(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-licence-test-'));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('AC1: data-source-licence swarm check is registered for R-033', () => {
  assert.equal(DATA_SOURCE_LICENCE_SWARM_CHECK.requirement, 'R-033');
  assert.equal(DATA_SOURCE_LICENCE_SWARM_CHECK.name, 'data-source-licence');
  assert.deepEqual(DATA_SOURCE_LICENCE_SWARM_CHECK.argv, ['node', 'tools/data-source-licence.mjs', 'check']);
});

test('AC1: licence-product swarm check is registered for R-033', () => {
  assert.equal(LICENCE_PRODUCT_SWARM_CHECK.requirement, 'R-033');
  assert.equal(LICENCE_PRODUCT_SWARM_CHECK.name, 'licence-product');
  assert.deepEqual(LICENCE_PRODUCT_SWARM_CHECK.argv, ['node', 'tools/licence-product-check.mjs', 'check']);
});

test('AC1: each data source must carry a licence in profile metadata', () => {
  const missing = validateDataSourcesConfig({
    product: 'free',
    sources: [{ id: 'atlas', name: 'Atlas' }],
  });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(' '), /licence must be a non-empty string/);

  const ok = validateDataSourcesConfig({
    product: 'free',
    sources: [{ id: 'atlas', licence: 'CC0-1.0' }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.config.sources[0].licence, 'CC0-1.0');
});

test('AC1: non-commercial sources are blocked for a paid product (evaluateDataSourceLicence)', () => {
  const profile = {
    dataSources: {
      product: 'paid',
      sources: [
        {
          id: 'nc-dataset',
          licence: 'CC-BY-NC-4.0',
          attribution: 'Data © Example',
          shownIn: ['docs/readme.txt'],
        },
      ],
    },
  };
  const result = evaluateDataSourceLicence({ profile });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /non-commercial licence CC-BY-NC-4.0/);
});

test('AC1: licence-product swarm check refuses paid product with a non-commercial source', () => {
  const profile = {
    dataSources: {
      product: 'paid',
      sources: [
        {
          id: 'nc-dataset',
          licence: 'CC-BY-NC-4.0',
          attribution: 'Data © Example',
          shownIn: ['docs/readme.txt'],
        },
      ],
    },
  };
  const result = runLicenceProductSwarmCheck({ profile, skipScratch: false });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, false);
  assert.match(result.message, /not allowed for a paid product/);
});

test('AC1: data-source-licence swarm check agrees on paid plus non-commercial', () => {
  const profile = {
    dataSources: {
      product: 'paid',
      sources: [{ id: 'nc-dataset', licence: 'CC-BY-NC-4.0', attribution: 'Data © Example', shownIn: ['x.txt'] }],
    },
  };
  const result = runDataSourceLicenceSwarmCheck({ profile, skipScratch: false });
  assert.equal(result.ok, false);
  assert.match(result.message, /non-commercial/);
});

test('AC2: data-source-attribution swarm check is registered for R-033', () => {
  assert.equal(DATA_SOURCE_ATTRIBUTION_SWARM_CHECK.requirement, 'R-033');
  assert.equal(DATA_SOURCE_ATTRIBUTION_SWARM_CHECK.name, 'data-source-attribution');
  assert.deepEqual(DATA_SOURCE_ATTRIBUTION_SWARM_CHECK.argv, ['node', 'tools/attribution-check.mjs', 'check']);
});

test('AC2: required attribution must appear in every declared shownIn path', async () => {
  await withTempRoot(async root => {
    const rel = 'content/data.html';
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, '<p>Licensed map tiles</p>\n', 'utf8');

    const sources = [
      {
        id: 'tiles',
        licence: 'CC-BY-4.0',
        attribution: '© OpenTiles contributors',
        shownIn: [rel],
      },
    ];

    const missing = await attributionPresenceViolations({ root, sources });
    assert.equal(missing.length, 1);
    assert.equal(missing[0].reason, 'required attribution text not present');

    await fs.writeFile(abs, `<p>Licensed map tiles</p>\n<!-- © OpenTiles contributors -->\n`, 'utf8');
    const ok = await attributionPresenceViolations({ root, sources });
    assert.deepEqual(ok, []);
  });
});

test('AC2: attribution swarm check fails when shownIn file omits required text', async () => {
  await withTempRoot(async root => {
    const rel = 'ui/credits.md';
    await fs.mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), '# Credits\n', 'utf8');

    const profile = {
      dataSources: {
        product: 'free',
        sources: [
          {
            id: 'odbl-set',
            licence: 'ODbL-1.0',
            attribution: 'Contains data from Open Example Database',
            shownIn: [rel],
          },
        ],
      },
    };

    const result = await runDataSourceAttributionSwarmCheck({ root, profile, skipScratch: false });
    assert.ok(result.fileViolations?.length > 0);
    assert.match(result.message, /required attribution text not present/);

    const gate = await dataSourceAttributionShipGate({ profile, root });
    assert.ok(gate);
    assert.match(gate.message, /required attribution text not present/);
  });
});

test('AC2: attribution swarm check passes when every shownIn file contains attribution', async () => {
  await withTempRoot(async root => {
    const rel = 'ui/credits.md';
    const attribution = 'Contains data from Open Example Database';
    await fs.mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), `# Credits\n${attribution}\n`, 'utf8');

    const profile = {
      dataSources: {
        product: 'free',
        sources: [
          {
            id: 'odbl-set',
            licence: 'ODbL-1.0',
            attribution,
            shownIn: [rel],
          },
        ],
      },
    };

    const result = await runDataSourceAttributionSwarmCheck({ root, profile, skipScratch: false });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
  });
});
