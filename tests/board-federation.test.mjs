// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contract = JSON.parse(readFileSync(new URL('../contracts/watch-s4-ops.json', import.meta.url), 'utf8'));
const schemas = contract.components.schemas;

test('AC1: the board snapshot carries projects and orchestrators from every federated machine', () => {
  const snap = schemas.BoardSnapshot.properties;
  assert.equal(snap.machines.type, 'array');
  assert.equal(snap.machines.items.$ref, '#/components/schemas/FederatedMachine');
  assert.equal(snap.federation.$ref, '#/components/schemas/Federation');
  assert.equal(schemas.FederatedMachine.properties.projects.items.$ref, '#/components/schemas/ProjectOverview');
});

test('AC1: the federation view lists machines and peers on one board', () => {
  const fed = schemas.Federation;
  assert.deepEqual(fed.required, ['machines', 'drift', 'peers']);
  assert.equal(fed.properties.machines.items.$ref, '#/components/schemas/FederatedMachine');
  assert.equal(fed.properties.peers.items.$ref, '#/components/schemas/FederatedPeer');
});

test('AC2: each federated machine card carries its machine name and swarm version', () => {
  const machine = schemas.FederatedMachine;
  assert.ok(machine.required.includes('name'));
  assert.ok(machine.required.includes('version'));
  assert.deepEqual(machine.properties.version.type, ['string', 'null']);
});

test('AC2: version drift is a flagged field on each federated machine', () => {
  assert.equal(schemas.FederatedMachine.properties.drift.$ref, '#/components/schemas/Drift');
  assert.ok(schemas.Drift.required.includes('present'));
  assert.equal(schemas.Drift.properties.present.type, 'boolean');
  assert.ok(schemas.Drift.properties.fields);
});

test('AC2: the board snapshot reports this server version so drift can be compared', () => {
  assert.equal(schemas.BoardSnapshot.properties.server.type, 'object');
  assert.equal(contract.paths['/api/board'].get.responses['200'].$ref, '#/components/responses/BoardSnapshot');
});
