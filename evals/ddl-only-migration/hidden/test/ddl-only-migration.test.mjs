import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const file = 'supabase/migrations/ddl-only-migration.sql';
const sql = readFileSync(file, 'utf8');

test('creates the notes table with the four columns', () => {
  assert.match(sql, /create\s+table\s+(if\s+not\s+exists\s+)?(public\.)?notes\s*\(/i);
  assert.match(sql, /\bid\s+uuid\s+primary\s+key\b/i);
  assert.match(sql, /\bshop_id\s+uuid\s+not\s+null\b/i);
  assert.match(sql, /\bbody\s+text\s+not\s+null\b/i);
  assert.match(sql, /\bcreated_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i);
});

test('creates an index on notes(shop_id)', () => {
  assert.match(sql, /create\s+(unique\s+)?index\b[^;]*\bon\s+(public\.)?notes\s*\(\s*shop_id\s*\)/i);
});

test('enables row level security and one select policy for authenticated', () => {
  assert.match(sql, /alter\s+table\s+(public\.)?notes\s+enable\s+row\s+level\s+security/i);
  assert.match(sql, /create\s+policy\b[\s\S]*?\bon\s+(public\.)?notes\b[\s\S]*?\bfor\s+select\b[\s\S]*?\bto\s+authenticated\b/i);
});

test('migration is DDL only', () => {
  assert.doesNotMatch(sql, /\$[a-z_]*\$/i);
  assert.doesNotMatch(sql, /plan\(/i);
  assert.doesNotMatch(sql, /select\s+\*\s+from\s+finish/i);
  assert.doesNotMatch(sql, /insert\s+into/i);
  assert.doesNotMatch(sql, /raise\s+notice/i);
});
