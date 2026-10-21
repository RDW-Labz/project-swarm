// SPDX-License-Identifier: Apache-2.0
// Orchestrator context handoff (R-030): measure a Claude Code session transcript on disk against a configurable byte threshold.
// The events log stores only the transcript file name; size is read through resolveTranscript (same roots as orchestrator-usage.mjs).
// Saving state and starting a fresh session are handled elsewhere; this module only measures and compares.
import fs from 'node:fs';
import { resolveTranscript } from './orchestrator-usage.mjs';

/** Default transcript size (bytes) past which the orchestrator should hand off before context gets expensive. */
export const DEFAULT_HANDOFF_TRANSCRIPT_BYTES = 10 * 1024 * 1024;
export const HANDOFF_TRANSCRIPT_BYTES_ENV = 'SWARM_ORCHESTRATOR_HANDOFF_TRANSCRIPT_BYTES';
const MIN_HANDOFF_BYTES = 256 * 1024;
const MAX_HANDOFF_BYTES = 64 * 1024 * 1024;

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseThresholdInt(value) {
  if (!Number.isInteger(value) || value < MIN_HANDOFF_BYTES || value > MAX_HANDOFF_BYTES) return null;
  return value;
}

function parseEnvThreshold(envValue) {
  if (envValue === undefined || envValue === '') return null;
  const n = Number.parseInt(String(envValue), 10);
  return parseThresholdInt(n);
}

/** Validates the profile's `orchestrator` block (optional `handoffTranscriptBytes`). */
export function validateOrchestratorConfig(raw) {
  if (raw === undefined) return { ok: true, config: null, errors: [] };
  if (!isObj(raw)) return { ok: false, config: null, errors: ['orchestrator must be an object'] };
  const errors = [];
  for (const key of Object.keys(raw)) if (key !== 'handoffTranscriptBytes') errors.push(`orchestrator.${key}: unknown key`);
  const config = {};
  if (raw.handoffTranscriptBytes !== undefined) {
    const bytes = parseThresholdInt(raw.handoffTranscriptBytes);
    if (bytes === null) errors.push(`orchestrator.handoffTranscriptBytes must be a whole number ${MIN_HANDOFF_BYTES} to ${MAX_HANDOFF_BYTES}`);
    else config.handoffTranscriptBytes = bytes;
  }
  return errors.length ? { ok: false, config: null, errors } : { ok: true, config: Object.keys(config).length ? config : null, errors: [] };
}

/** Resolved handoff threshold in bytes: explicit option, then env, then profile orchestrator block, then default. */
export function handoffTranscriptBytes({ threshold, orchestrator, config, env = process.env } = {}) {
  const explicit = parseThresholdInt(threshold);
  if (explicit !== null) return explicit;
  const fromEnv = parseEnvThreshold(env[HANDOFF_TRANSCRIPT_BYTES_ENV]);
  if (fromEnv !== null) return fromEnv;
  const block = orchestrator ?? config?.orchestrator;
  if (isObj(block) && block.handoffTranscriptBytes !== undefined) {
    const fromProfile = parseThresholdInt(block.handoffTranscriptBytes);
    if (fromProfile !== null) return fromProfile;
  }
  return DEFAULT_HANDOFF_TRANSCRIPT_BYTES;
}

/** On-disk byte size of an allowed transcript (file name or path), or null when it cannot be resolved or read. */
export function transcriptBytes(name, { statSync = fs.statSync } = {}) {
  const real = resolveTranscript(name);
  if (!real) return null;
  try {
    const size = statSync(real).size;
    return Number.isFinite(size) && size >= 0 ? size : null;
  } catch {
    return null;
  }
}

/**
 * Whether the session transcript has reached the handoff threshold.
 * @returns {{ transcript: string|null, bytes: number|null, threshold: number, over: boolean, handoff: boolean }}
 */
export function contextHandoffOf(transcript, options = {}) {
  const threshold = handoffTranscriptBytes(options);
  const name = typeof transcript === 'string' && transcript ? transcript : null;
  const bytes = name ? transcriptBytes(name, options) : null;
  const over = bytes !== null && bytes >= threshold;
  return { transcript: name, bytes, threshold, over, handoff: over };
}
