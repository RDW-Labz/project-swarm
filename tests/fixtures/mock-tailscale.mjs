#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// A pretend `tailscale` for tests. State lives in MOCK_TS_DIR/state.json; every call is appended to MOCK_TS_DIR/calls.jsonl.
// Any `funnel` call exits 99: swarm remote must never run one.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.MOCK_TS_DIR;
const file = path.join(dir, 'state.json');
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify(args)}\n`);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const key = `${state.dns}:`;
const httpsPort = (args.find(a => a.startsWith('--https=')) ?? '').slice(8);

if (args[0] === 'funnel') { process.stderr.write('MOCK: funnel must never be called\n'); process.exit(99); }
if (args[0] === 'status' && args.includes('--json')) {
  process.stdout.write(JSON.stringify({ BackendState: state.backend, Self: { DNSName: `${state.dns}.`, UserID: 7 }, User: { 7: { LoginName: state.login } } }));
} else if (args[0] === 'up') {
  if (state.upFails) process.exit(1);
  state.backend = 'Running'; save();
} else if (args[0] === 'serve' && args[1] === 'status') {
  if (state.statusFails) process.exit(1);
  const Web = {}; const AllowFunnel = {}; const TCP = {};
  for (const [port, target] of Object.entries(state.serve ?? {})) { Web[`${key}${port}`] = { Handlers: { '/': { Proxy: target } } }; TCP[port] = { HTTPS: true }; }
  for (const port of state.funnelPorts ?? []) AllowFunnel[`${key}${port}`] = true;
  for (const [port, target] of Object.entries(state.extraWeb ?? {})) Web[`${key}${port}`] = { Handlers: { '/': { Proxy: target } } };
  for (const port of state.tcpPorts ?? []) TCP[port] = { TCPForward: '127.0.0.1:1' };
  const body = { Web, AllowFunnel, TCP };
  // A foreground funnel (`tailscale funnel 8443` left running) lives under Foreground, not at the top.
  if (state.foregroundFunnel) { body.Foreground = { session1: { AllowFunnel: { [`${key}${state.foregroundFunnel}`]: true } } }; body.AllowFunnel = {}; }
  process.stdout.write(JSON.stringify(body));
} else if (args[0] === 'serve' && args.includes('off')) {
  if (state.offFails) { process.stderr.write('MOCK: serve off failed\n'); process.exit(1); }
  delete state.serve?.[httpsPort]; save();
} else if (args[0] === 'serve' && args.includes('--bg')) {
  if (state.serveFails) { process.stderr.write('Serve is not enabled on your tailnet.\n'); process.exit(1); }
  state.serve = { ...(state.serve ?? {}), [httpsPort]: args.at(-1) };
  if (state.funnelAfterServe) state.funnelPorts = [...(state.funnelPorts ?? []), httpsPort];
  save();
} else process.exit(2);
