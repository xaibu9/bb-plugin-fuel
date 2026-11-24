// Shared e2e harness: a throwaway bb instance (own data dir and ports, bundled
// plugins only), a bb CLI bound to it, seeded projects/threads and a headless
// Chrome. Nothing here reads or writes the user's own bb data directory.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const run = promisify(execFile);
const BB_APP = process.env.BB_APP_BUNDLE ?? "/Applications/bb.app";
const ELECTRON = join(BB_APP, "Contents/MacOS/bb");
const BB_APP_JS = join(BB_APP, "Contents/Resources/app.asar.unpacked/node_modules/bb-app/dist/bb-app.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

/** Collects pass/fail lines; `finish()` prints them and sets the exit code. */
export function createReport(name) {
  const results = [];
  return {
    check(label, ok, detail = "") {
      results.push({ label, ok: Boolean(ok), detail });
      log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
      return Boolean(ok);
    },
    finish() {
      const failed = results.filter((r) => !r.ok);
      console.log(`\n${name}: ${results.length - failed.length}/${results.length} checks passed`);
      for (const r of failed) console.log(`  FAIL ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
      process.exitCode = failed.length === 0 ? 0 : 1;
      return failed.length === 0;
    },
  };
}

async function freePort(preferred) {
  const tryPort = (port) =>
    new Promise((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(null));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(port)));
    });
  for (let port = preferred; port < preferred + 200; port += 2) {
    if ((await tryPort(port)) !== null && (await tryPort(port + 1)) !== null) return port;
  }
  throw new Error("no free port pair");
}

/** Every process whose command line mentions `needle`, except this one. */
async function processesWith(needle) {
  const { stdout } = await run("ps", ["-axo", "pid=,command="], { maxBuffer: 16 << 20 });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(needle))
    .map((line) => Number(line.split(/\s+/, 1)[0]))
    .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
}

/**
 * Starts bb with its own data dir under a fresh temp folder. `env` is added to
 * the server's environment (plugins run inside it). Returns the instance.
 */
export async function startInstance({ work, env = {}, label = "bb" } = {}) {
  if (!existsSync(BB_APP_JS)) throw new Error(`bb app not found at ${BB_APP}`);
  const dir = work ?? (await mkdtemp("/tmp/bb-e2e-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const port = await freePort(Number(process.env.BB_E2E_PORT ?? 39886));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(
    ELECTRON,
    [BB_APP_JS, "--data-dir", dataDir, "--server-port", String(port), "--host-daemon-port", String(port + 1), "--bundled", "--no-in-app-updates"],
    {
      cwd: dir,
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1", BB_SKIP_ONBOARDING: "1", BB_TELEMETRY: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  for (let i = 0; i < 90; i++) {
    if (/bb is ready/.test(output)) break;
    if (child.exitCode !== null) throw new Error(`bb exited early:\n${output.slice(-2000)}`);
    await sleep(1000);
  }
  if (!/bb is ready/.test(output)) throw new Error(`bb did not start:\n${output.slice(-2000)}`);
  log(`${label}: ${base} data ${dataDir} pid ${child.pid}`);

  const cliEnv = { ...process.env, BB_SERVER_URL: base, BB_HOST_DAEMON_PORT: String(port + 1) };
  for (const key of ["BB_THREAD_ID", "BB_PROJECT_ID", "BB_ENVIRONMENT_ID", "BB_CLI", "BB_THREAD_STORAGE"]) delete cliEnv[key];
  const cli = async (args, { json = false, allowFail = false, timeout = 600_000 } = {}) => {
    try {
      const { stdout } = await run("bb", json ? [...args, "--json"] : args, { env: cliEnv, timeout, maxBuffer: 32 << 20 });
      return json ? JSON.parse(stdout.slice(stdout.search(/[[{]/))) : stdout;
    } catch (cause) {
      if (allowFail) return null;
      throw new Error(`bb ${args.join(" ")} failed: ${cause.stderr || cause.stdout || cause.message}`.slice(0, 2000));
    }
  };

  const stop = async () => {
    if (child.exitCode === null) {
      child.kill("SIGINT");
      for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(500);
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    // Plugin and provider workers carry the data dir in their arguments.
    for (let i = 0; i < 20; i++) {
      const left = await processesWith(dataDir);
      if (left.length === 0) break;
      if (i === 10) for (const pid of left) process.kill(pid, "SIGTERM");
      await sleep(500);
    }
    const left = await processesWith(dataDir);
    for (const pid of left) process.kill(pid, "SIGKILL");
    log(`${label}: stopped${left.length ? ` (${left.length} workers killed)` : ""}`);
  };

  return { dir, dataDir, base, port, cli, stop, output: () => output };
}

/**
 * Copies a plugin checkout into the temp folder (node_modules linked, not copied) and
 * builds it there, so the e2e run never rebuilds the folder a real bb may load the plugin from.
 */
export async function stagePlugin(bb, source) {
  const name = source.replace(/\/+$/, "").split("/").pop();
  const target = join(bb.dir, "plugins-src", name);
  mkdirSync(target, { recursive: true });
  await run("rsync", ["-a", "--exclude", "node_modules", "--exclude", "dist", "--exclude", "e2e/out", "--exclude", ".git", `${source}/`, `${target}/`]);
  await run("ln", ["-s", join(source, "node_modules"), join(target, "node_modules")]);
  await bb.cli(["plugin", "build", target]);
  return target;
}

/** Removes the temp folder and the Claude Code session folders its threads created. */
export function cleanup(dir) {
  const slug = dir.replace(/^\/tmp\//, "/private/tmp/").replace(/[^A-Za-z0-9]/g, "-");
  const sessions = join(homedir(), ".claude", "projects");
  if (existsSync(sessions)) {
    for (const name of readdirSync(sessions)) if (name.startsWith(slug)) rmSync(join(sessions, name), { recursive: true, force: true });
  }
  rmSync(dir, { recursive: true, force: true });
  log(`removed ${dir}`);
}

export const DEMO_TITLES = [
  "Fix flaky login test",
  "Refactor billing webhooks",
  "Write release notes",
  "Investigate slow search",
  "Add dark mode to settings",
  "Review onboarding copy",
  "Migrate cron jobs",
  "Update API docs",
  "Draft Q3 roadmap",
];

/**
 * Creates projects (empty git repos in the temp folder) and threads on Claude
 * Code with the cheapest model and a one-word prompt, so every row ends idle.
 */
export async function seedThreads(bb, { projects = { "web-app": 7, api: 2 }, model = process.env.BB_E2E_MODEL ?? "claude-haiku-4-5-20251001" } = {}) {
  const ids = [];
  let title = 0;
  for (const [name, count] of Object.entries(projects)) {
    const root = join(bb.dir, "projects", name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "README.md"), `# ${name}\n`);
    await run("git", ["init", "-q"], { cwd: root });
    await run("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
    const project = await bb.cli(["project", "create", "--name", name, "--root", root], { json: true });
    for (let i = 0; i < count; i++) {
      const thread = await bb.cli(
        [
          "thread", "spawn", "--project", project.id, "--provider", "claude-code", "--model", model,
          "--permission-mode", "accept-edits", "--title", DEMO_TITLES[title++ % DEMO_TITLES.length],
          "--prompt", "Reply with the single word ok. Do not use any tools.",
        ],
        { json: true },
      );
      ids.push(thread.id);
    }
  }
  for (const id of ids) await bb.cli(["thread", "wait", id, "--timeout", "180"], { allowFail: true });
  log(`seeded ${ids.length} threads`);
  return ids;
}

export const DESKTOP_LAYOUT_CSS = '[data-testid="app-sidebar-top-reserve-row"] div:has(> button[aria-label^="Go back"]){display:none!important}';

/** Headless Chrome page on the instance in light or dark mode. */
export async function openPage(base, { mode = "dark", path = "/", width = 1280, height = 800, locale = "en-US" } = {}) {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: [`--lang=${locale}`] });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: mode, locale });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + path, { waitUntil: "domcontentloaded" });
  // The desktop app draws back/forward in the window title bar; a browser tab puts them next to
  // the New thread button. Screenshots show the desktop layout.
  await page.addStyleTag({ content: DESKTOP_LAYOUT_CSS }).catch(() => {});
  return { browser, page, errors };
}

/** Plugin log lines at warn or error level. */
export async function pluginProblems(bb, id) {
  const text = (await bb.cli(["plugin", "logs", id, "-n", "500"], { allowFail: true })) ?? "";
  return text
    .split("\n")
    .filter((line) => /"level":"(warn|error)"/.test(line));
}

/** Computed color of `var(name)` resolved inside `selector`, as rgb(). */
export async function resolvedColor(page, selector, name) {
  return page.evaluate(
    ([selector, name]) => {
      const host = document.querySelector(selector);
      if (!host) return null;
      const probe = document.createElement("span");
      probe.style.color = `var(${name})`;
      host.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    },
    [selector, name],
  );
}
