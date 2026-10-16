// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContainerOffer, rankContainerOffers, containerCreateBody } from '../bench/gpu-bakeoff/vast.mjs';
import { PINNED_IMAGE } from '../tools/gpu.mjs';

const cap = { hours: 4, maxUsd: 15 };
const good = { id: 7, gpu_name: 'RTX PRO 6000 S', num_gpus: 1, rentable: true, verification: 'verified', reliability2: 0.995, dph_total: 1.3, hosting_type: 1, pci_gen: 5, pcie_bw: 50, cpu_cores_effective: 32, cpu_ram: 131072, disk_space: 500, disk_name: 'nvme0n1', disk_bw: 3000 };

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

test('hardware thresholds refuse offers below PCIe Gen5, 16 vCPU, 64 GB RAM, 200 GB disk and NVMe', () => {
  refused({ ...good, pci_gen: 4 }, 'PCIe is Gen 4');
  refused({ ...good, pcie_bw: 30 }, 'want Gen5 x16 at 45 GB/s or more');
  refused({ ...good, cpu_cores_effective: 8 }, '8 vCPU, want 16 or more');
  refused({ ...good, cpu_ram: 32768 }, 'RAM is 32 GB, want 64 GB or more');
  refused({ ...good, disk_space: 100 }, '100 GB disk available, want 200 GB or more');
  refused({ ...good, disk_name: 'sata-ssd', disk_bw: 500 }, 'disk is not NVMe');
  assert.ok(checkContainerOffer({ ...good, disk_name: 'sata-ssd', disk_bw: 2000 }, cap).worstUsd > 0);
});

test('reliability falls back to reliability when reliability2 is absent', () => {
  const base = { ...good, reliability2: undefined };
  assert.ok(checkContainerOffer({ ...base, reliability: 0.995 }, cap).worstUsd > 0);
  assert.throws(() => checkContainerOffer({ ...base, reliability: 0.98 }, cap), /reliability 0.98 is below 0.99/);
});

test('rankContainerOffers drops failures, puts datacenter first, sorts by price, does not mutate', () => {
  const offers = [
    { ...good, id: 1, dph_total: 1.0, hosting_type: 0 },
    { ...good, id: 2, dph_total: 2.0, hosting_type: 1 },
    { ...good, id: 3, dph_total: 0.8, hosting_type: 0 },
    { ...good, id: 4, dph_total: 1.5, hosting_type: 1 },
    { ...good, id: 5, rentable: false, dph_total: 0.1, hosting_type: 1 },
    { ...good, id: 6, pci_gen: 4, dph_total: 0.2, hosting_type: 1 },
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
