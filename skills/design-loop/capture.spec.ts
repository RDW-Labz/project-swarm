import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

type Screen = { name: string; url_or_selector: string; widths: number[] };
type LoopConfig = {
  target: string;
  screens: Screen[];
  motion?: boolean | { screen: string };
  out: string;
};

const configPath = process.env.LOOP_CONFIG ?? './loop.config.json';
const round = process.env.ROUND ?? '0';
const cfg: LoopConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const outDir = path.resolve(path.dirname(configPath), cfg.out, `round-${round}`);
fs.mkdirSync(outDir, { recursive: true });

const STRIP_MS = [0, 100, 200, 400, 800, 1200];
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

function isUrl(value: string) {
  return /^https?:\/\//i.test(value) || value.startsWith('file://');
}

async function settle(page: import('@playwright/test').Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2500);
}

test('design-loop capture', async ({ browser }) => {
  const axeReport: Record<string, unknown> = {};
  const checks: Record<string, unknown> = {
    fonts: {},
    overflow: {},
    moneyWithoutSeparator: null,
    reducedMotionRunningAnimations: null,
  };

  const targetUrl = isUrl(cfg.target) ? cfg.target : `file://${path.resolve(path.dirname(configPath), cfg.target)}`;
  const motionScreen = typeof cfg.motion === 'object' && cfg.motion?.screen
    ? cfg.motion.screen
    : cfg.screens[0]?.name;

  for (const screen of cfg.screens) {
    const minWidth = Math.min(...screen.widths);
    for (const width of screen.widths) {
      const page = await browser.newPage({ viewport: { width, height: 1200 } });
      await page.goto(targetUrl, { waitUntil: 'networkidle' });
      await settle(page);
      const locator = isUrl(screen.url_or_selector)
        ? page
        : page.locator(screen.url_or_selector.startsWith('#') || screen.url_or_selector.startsWith('.')
          ? screen.url_or_selector
          : `#${screen.url_or_selector}`);
      const file = path.join(outDir, `${screen.name}-${width}.png`);
      if (isUrl(screen.url_or_selector)) await page.screenshot({ path: file, animations: 'disabled' });
      else await locator.first().screenshot({ path: file, animations: 'disabled' });
      await page.close();
    }

    const page = await browser.newPage({ viewport: { width: minWidth, height: 1200 } });
    await page.goto(targetUrl, { waitUntil: 'networkidle' });
    await settle(page);
    const root = isUrl(screen.url_or_selector) ? page : page.locator(screen.url_or_selector.startsWith('#') ? screen.url_or_selector : `#${screen.url_or_selector}`).first();
    await page.addScriptTag({ content: AXE });
    const axeResult = await page.evaluate(async (selector) => {
      const target = selector === 'page' ? undefined : selector;
      const res = await (window as unknown as { axe: { run: (t?: string, o?: object) => Promise<{ violations: { nodes: unknown[] }[]; passes: { nodes: unknown[] }[] }> } }).axe.run(target, { runOnly: ['color-contrast'] });
      const nodes = res.violations.flatMap(v => v.nodes as { any?: { data?: { contrastRatio?: number; fgColor?: string; bgColor?: string } }[]; target: string[] }[]);
      const ratios = nodes.map(n => n.any?.[0]?.data?.contrastRatio).filter(Boolean) as number[];
      return {
        violations: nodes.length,
        passes: res.passes.flatMap(p => p.nodes).length,
        worst: ratios.length ? Math.min(...ratios) : null,
        samples: nodes.slice(0, 5).map(n => ({
          t: n.target.join(' ').slice(0, 80),
          ratio: n.any?.[0]?.data?.contrastRatio,
          fg: n.any?.[0]?.data?.fgColor,
          bg: n.any?.[0]?.data?.bgColor,
        })),
      };
    }, isUrl(screen.url_or_selector) ? 'page' : (screen.url_or_selector.startsWith('#') ? screen.url_or_selector : `#${screen.url_or_selector}`));
    axeReport[screen.name] = axeResult;

    const overflow = await page.evaluate((selector) => {
      const el = selector === 'page'
        ? document.documentElement
        : document.querySelector(selector.startsWith('#') || selector.startsWith('.') ? selector : `#${selector}`);
      if (!el) return { scrollW: 0, clientW: 0 };
      return { scrollW: el.scrollWidth, clientW: el.clientWidth };
    }, isUrl(screen.url_or_selector) ? 'page' : screen.url_or_selector);
    checks.overflow[screen.name] = overflow;

    if (screen === cfg.screens[0]) {
      checks.fonts = await page.evaluate(() => {
        const fams: Record<string, string[]> = {};
        for (const f of document.fonts) {
          const family = f.family.replace(/"/g, '');
          fams[family] = (fams[family] ?? []).concat(f.status);
        }
        const h = document.querySelector('h1, h2');
        const display = h ? getComputedStyle(h).fontFamily : '';
        const loadedFamilies = Object.entries(fams).filter(([, s]) => s.includes('loaded')).map(([f]) => f);
        const want = (display.split(',')[0] ?? '').replace(/["']/g, '').trim();
        return { faces: fams, display, wanted: [want], loaded: loadedFamilies, ok: want ? loadedFamilies.includes(want) : true };
      });
      const text = await page.evaluate(() => document.body.innerText);
      checks.moneyWithoutSeparator = /\$\d{4,}(?![\d,])/.test(text);
    }
    await page.close();
  }

  if (cfg.motion) {
    const ctx = await browser.newContext({ viewport: { width: 1560, height: 1200 } });
    const page = await ctx.newPage();
    await page.goto(targetUrl, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const motionSel = `#${motionScreen}`;
    await page.locator(motionSel).scrollIntoViewIfNeeded();
    await page.reload({ waitUntil: 'domcontentloaded' });
    const t0 = Date.now();
    for (const t of STRIP_MS) {
      const wait = t - (Date.now() - t0);
      if (wait > 0) await page.waitForTimeout(wait);
      await page.locator(motionSel).screenshot({ path: path.join(outDir, `strip-${String(t).padStart(4, '0')}ms.png`) });
    }
    await ctx.close();

    const rctx = await browser.newContext({ viewport: { width: 1560, height: 1200 }, reducedMotion: 'reduce' });
    const rpage = await rctx.newPage();
    await rpage.goto(targetUrl, { waitUntil: 'networkidle' });
    await rpage.waitForTimeout(150);
    await rpage.locator(`#${motionScreen}`).screenshot({ path: path.join(outDir, `reduced-${motionScreen}.png`) });
    checks.reducedMotionRunningAnimations = await rpage.evaluate(() =>
      document.getAnimations().filter(a => a.playState === 'running' && (a.effect?.getTiming?.().duration || 0) > 0 && (a.effect?.getTiming?.().iterations !== 0)).length,
    );
    await rctx.close();
  }

  fs.writeFileSync(path.join(outDir, 'axe.json'), JSON.stringify(axeReport, null, 2));
  fs.writeFileSync(path.join(outDir, 'checks.json'), JSON.stringify(checks, null, 2));
});
