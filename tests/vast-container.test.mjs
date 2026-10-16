// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContainerOffer, rankContainerOffers, containerCreateBody } from '../bench/gpu-bakeoff/vast.mjs';
import { PINNED_IMAGE } from '../tools/gpu.mjs';

const cap = { hours: 4, maxUsd: 15 };
const good = { id: 7, gpu_name: 'RTX PRO 6000 S', num_gpus: 1, rentable: true, verification: 'verified', reliability2: 0.995, dph_total: 1.3, hosting_type: 1 };

const refused = (offer, reason) => assert.throws(() => checkContainerOffer(offer, cap), error => error.message.includes('offer 7 refused') && error.message.includes(reason));

test('a good offer passes with worstUsd 5.2, S and WS names both', () => {
  assert.ok(Math.abs(checkContainerOffer(good, cap).worstUsd - 5.2) < 1e-9);
  assert.ok(Math.abs(checkContainerOffer({ ...good, gpu_name: 'RTX PRO 6000 WS' }, cap).worstUsd - 5.2) < 1e-9);
});

test('unapproved offers are refused with the reason', () => {
  refused({ ...good, gpu_name: 'RTX PRO 6000 Max-Q' }, 'gpu is RTX PRO 6000 Max-Q');
  refused({ ...good, gpu_name: 'RTX PRO 5000' }, 'gpu is RTX PRO 5000');
  refused({ ...good, num_gpus: 2 }, '2 GPUs, want 1');
  refused({ ...good, rentable: false }, 'not rentable now');
  refused({ ...good, verification: 'unverified' }, 'host is unverified, want verified');
  refused({ ...good, verification: 'deverified' }, 'host is deverified, want verified');
  refused({ ...good, reliability2: 0.98 }, 'reliability 0.98 is below 0.99');
  refused({ ...good, reliability2: undefined, reliability: 0.98 }, 'reliability 0.98 is below 0.99');
  refused({ ...good, dph_total: 4 }, 'over 80%');
});

test('reliability falls back to reliability when reliability2 is absent', () => {
  const base = { ...good, reliability2: undefined };
  assert.ok(checkContainerOffer({ ...base, reliability: 0.995 }, cap).worstUsd > 0);
  assert.throws(() => checkContainerOffer({ ...base, reliability: 0.98 }, cap), /reliability 0.98 is below 0.99/);
});

test('rankContainerOffers drops failures, puts datacenter first, sorts by price, does not mutate', () => {
  const offers = [
    { id: 1, gpu_name: 'RTX PRO 6000 S', num_gpus: 1, rentable: true, verification: 'verified', reliability2: 0.995, dph_total: 1.0, hosting_type: 0 },
    { id: 2, gpu_name: 'RTX PRO 6000 S', num_gpus: 1, rentable: true, verification: 'verified', reliability2: 0.995, dph_total: 2.0, hosting_type: 1 },
    { id: 3, gpu_name: 'RTX PRO 6000 S', num_gpus: 1, rentable: true, verification: 'verified', reliability2: 0.995, dph_total: 0.8, hosting_type: 0 },
    { id: 4, gpu_name: 'RTX PRO 6000 S', num_gpus: 1, rentable: true, verification: 'verified', reliability2: 0.995, dph_total: 1.5, hosting_type: 1 },
    { id: 5, gpu_name: 'RTX PRO 6000 S', num_gpus: 1, rentable: false, verification: 'verified', reliability2: 0.995, dph_total: 0.1, hosting_type: 1 },
  ];
  const before = JSON.stringify(offers);
  const ranked = rankContainerOffers(offers);
  assert.deepEqual(ranked.map(offer => offer.id), [4, 2, 3, 1]);
  assert.equal(JSON.stringify(offers), before);
  assert.notEqual(ranked, offers);
});

test('containerCreateBody builds the pinned container body', () => {
  const body = containerCreateBody();
  assert.deepEqual(body, { image: PINNED_IMAGE, disk: 200, runtype: 'ssh_direct', label: 'swarm-bakeoff' });
  assert.equal('vm' in body, false);
  assert.equal('env' in body, false);
  assert.equal('ports' in body, false);
  assert.match(body.image, /@sha256:[0-9a-f]{64}$/);
  assert.equal(body.image.includes(':latest'), false);
  assert.deepEqual(containerCreateBody({ disk: 120, label: 'x' }), { image: PINNED_IMAGE, disk: 120, runtype: 'ssh_direct', label: 'x' });
});
