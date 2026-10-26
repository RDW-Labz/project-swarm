import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadWatchHubEntries,
  validateWatchHubEntry,
  watchHubEntrySchemaPath,
} from '../tools/watch-hub/load-entries.mjs';

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(dir, name, text) {
  fs.writeFileSync(path.join(dir, name), text);
}

test('entry-schema.json is present and describes required watch-hub fields', () => {
  const schema = JSON.parse(fs.readFileSync(watchHubEntrySchemaPath, 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(schema.required.sort(), ['at', 'id', 'title']);
  assert.ok(schema.properties.status.enum.includes('active'));
});

test('valid JSON entry loads and validates against the schema rules', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-hub-'));
  writeJson(dir, 'deploy.json', {
    id: 'deploy-runbook',
    title: 'Deploy runbook',
    at: '2024-06-01T12:00:00.000Z',
    body: 'Steps to deploy.',
    tags: ['ops'],
    status: 'active',
  });
  const { entries, errors } = await loadWatchHubEntries(dir);
  assert.equal(errors.length, 0);
  assert.equal(entries.length, 1);
  const check = validateWatchHubEntry(entries[0]);
  assert.equal(check.ok, true);
  assert.equal(entries[0].title, 'Deploy runbook');
});

test('invalid JSON entry is reported per file without blocking valid entries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-hub-'));
  writeJson(dir, 'bad.json', {
    id: 'missing-title',
    at: '2024-06-02T12:00:00.000Z',
  });
  writeJson(dir, 'good.json', {
    id: 'good-entry',
    title: 'Still loads',
    at: '2024-06-03T12:00:00.000Z',
  });
  const { entries, errors } = await loadWatchHubEntries(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'good-entry');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'bad.json');
  assert.match(errors[0].message, /title/i);
});

test('Markdown entry extracts title and body from the first heading', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-hub-'));
  const file = path.join(dir, 'lane-guide.md');
  writeText(
    dir,
    'lane-guide.md',
    `# Lane guide

Use this lane for reviews.
`,
  );
  const mtime = new Date('2024-05-10T08:30:00.000Z');
  fs.utimesSync(file, mtime, mtime);
  const { entries, errors } = await loadWatchHubEntries(dir);
  assert.equal(errors.length, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'lane-guide');
  assert.equal(entries[0].title, 'Lane guide');
  assert.equal(entries[0].body, 'Use this lane for reviews.');
  assert.equal(entries[0].at, mtime.toISOString());
});

test('empty entries directory returns no entries and no errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-hub-empty-'));
  const { entries, errors } = await loadWatchHubEntries(dir);
  assert.deepEqual(entries, []);
  assert.deepEqual(errors, []);
});

function loadEntrySchema() {
  return JSON.parse(fs.readFileSync(watchHubEntrySchemaPath, 'utf8'));
}

function minimalValidEntry(schema) {
  const entry = {};
  for (const key of schema.required) {
    if (key === 'at') entry[key] = '2024-06-01T12:00:00.000Z';
    else entry[key] = `sample-${key}`;
  }
  return entry;
}

test('object with schema-required fields validates against entry-schema.json via validateWatchHubEntry', () => {
  const schema = loadEntrySchema();
  const entry = minimalValidEntry(schema);
  const check = validateWatchHubEntry(entry);
  assert.equal(check.ok, true, check.errors.join('; '));
});

test('object missing a schema-required field fails validation without throwing', () => {
  const schema = loadEntrySchema();
  const entry = minimalValidEntry(schema);
  const missingKey = schema.required[0];
  delete entry[missingKey];
  const check = validateWatchHubEntry(entry);
  assert.equal(check.ok, false);
  assert.ok(
    check.errors.some((message) => message.toLowerCase().includes(missingKey)),
    check.errors.join('; '),
  );
});

test('object with wrong property type per entry-schema.json fails validation without throwing', () => {
  loadEntrySchema();
  const entry = {
    id: 'typed-check',
    title: 'Type check',
    at: '2024-06-01T12:00:00.000Z',
    tags: 'not-an-array',
  };
  const check = validateWatchHubEntry(entry);
  assert.equal(check.ok, false);
  assert.match(check.errors.join('; '), /tags/i);
});
