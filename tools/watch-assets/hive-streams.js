// SPDX-License-Identifier: Apache-2.0
/** Hive command-center canvas particle streams (card inner edge → central ring). */

export const HIVE_STREAM_FRAME_MS = 1000 / 30;

/** Minimum comet particles maintained on each card→ring link. */
export const HIVE_STREAM_MIN_PARTICLES_PER_LINK = 120;

/**
 * Particle count per stream link scales with active agents on that project:
 *   count = max(MIN, base + perActiveAgent × activeAgents)
 * with base = 120 and perActiveAgent = 10 (see hiveStreamDensityForProject).
 */
export const HIVE_STREAM_DENSITY_BASE = 120;
export const HIVE_STREAM_DENSITY_PER_ACTIVE_AGENT = 10;

/**
 * Particle travel speed (curve parameter t per frame at 30fps) scales with throughput:
 *   speed = min(maxSpeed, baseSpeed + perTicketPerHour × ticketsPerHour)
 * Mockup jitter adds up to speedJitter on spawn (animated path only).
 */
export const HIVE_STREAM_SPEED_BASE = 0.004;
export const HIVE_STREAM_SPEED_PER_TICKET_PER_HOUR = 0.000025;
export const HIVE_STREAM_SPEED_MAX = 0.014;
export const HIVE_STREAM_SPEED_JITTER = 0.006;

export const HIVE_LANE_RGB = {
  safety: [255, 77, 141],
  route: [94, 184, 255],
  context: [61, 214, 165],
  control: [245, 196, 81],
};

export const HIVE_STREAM_RENDER_STATIC = 'static-dots';
export const HIVE_STREAM_RENDER_ANIMATED = 'animated-comets';

/**
 * @param {object} [project]
 * @returns {number}
 */
export function activeAgentCountForProject(project) {
  if (!project || typeof project !== 'object') return 0;
  if (Number.isFinite(project.activeAgents)) return Math.max(0, project.activeAgents);
  if (project.agents && Number.isFinite(project.agents.active)) {
    return Math.max(0, project.agents.active);
  }
  return 0;
}

/**
 * @param {object} [project]
 * @returns {number} Target particle count for one card→ring stream.
 */
export function hiveStreamDensityForProject(project) {
  const agents = activeAgentCountForProject(project);
  const raw = HIVE_STREAM_DENSITY_BASE + HIVE_STREAM_DENSITY_PER_ACTIVE_AGENT * agents;
  return Math.max(HIVE_STREAM_MIN_PARTICLES_PER_LINK, raw);
}

/**
 * @param {number} ticketsPerHour
 * @returns {number} Base particle speed along the bezier (before spawn jitter).
 */
export function hiveStreamSpeedForTicketsPerHour(ticketsPerHour) {
  const tph = Math.max(0, Number(ticketsPerHour) || 0);
  const speed = HIVE_STREAM_SPEED_BASE + HIVE_STREAM_SPEED_PER_TICKET_PER_HOUR * tph;
  return Math.min(HIVE_STREAM_SPEED_MAX, speed);
}

/**
 * Pause the stream animation loop when the page is hidden (Page Visibility).
 * @param {{ hidden?: boolean }} doc
 * @returns {boolean} true when the loop should pause.
 */
export function hiveStreamsPauseWhenDocumentHidden(doc) {
  return Boolean(doc && doc.hidden);
}

/**
 * @param {{ matches?: boolean } | null | undefined} mediaQueryList
 * @returns {boolean}
 */
export function hiveStreamsPrefersReducedMotion(mediaQueryList) {
  return Boolean(mediaQueryList && mediaQueryList.matches);
}

/**
 * @param {{ reducedMotion?: boolean, documentHidden?: boolean, userPaused?: boolean }} opts
 * @returns {'static-dots'|'animated-comets'}
 */
export function hiveStreamsRenderPath(opts = {}) {
  if (opts.reducedMotion || opts.documentHidden || opts.userPaused) {
    return HIVE_STREAM_RENDER_STATIC;
  }
  return HIVE_STREAM_RENDER_ANIMATED;
}

