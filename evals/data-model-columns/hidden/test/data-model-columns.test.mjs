import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '..', 'supabase', 'migrations', 'data-model-columns.sql');

function load() {
  const text = readFileSync(file, 'utf8');
  return text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
}

function bodyOf(sql, name) {
  const re = /create table (if not exists )?(public\.)?([a-z_]+) ?\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    if (m[3].toLowerCase() !== name) continue;
    const start = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = start; i < sql.length; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') {
        depth--;
        if (depth === 0) return sql.slice(start + 1, i);
      }
    }
  }
  assert.fail('missing create table statement for ' + name);
}

const tables = {
  shops: ['id', 'slug', 'name', 'phone', 'notify_email'],
  staff_users: ['id', 'shop_id', 'auth_user_id', 'role'],
  part_requests: ['id', 'shop_id', 'contact_name', 'contact_phone', 'vehicle_year', 'vehicle_make', 'vehicle_model', 'vin', 'notes', 'status', 'created_at'],
};

for (const [name, cols] of Object.entries(tables)) {
  test('creates ' + name + ' with every listed column', () => {
    const hay = ' ' + bodyOf(load(), name) + ' ';
    for (const col of cols) {
      assert.match(hay, new RegExp('[^a-z_]' + col + '[^a-z_]', 'i'), name + ' is missing column ' + col);
    }
  });
}

test('staff_users and part_requests reference shops', () => {
  const sql = load();
  for (const name of ['staff_users', 'part_requests']) {
    assert.match(bodyOf(sql, name), /references (public\.)?shops/i);
  }
});

test('DDL only: no DO block and no pgTAP plan call', () => {
  const sql = ' ' + load();
  assert.doesNotMatch(sql, /[^a-z_]do +(\$|language)/i);
  assert.doesNotMatch(sql, /[^a-z_]plan *\(/i);
});
