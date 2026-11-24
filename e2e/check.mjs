// Fuel BB on a clean bb, the way a new user meets it:
//   1. no Kimi login and Gemini off: only bb's own providers, clear hints;
//      Gemini switched on with no agy: "!" and a hint, nothing crashes;
//   2. Kimi and agy signed in on this machine: their buttons and data appear,
//      account switching stays off;
//   3. with Folio BB: the strip takes the sidebar accent, live; without it, the theme accent.
// Run: npm run e2e   (FOLIO_DIR overrides ../bb-plugin-sidebar-pack; screenshots in e2e/out/)
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, createReport, log, openPage, pluginProblems, resolvedColor, stagePlugin, startInstance } from "./lib.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, "e2e", "out");
const SIDEBAR_PACK = resolve(process.env.FOLIO_DIR ?? process.env.SIDEBAR_PACK_DIR ?? join(ROOT, "..", "bb-plugin-sidebar-pack"));
const report = createReport("fuel-bb e2e");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STRIP = ".lp-strip";

async function shotBottom(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`), clip: { x: 0, y: 0, width: 420, height: 800 } });
}

/** Segment ids on the strip. */
const segments = (page) => page.$$eval(".lp-seg", (els) => els.map((el) => ({ id: el.dataset.section, text: el.textContent?.trim() ?? "" })));

async function waitFor(fn, test, { timeout = 120_000, every = 2000 } = {}) {
  const until = Date.now() + timeout;
  let value = await fn();
  while (!test(value) && Date.now() < until) {
    await sleep(every);
    value = await fn();
  }
  return value;
}

async function openSettings(page) {
  await page.locator(".lp-seg").first().click();
  await page.locator(".lp-gear").first().click();
  await page.waitForSelector(".lp-field", { timeout: 10_000 });
}

/** Server-side lines bb logs when one of the plugin's RPCs throws. */
async function rpcFailures(bb) {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = join(bb.dataDir, "logs");
  return readdirSync(dir)
    .filter((f) => /^server.*\.log$/.test(f))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n"))
    .filter((line) => line.includes("[plugin:fuel-bb]") && /rpc \S+ failed/.test(line));
}

let bb = await startInstance({ label: "clean bb, no Kimi", env: { KIMI_CODE_HOME: "/nonexistent-kimi-home" } });
const work = bb.dir;
try {
  const staged = await stagePlugin(bb, ROOT);
  await bb.cli(["plugin", "install", staged, "--yes"]);
  const usage = await bb.cli(["settings", "usage"], { json: true });
  const bbReady = Object.entries(usage).filter(([, v]) => v?.status === "ok").map(([id]) => id);
  log(`bb reports ready providers: ${bbReady.join(", ") || "none"}`);

  // 1. Empty state.
  {
    const { browser, page, errors } = await openPage(bb.base, { mode: "dark" });
    try {
      await page.waitForSelector(STRIP, { timeout: 60_000 });
      const segs = await waitFor(() => segments(page), (s) => s.length === bbReady.length + 1, { timeout: 60_000 });
      await shotBottom(page, "1-empty-strip");
      report.check("strip shows bb's ready providers plus Context", segs.length === bbReady.length + 1 && segs.at(-1)?.id === "context", JSON.stringify(segs));
      report.check("no Kimi button without a Kimi login", !segs.some((s) => s.id === "kimi-code"));
      report.check("no Gemini button until it is turned on", !segs.some((s) => s.id === "gemini"));
      await openSettings(page);
      await shotBottom(page, "1-empty-settings");
      const listed = await page.$$eval(".lp-field:first-of-type .lp-check", (els) => els.length);
      report.check("settings list every provider bb found", listed === Object.keys(usage).length, `${listed} rows for ${Object.keys(usage).length} providers`);
      const geminiHint = await page.locator(".lp-field", { hasText: /Read by the plugin|Плагин читает сам/ }).innerText();
      report.check("Gemini is off with a hint on how it would be read", /agy/.test(geminiHint), geminiHint.replace(/\s+/g, " ").slice(0, 120));
      report.check("no page errors (empty state)", errors.length === 0, errors.slice(0, 3).join(" | "));
    } finally {
      await browser.close();
    }
    const accounts = await bb.cli(["fuel", "accounts", "--json"], { allowFail: true });
    report.check("account switching is off by default", accounts !== null && JSON.parse(accounts).enabled === false);
  }

  // 1b. Gemini on without agy: "!" and a hint.
  await bb.cli(["plugin", "config", "fuel-bb", "set", "agyPath", "/nonexistent/agy"]);
  {
    const { browser, page, errors } = await openPage(bb.base, { mode: "dark" });
    try {
      await page.waitForSelector(STRIP, { timeout: 60_000 });
      await openSettings(page);
      await page.locator(".lp-check", { hasText: "Gemini" }).locator("input").check();
      const gem = await waitFor(() => segments(page).then((s) => s.find((x) => x.id === "gemini")), (g) => g?.text.includes("!"), { timeout: 60_000 });
      report.check("Gemini without agy shows '!' on the strip", Boolean(gem?.text.includes("!")), JSON.stringify(gem));
      await page.keyboard.press("Escape");
      await page.locator('.lp-seg[data-section="gemini"]').click();
      await page.waitForTimeout(1000);
      await shotBottom(page, "1-gemini-no-agy");
      const text = await page.locator(".lp-pop").innerText();
      report.check("Gemini popover says agy was not found and offers Check again", /agy/.test(text) && /(Check again|Проверить снова)/.test(text), text.replace(/\s+/g, " ").slice(0, 160));
      report.check("no page errors (no agy)", errors.length === 0, errors.slice(0, 3).join(" | "));
    } finally {
      await browser.close();
    }
  }
  const failures1 = await rpcFailures(bb);
  report.check("no failed plugin RPCs logged by bb (phase 1)", failures1.length === 0, failures1.slice(0, 2).join(" | "));
  await bb.stop();

  // 2. Kimi and agy as installed on this machine.
  bb = await startInstance({ work, label: "clean bb, Kimi + agy" });
  await bb.cli(["plugin", "config", "fuel-bb", "unset", "agyPath"]);
  {
    const { browser, page, errors } = await openPage(bb.base, { mode: "dark" });
    try {
      await page.waitForSelector(STRIP, { timeout: 60_000 });
      await bb.cli(["fuel", "status", "--refresh"], { timeout: 180_000 });
      const segs = await waitFor(
        () => segments(page),
        (s) => s.some((x) => x.id === "kimi-code") && s.some((x) => x.id === "gemini" && /\d+%/.test(x.text)),
        { timeout: 180_000 },
      );
      await shotBottom(page, "2-strip-kimi-gemini");
      report.check("Kimi button appears once the kimi CLI is signed in (numbers, or '–' until kimi refreshes its token)", segs.some((s) => s.id === "kimi-code"), JSON.stringify(segs));
      report.check("Gemini shows a percent read through agy", segs.some((s) => s.id === "gemini" && /\d+%/.test(s.text)), JSON.stringify(segs.find((s) => s.id === "gemini")));
      await page.locator('.lp-seg[data-section="gemini"]').click();
      await page.waitForTimeout(1000);
      await shotBottom(page, "2-gemini-popover");
      report.check("Gemini popover has no account list while switching is off", (await page.locator(".lp-pop .lp-accounts").count()) === 0);
      const pop = await page.locator(".lp-pop").innerText();
      report.check("Gemini popover labels the source and the measurement time", /(via agy|через agy)/.test(pop) && /(Measured|Замер)/.test(pop), pop.replace(/\s+/g, " ").slice(0, 160));
      report.check("Gemini popover says used, not left", !/(left|осталось)/i.test(pop));
      report.check("no page errors (Kimi + agy)", errors.length === 0, errors.slice(0, 3).join(" | "));
    } finally {
      await browser.close();
    }
    const accounts = JSON.parse((await bb.cli(["fuel", "accounts", "--json"])) ?? "{}");
    report.check("account switching is still off", accounts.enabled === false);
  }

  // 3. Shared accent with Folio BB.
  if (existsSync(join(SIDEBAR_PACK, "package.json"))) {
    await bb.cli(["theme", "set", "default"]);
    await bb.cli(["plugin", "install", await stagePlugin(bb, SIDEBAR_PACK), "--yes"]);
    await bb.cli(["plugin", "config", "folio-bb", "set", "accent", "#ff8800"]);
    const { browser, page } = await openPage(bb.base, { mode: "dark" });
    try {
      await page.waitForSelector(STRIP, { timeout: 60_000 });
      const first = await waitFor(() => resolvedColor(page, STRIP, "--lp-accent"), (c) => c === "rgb(255, 136, 0)", { timeout: 30_000, every: 1000 });
      report.check("the strip takes the sidebar's custom accent", first === "rgb(255, 136, 0)", first ?? "no strip");
      await bb.cli(["plugin", "config", "folio-bb", "set", "accent", "#7aa2f7"]);
      const live = await waitFor(() => resolvedColor(page, STRIP, "--lp-accent"), (c) => c === "rgb(122, 162, 247)", { timeout: 30_000, every: 1000 });
      report.check("changing the sidebar accent recolors the strip without a reload", live === "rgb(122, 162, 247)", live ?? "");
      await shotBottom(page, "3-shared-accent");
    } finally {
      await browser.close();
    }
    await bb.cli(["plugin", "remove", "folio-bb", "--yes"]);
    const { browser: b2, page: p2 } = await openPage(bb.base, { mode: "dark" });
    try {
      await p2.waitForSelector(STRIP, { timeout: 60_000 });
      await p2.waitForTimeout(2000);
      const accent = await resolvedColor(p2, STRIP, "--lp-accent");
      const primary = await resolvedColor(p2, STRIP, "--primary");
      report.check("without Folio BB the strip uses the theme accent", accent === primary, `${accent} vs ${primary}`);
    } finally {
      await b2.close();
    }
  } else {
    log(`skip shared-accent checks: no Folio BB at ${SIDEBAR_PACK}`);
  }

  const failures2 = await rpcFailures(bb);
  report.check("no failed plugin RPCs logged by bb (phase 2)", failures2.length === 0, failures2.slice(0, 2).join(" | "));
  const problems = (await pluginProblems(bb, "fuel-bb")).filter((line) => !/gemini: agy not found/.test(line));
  report.check("fuel-bb log has no unexpected warnings or errors", problems.length === 0, problems.slice(0, 3).join(" | "));
} catch (cause) {
  report.check("run completed", false, cause instanceof Error ? cause.message : String(cause));
} finally {
  await bb.stop();
  if (!process.env.BB_E2E_KEEP) cleanup(work);
  log(`screenshots: ${OUT}`);
  report.finish();
}