/** Quadratic bezier point (matches hive.html mockup). */
export function bezierPoint(p0, p1, p2, t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

function normalizeLane(lane) {
  if (lane && HIVE_LANE_RGB[lane]) return lane;
  return 'control';
}

/**
 * Card anchor on the inner edge facing the ring (mockup cardAnchor).
 * @param {{ side?: string, box?: { left: number, top: number, right: number, bottom: number, width: number, height: number } }} entry
 * @param {{ phone?: boolean }} geom
 */
export function cardStreamAnchor(entry, geom) {
  const b = entry.box;
  if (!b) return { x: entry.x ?? 0, y: entry.y ?? 0 };
  if (geom.phone) {
    return { x: b.left + b.width / 2, y: b.top };
  }
  if (entry.side === 'left' || entry.node?.side === 'left') {
    return { x: b.right - 2, y: b.top + b.height * 0.5 };
  }
  return { x: b.left + 2, y: b.top + b.height * 0.5 };
}

/**
 * Build one curved stream per project card: { from, ctrl, to, rgb }.
 * @param {Array<{ node?: { lane?: string, side?: string }, side?: string, angle?: number, box?: object, x?: number, y?: number }>} nodeEntries
 * @param {{ cx: number, cy: number, ringR: number, phone?: boolean }} geom
 */
export function buildHiveStreams(nodeEntries, geom) {
  const streams = [];
  for (const entry of nodeEntries || []) {
    const lane = normalizeLane(entry.node?.lane);
    const rgb = HIVE_LANE_RGB[lane];
    const angle = entry.angle ?? 0;
    const ringX = geom.cx + Math.cos(angle) * geom.ringR;
    const ringY = geom.cy + Math.sin(angle) * geom.ringR;
    const from = { x: ringX, y: ringY };
    const to = cardStreamAnchor(
      { side: entry.node?.side ?? entry.side, box: entry.box, x: entry.x, y: entry.y },
      geom,
    );
    if (geom.phone) {
      streams.push({
        from,
        ctrl: {
          x: (from.x + to.x) * 0.5 + (to.x - from.x) * 0.15,
          y: (from.y + to.y) * 0.42,
        },
        to,
        rgb,
        phone: true,
      });
      continue;
    }
    const nx = -(to.y - from.y);
    const ny = to.x - from.x;
    const len = Math.hypot(nx, ny) || 1;
    const bend = Math.min(geom.ringR * 0.45, 72);
    const side = entry.node?.side ?? entry.side;
    streams.push({
      from,
      ctrl: {
        x: (from.x + to.x) / 2 + (nx / len) * bend * (side === 'left' ? -1 : 1),
        y: (from.y + to.y) / 2 + (ny / len) * bend * 0.35,
      },
      to,
      rgb,
      phone: false,
    });
  }
  return streams;
}

/**
 * @param {object} stream
 * @param {number} streamId
 * @param {number} ticketsPerHour
 * @param {() => number} [random]
 */
export function spawnHiveParticle(stream, streamId, ticketsPerHour, random = Math.random) {
  const base = hiveStreamSpeedForTicketsPerHour(ticketsPerHour);
  return {
    stream,
    streamId,
    t: random() * 0.9,
    speed: base + random() * HIVE_STREAM_SPEED_JITTER,
    size: 1.8 + random() * 2.8,
    spark: random() < 0.35,
  };
}

/**
 * Draw static dots along each stream (reduced motion / paused path).
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{ from: object, ctrl: object, to: object, rgb: number[] }>} streams
 */
export function drawHiveStreamStaticDots(ctx, streams) {
  for (let idx = 0; idx < streams.length; idx += 1) {
    const s = streams[idx];
    const rgb = s.rgb;
    const dots = 5;
    for (let d = 0; d < dots; d += 1) {
      const t = 0.12 + (idx % 5) * 0.04 + d * 0.14;
      const pt = bezierPoint(s.from, s.ctrl, s.to, Math.min(0.98, t));
      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.35 + d * 0.1})`;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * One animation frame of comet particles with additive tails (mockup drawStreams).
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<object>} streams
 * @param {Array<object>} particles Mutated in place.
 * @param {number} targetPerStream
 * @param {number} ticketsPerHour
 */
export function advanceAndDrawHiveStreamComets(ctx, streams, particles, targetPerStream, ticketsPerHour) {
  for (let si = 0; si < streams.length; si += 1) {
    let count = 0;
    for (let j = 0; j < particles.length; j += 1) {
      if (particles[j].streamId === si) count += 1;
    }
    const s = streams[si];
    while (count < targetPerStream) {
      particles.push(spawnHiveParticle(s, si, ticketsPerHour));
      count += 1;
    }
  }

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const p = particles[i];
    p.t += p.speed;
    if (p.t > 1) {
      p.t = 0;
      continue;
    }
    const rgb = p.stream.rgb;
    const trailLen = 0.14;
    const steps = 9;
    for (let k = 0; k < steps; k += 1) {
      const t1 = Math.max(0, p.t - (k / steps) * trailLen);
      const t0 = Math.max(0, p.t - ((k + 1) / steps) * trailLen);
      const a = bezierPoint(p.stream.from, p.stream.ctrl, p.stream.to, t0);
      const b = bezierPoint(p.stream.from, p.stream.ctrl, p.stream.to, t1);
      const fade = (1 - k / steps) * 0.55;
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.min(0.14, fade * 0.22)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    const pt = bezierPoint(p.stream.from, p.stream.ctrl, p.stream.to, p.t);
    ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.92)`;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, p.spark ? 1.4 : 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
