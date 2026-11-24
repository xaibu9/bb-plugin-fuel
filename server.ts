// Fuel BB backend: polls every provider bb reports usage for, the
// Antigravity Gemini quota every 2 minutes, reads the open thread's context
// fill and compacts on request.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ACCOUNTS_TAG, contract, GEMINI_ID, LIMITS_TAG, PREFS_TAG, prefsSchema, type Prefs, type ProviderLimits, THEME_ACCENT, threadTag, type Forecast, type LimitWindow, type Limits, type ThreadContext } from "./src/shared/contract";
import { mkdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AccountError, createAccounts } from "./src/server/accounts";
import { agyPath, readGeminiQuota } from "./src/server/gemini";
import { readKimiQuota } from "./src/server/kimi";

const POLL_CRON = "*/2 * * * *";
const THREAD_INVALIDATE_MIN_MS = 2_000;
const IDLE_STATUSES = new Set(["idle", "error"]);

const FORECAST_PLUGIN = "usage-forecast";
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** While an Antigravity thread is answering, agy is asked at most this often. */
const GEMINI_ACTIVE_INTERVAL_MS = 5 * 60_000;
const GEMINI_BACKGROUND_MS = { off: null, "30m": 30 * 60_000, "1h": 60 * 60_000 } as const;
const AGY_PROVIDER_ID = "acp-antigravity";
const WORKING_THREAD_STATUSES = new Set(["active", "starting"]);

const projectionSchema = z.object({ projectedPercent: z.number(), runOutAt: z.number().nullable() }).nullable().catch(null);
const forecastSnapshotSchema = z.object({
  hosts: z.array(
    z.object({
      primary: z.boolean().catch(false),
      providers: z.array(
        z.object({
          providerId: z.string(),
          windows: z.array(
            z.object({
              label: z.string(),
              forecast: z
                .object({
                  status: z.string(),
                  current: projectionSchema,
                  learned: projectionSchema,
                  main: z.enum(["current", "learned"]).nullable().catch(null),
                })
                .nullable()
                .catch(null),
            }),
          ),
        }),
      ),
    }),
  ),
});
type ForecastSnapshot = z.infer<typeof forecastSnapshotSchema>;

const KIMI_ID = "kimi-code";
/** Message of a Kimi entry that has a login but no measurement yet. */
const KIMI_WAITING = "waiting for the next kimi run";
const PREFS_KEY = "prefs";
const OLD_DEFAULT_ACCENT = "#b795f3";
const PROVIDER_STATUSES = new Set(["ok", "not_installed", "unauthenticated", "expired", "error"]);

function windowLabel(w: { label?: unknown; kind?: unknown; model?: unknown }): string {
  const label = typeof w.label === "string" ? w.label : "";
  if (label === "Weekly limit" || (w.kind === "weekly" && w.model == null)) return "week_all";
  if (typeof w.model === "string" && w.model !== "") return `week_model:${w.model[0].toUpperCase()}${w.model.slice(1)}`;
  if (/session|5.?h/i.test(label) || w.kind === "session") return "5h";
  return label || "limit";
}

function forecastFor(snapshot: ForecastSnapshot | null, providerId: string, label: unknown, usedPercent: number, resetsAt: number | null): Forecast | null {
  const hosts = snapshot?.hosts ?? [];
  const host = hosts.find((h) => h.primary) ?? hosts[0];
  const f = host?.providers.find((p) => p.providerId === providerId)?.windows.find((w) => w.label === label)?.forecast;
  if (f == null) return null;
  if (f.status === "hit") return { lasts: false, projectedPercent: usedPercent, runOutAt: null };
  const p = (f.main === "learned" ? f.learned : f.current) ?? f.current ?? f.learned;
  if (p === null) return null;
  const lasts = p.runOutAt === null || (resetsAt !== null && p.runOutAt >= resetsAt);
  return { lasts, projectedPercent: p.projectedPercent, runOutAt: lasts ? null : p.runOutAt };
}

/** Every provider in `system.usageLimits`; window labels are keys the app translates. Account fields are never read. */
export function parseProviders(answer: unknown, snapshot: ForecastSnapshot | null): ProviderLimits[] {
  if (answer === null || typeof answer !== "object") return [];
  return Object.entries(answer as Record<string, unknown>).flatMap(([id, value]): ProviderLimits[] => {
    const entry = value as { status?: unknown; windows?: unknown; plan?: unknown; planLabel?: unknown; message?: unknown } | null;
    const status = typeof entry?.status === "string" && PROVIDER_STATUSES.has(entry.status) ? (entry.status as ProviderLimits["status"]) : "error";
    const raw = status === "ok" && Array.isArray(entry?.windows) ? (entry.windows as Array<Record<string, unknown>>) : [];
    const windows: LimitWindow[] = raw.flatMap((w) => {
      if (typeof w?.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) return [];
      const at = typeof w.resetsAt === "string" ? Date.parse(w.resetsAt) : typeof w.resetsAt === "number" ? w.resetsAt : NaN;
      const resetsAt = Number.isFinite(at) ? at : null;
      return [{ label: windowLabel(w), usedPercent: w.usedPercent, resetsAt, forecast: forecastFor(snapshot, id, w.label, w.usedPercent, resetsAt) }];
    });
    const planRaw = (entry?.plan as { label?: unknown } | null | undefined)?.label ?? entry?.planLabel;
    return [
      {
        id,
        status,
        plan: typeof planRaw === "string" ? planRaw : null,
        windows,
        message: typeof entry?.message === "string" ? entry.message.slice(0, 200) : null,
        source: "bb",
        measuredAt: null,
      },
    ];
  });
}

/** Settings saved by 0.1 (fixed claude/gemini/kimi keys, a hex accent default). */
export function migratePrefs(raw: unknown): unknown {
  const old = raw as { show?: Record<string, unknown>; accent?: unknown; lang?: unknown } | null | undefined;
  // Only the 0.1 shape: fixed keys. New prefs pass through, so a picked #b795f3 stays.
  if (old == null || typeof old !== "object" || old.show == null || !("claude" in old.show || "kimi" in old.show)) return raw;
  const renames: Record<string, string> = { claude: "claude-code", kimi: KIMI_ID };
  const show = Object.fromEntries(Object.entries(old.show).map(([key, value]) => [renames[key] ?? key, value]));
  const accent = typeof old.accent === "string" && old.accent.toLowerCase() === OLD_DEFAULT_ACCENT ? THEME_ACCENT : old.accent;
  return { ...old, show, accent };
}

export function parseContext(threadId: string, info: unknown, answer: unknown): ThreadContext {
  const status = (info as { status?: unknown } | null)?.status;
  const active = typeof status === "string" && !IDLE_STATUSES.has(status);
  const usage = (answer as { usage?: Record<string, unknown> } | null)?.usage;
  const snapshot = usage?.snapshot as Record<string, unknown> | null | undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const used = num(snapshot?.usedTokens) ?? num(usage?.usedTokens);
  const limit = num(snapshot?.autoCompactAtTokens) ?? num(snapshot?.contextWindowTokens) ?? num(usage?.modelContextWindow);
  return {
    threadId,
    active,
    context:
      used !== null && limit !== null
        ? { usedTokens: used, limitTokens: limit, percent: (used / limit) * 100, model: typeof snapshot?.model === "string" ? snapshot.model : null }
        : null,
  };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    accountSwitching: {
      type: "boolean",
      label:
        "Antigravity account switching — Off by default. When on, the plugin copies the Antigravity (agy) Google sign-in stored in the macOS Keychain into its own Keychain items, swaps it on switch, and restarts Antigravity threads.",
      default: false,
    },
    geminiBackground: {
      type: "select",
      label: "Gemini background check",
      description: "agy is also asked this often when no Antigravity thread works, for quota spent outside bb (the Antigravity app, the web, another computer).",
      options: ["off", "30m", "1h"],
      experimental_optionLabels: { off: "Off", "30m": "Every 30 minutes", "1h": "Once an hour" },
      default: "30m",
    },
    agyPath: {
      type: "string",
      label: "Path to the agy CLI — Leave empty to look for agy on PATH and in the usual install folders.",
      experimental_schema: z.string().max(500),
      default: "",
    },
  });
  const switchingOn = async () => (await settings.get()).accountSwitching;

  // One-time import from the plugin's earlier id (Limits Panel): strip settings and the saved
  // account list (ids, labels, emails; the logins themselves stay in the Keychain). Retried on
  // each start until the old plugin answers; absent, it costs one failed local call.
  const LEGACY_ID = "limits-panel";
  const LEGACY_DONE = "legacy-import-v1";
  const ACCOUNT_INDEX = "gemini-accounts";
  const legacyAccounts = z.object({
    accounts: z.array(z.object({ id: z.string(), label: z.string(), email: z.string().nullable(), savedAt: z.number() })),
  });
  const importLegacy = async () => {
    if ((await bb.storage.kv.get(LEGACY_DONE).catch(() => undefined)) !== undefined) return;
    const call = <T>(method: string, outputSchema: z.ZodType<T>) =>
      bb.sdk.plugins.callRpc({ pluginId: LEGACY_ID, method, input: null, outputSchema }).catch(() => null);
    const prefs = await call("prefs", z.unknown());
    const accounts = await call("accounts", legacyAccounts.passthrough());
    if (prefs === null && accounts === null) return;
    const parsed = prefsSchema.safeParse(migratePrefs(prefs));
    if (parsed.success && (await bb.storage.kv.get(PREFS_KEY).catch(() => undefined)) === undefined) await bb.storage.kv.set(PREFS_KEY, parsed.data);
    if (accounts !== null && accounts.accounts.length > 0 && (await bb.storage.kv.get(ACCOUNT_INDEX).catch(() => undefined)) === undefined) {
      await bb.storage.kv.set(ACCOUNT_INDEX, accounts.accounts);
    }
    await bb.storage.kv.set(LEGACY_DONE, Date.now());
    bb.log.info(`imported settings from ${LEGACY_ID}: prefs ${parsed.success ? "yes" : "no"}, accounts ${accounts?.accounts.length ?? 0}`);
  };
  const legacyReady = importLegacy().catch((cause: unknown) => bb.log.warn(`legacy import failed (${cause instanceof Error ? cause.name : "Error"})`));
  const agy = async () => agyPath((await settings.get()).agyPath);

  let limits: Limits = {
    polledAt: null,
    providers: [],
    providersError: "not polled yet",
    gemini: { status: "off", groups: [], measuredAt: null, error: null, supported: process.platform === "darwin" },
  };
  let polling: Promise<void> | null = null;
  let lastGeminiReason: string | null = null;

  // agy /usage takes ~10 s, so Gemini is re-read at most every 5 minutes unless forced.
  // agy runs only while Gemini is in use: every 5 minutes while an Antigravity thread answers,
  // once when one finishes a turn, when the popover opens on an old measurement, and on the
  // optional background interval. Reads go through the single-flight poll, never in parallel.
  let geminiReadAt = 0;
  let forceGemini: string | null = null;
  const agyWorking = new Set<string>();
  const providerOf = new Map<string, string>();
  const geminiDue = async (): Promise<string | null> => {
    if (forceGemini !== null) return forceGemini;
    const last = limits.gemini;
    if (last.status === "off" || last.status === "pending") return "first read";
    const age = Date.now() - geminiReadAt;
    if (agyWorking.size > 0 && age >= GEMINI_ACTIVE_INTERVAL_MS) return "antigravity thread working";
    const background = GEMINI_BACKGROUND_MS[(await settings.get()).geminiBackground as keyof typeof GEMINI_BACKGROUND_MS] ?? null;
    if (background !== null && age >= background) return "background check";
    return null;
  };
  const nextGemini = async (): Promise<Limits["gemini"]> => {
    const last = limits.gemini;
    const reason = await geminiDue();
    if (reason === null) return last;
    forceGemini = null;
    geminiReadAt = Date.now();
    bb.log.info(`gemini: reading through agy (${reason})`);
    const read = await readGeminiQuota(await agy());
    return read.ok
      ? { ...last, status: "ok", groups: read.groups, measuredAt: Date.now(), error: null }
      : { ...last, status: "error", error: { code: read.code, message: read.reason } };
  };
  // A poll already running may have read Gemini before the force: poll once more then.
  const refreshAll = async (reason = "requested") => {
    forceGemini = reason;
    await poll();
    if (forceGemini !== null) await poll();
  };
  /** Tracks which Antigravity threads are answering; a finished turn triggers one read. */
  const trackAgy = async (threadId: string) => {
    let provider = providerOf.get(threadId);
    const thread = (await bb.sdk.threads.get({ threadId }).catch(() => null)) as { providerId?: string; status?: string } | null;
    if (thread === null) return;
    provider = thread.providerId ?? "";
    providerOf.set(threadId, provider);
    if (provider !== AGY_PROVIDER_ID) return;
    const working = WORKING_THREAD_STATUSES.has(thread.status ?? "");
    if (working) agyWorking.add(threadId);
    else if (agyWorking.delete(threadId) && (await storedShow())?.[GEMINI_ID] === true) void refreshAll("antigravity turn finished").catch(() => undefined);
  };
  void bb.sdk.threads
    .list({ limit: 500 })
    .then((threads) => {
      for (const t of threads as Array<{ id: string; providerId?: string | null; status?: string }>) {
        providerOf.set(t.id, t.providerId ?? "");
        if (t.providerId === AGY_PROVIDER_ID && WORKING_THREAD_STATUSES.has(t.status ?? "")) agyWorking.add(t.id);
      }
    })
    .catch(() => undefined);
  // Kimi's access token lives 15 minutes and only kimi refreshes it; between
  // runs the last measured windows are shown (quota only moves while kimi works).
  const KIMI_KEY = "kimi-last";
  // Used only when bb itself has no Kimi usage (its kimi-code provider not signed in).
  const kimiQuota = async (): Promise<ProviderLimits | null> => {
    const read = await readKimiQuota();
    const entry = (windows: LimitWindow[], measuredAt: number): ProviderLimits => ({
      id: KIMI_ID,
      status: "ok",
      plan: null,
      windows,
      message: null,
      source: "plugin",
      measuredAt,
    });
    if (read.kind === "ok") {
      const last = { windows: read.windows, measuredAt: Date.now() };
      await bb.storage.kv.set(KIMI_KEY, last).catch(() => undefined);
      return entry(last.windows, last.measuredAt);
    }
    if (read.kind === "signedOut") return null;
    if (read.kind === "error") bb.log.warn(`kimi: ${read.reason}`);
    const last = await bb.storage.kv.get<{ windows: LimitWindow[]; measuredAt: number }>(KIMI_KEY).catch(() => undefined);
    // Signed in, but the 15-minute token has lapsed and nothing was measured yet: show the button, numbers come with the next kimi run.
    if (last === undefined) return read.kind === "expired" ? { ...entry([], 0), measuredAt: null, message: KIMI_WAITING } : null;
    const now = Date.now();
    return entry(
      last.windows.map((w) => (w.resetsAt !== null && w.resetsAt <= now ? { ...w, usedPercent: 0, resetsAt: null } : w)),
      last.measuredAt,
    );
  };
  const withKimi = async (providers: ProviderLimits[]): Promise<ProviderLimits[]> => {
    const fromBb = providers.find((p) => p.id === KIMI_ID);
    if (fromBb?.status === "ok" || (await storedShow())?.[KIMI_ID] === false) return providers;
    const own = await kimiQuota().catch(() => null);
    if (own === null) return providers;
    return fromBb === undefined ? [...providers, own] : providers.map((p) => (p.id === KIMI_ID ? own : p));
  };
  const storedShow = async (): Promise<Record<string, boolean> | null> => {
    const stored = prefsSchema.safeParse(migratePrefs(await bb.storage.kv.get(PREFS_KEY).catch(() => undefined)));
    return stored.success ? stored.data.show : null;
  };
  // Before the first settings read (no prefs yet) Gemini is probed once so readPrefs can detect it.
  // Gemini is read only after the user turns it on in the strip settings.
  const geminiWanted = async () => (await storedShow())?.[GEMINI_ID] === true;
  const readGemini = async (): Promise<Limits["gemini"]> => {
    if (!(await geminiWanted())) return { ...limits.gemini, status: "off" };
    if (await switchingOn()) await accounts.sync().catch(() => undefined);
    return nextGemini();
  };
  const poll = async () => {
    await legacyReady;
    return pollNow();
  };
  const pollNow = () => {
    for (const id of restartPending) void settlePending(id);
    polling ??= (async () => {
      const [usage, snapshot, gemini] = await Promise.all([
        bb.sdk.system.usageLimits({}).then(
          (answer) => ({ ok: true as const, answer }),
          (cause: unknown) => ({ ok: false as const, reason: `usageLimits failed (${cause instanceof Error ? cause.name : "Error"})` }),
        ),
        bb.sdk.plugins
          .callRpc({ pluginId: FORECAST_PLUGIN, method: "snapshot", input: null, outputSchema: forecastSnapshotSchema })
          .catch(() => null),
        readGemini().catch((): Limits["gemini"] => ({ ...limits.gemini, status: "error", error: { code: "failed", message: "gemini read failed" } })),
      ]);
      // bb's usage answer fails now and then; the last good list stays until it recovers.
      // A provider that errors for one poll keeps its last good windows instead of losing its button.
      const keepLast = (p: ProviderLimits) => (p.status === "error" ? (limits.providers.find((q) => q.id === p.id && q.status === "ok") ?? p) : p);
      const providers = usage.ok ? (await withKimi(parseProviders(usage.answer, snapshot))).map(keepLast) : limits.providers;
      if (!usage.ok) bb.log.warn(usage.reason);
      const geminiReason = gemini.status === "error" ? (gemini.error?.message ?? null) : null;
      if (geminiReason !== null && geminiReason !== lastGeminiReason) bb.log.warn(`gemini: ${geminiReason}`);
      lastGeminiReason = geminiReason;
      limits = { polledAt: Date.now(), providers, providersError: usage.ok ? null : usage.reason, gemini };
      bb.rpc.experimental_invalidate([LIMITS_TAG]);
    })().finally(() => {
      polling = null;
    });
    return polling;
  };

  // threads.get goes over bb's local HTTP API: it fails with "fetch failed" while
  // the server is busy, and with 404 for a thread that was deleted. The panel
  // polls this, so it retries once, then answers with the last known state
  // instead of failing the RPC (which bb logs as "rpc thread failed").
  const lastThread = new Map<string, ThreadContext>();
  const readThreadStrict = async (threadId: string): Promise<ThreadContext> => {
    const [info, context] = await Promise.all([
      bb.sdk.threads.get({ threadId }),
      bb.sdk.threads.context({ threadId }).catch(() => null),
    ]);
    return parseContext(threadId, info, context);
  };
  const readThread = async (threadId: string): Promise<ThreadContext> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const state = await readThreadStrict(threadId);
        lastThread.delete(threadId);
        lastThread.set(threadId, state);
        if (lastThread.size > 50) lastThread.delete(lastThread.keys().next().value!);
        return state;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (/\b404\b|not found/i.test(message)) return { threadId, active: false, context: null };
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          continue;
        }
        bb.log.debug(`thread ${threadId}: ${message.slice(0, 200)}`);
        return lastThread.get(threadId) ?? { threadId, active: false, context: null };
      }
    }
  };

  const compact = async (threadId: string) => {
    const state = await readThreadStrict(threadId).catch(() => null);
    if (state === null) return { ok: false, message: "could not read the thread, try again" };
    if (state.active) return { ok: false, message: "thread is answering" };
    try {
      await bb.sdk.threads.compact({ threadId });
      bb.log.info(`compact queued for ${threadId}`);
      return { ok: true, message: null };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message.slice(0, 200) : "compact failed";
      bb.log.warn(`compact ${threadId}: ${message}`);
      return { ok: false, message };
    } finally {
      bb.rpc.experimental_invalidate([threadTag(threadId)]);
    }
  };

  const accounts = createAccounts(bb.storage.kv);
  const accountAction = async (name: string, action: () => Promise<string | null>) => {
    try {
      if (name !== "cancel add" && !(await switchingOn())) throw new AccountError("account switching is off in the plugin settings");
      const message = await action();
      bb.log.info(`accounts: ${name}`);
      return { ok: true, message };
    } catch (cause) {
      const message = cause instanceof AccountError ? cause.message : "Keychain operation failed";
      bb.log.warn(`accounts: ${name} failed: ${message}`);
      return { ok: false, message };
    } finally {
      bb.rpc.experimental_invalidate([ACCOUNTS_TAG]);
    }
  };
  const saveAccount = (label: string | null) => accountAction("save", async () => (await accounts.saveCurrent(label)).label);
  // An Antigravity thread keeps the agy process (and the login it read at
  // start) for as long as bb holds its runtime, so a switch only reaches it
  // after the runtime is released. Idle threads are stopped at once; threads
  // in the middle of a reply are stopped when they go idle.
  const AGY_PROVIDER = "acp-antigravity";
  // Kept in plugin storage so a plugin reload or bb restart does not forget it.
  const RESTART_KEY = "agy-restart-pending";
  const restartPending = new Set<string>();
  const persistPending = () => void bb.storage.kv.set(RESTART_KEY, [...restartPending]).catch(() => undefined);
  void bb.storage.kv.get<string[]>(RESTART_KEY).then((ids) => {
    for (const id of ids ?? []) if (typeof id === "string") restartPending.add(id);
    for (const id of restartPending) void settlePending(id);
  });
  const stopThread = async (threadId: string) => {
    restartPending.delete(threadId);
    persistPending();
    await bb.sdk.threads.stop({ threadId }).catch((cause: unknown) => bb.log.warn(`restart ${threadId} failed (${cause instanceof Error ? cause.name : "Error"})`));
  };
  const restartAntigravity = async () => {
    const threads = await bb.sdk.threads.list({ limit: 500 }).catch(() => []);
    for (const thread of threads as Array<{ id: string; providerId?: string | null; status?: string }>) {
      if (thread.providerId !== AGY_PROVIDER) continue;
      if (IDLE_STATUSES.has(thread.status ?? "")) await stopThread(thread.id);
      else restartPending.add(thread.id);
    }
    persistPending();
    bb.rpc.experimental_invalidate([ACCOUNTS_TAG]);
  };
  const settlePending = async (threadId: string) => {
    if (!restartPending.has(threadId)) return;
    const thread = (await bb.sdk.threads.get({ threadId }).catch(() => null)) as { status?: string } | null;
    if (thread === null) {
      restartPending.delete(threadId);
      persistPending();
    } else if (IDLE_STATUSES.has(thread.status ?? "")) await stopThread(threadId);
    else return;
    bb.rpc.experimental_invalidate([ACCOUNTS_TAG]);
  };
  // The user asked to interrupt: stop at once, without waiting for each
  // provider to confirm the interrupt (that can take long and froze the UI).
  const restartNow = () =>
    accountAction("restart now", async () => {
      const stops = Promise.all([...restartPending].map(stopThread));
      await Promise.race([stops, new Promise((resolve) => setTimeout(resolve, 3_000))]);
      return null;
    });

  const accountsState = async () => {
    // Switching off: no Keychain access at all.
    if (!(await switchingOn())) {
      return { enabled: false, signedIn: false, activeEmail: null, activeId: null, accounts: [], login: null, restartThreads: [] };
    }
    await accounts.sync().catch(() => undefined);
    return {
      ...(await accounts.state()),
      enabled: true,
      login: login === null ? null : { startedAt: login.startedAt, url: login.url },
      restartThreads: await Promise.all(
        [...restartPending].map(async (id) => {
          const thread = (await bb.sdk.threads.get({ threadId: id }).catch(() => null)) as { title?: string | null } | null;
          return { id, title: thread?.title?.trim() || id };
        }),
      ),
    };
  };
  const switchAccount = (id: string) =>
    accountAction("switch", async () => {
      const target = await accounts.switchTo(id);
      await restartAntigravity();
      await refreshAll("account switched").catch(() => undefined);
      return target.label;
    });
  // Add account: park the current login (it is saved), run agy in a bb
  // terminal so it starts its Google sign-in, wait for the new login to land
  // in the Keychain, save it and close the terminal. A sign-in that does not
  // finish restores the previous account.
  let login: { startedAt: number; url: string | null; terminalId: string; previousId: string | null; timer: ReturnType<typeof setInterval> } | null = null;
  const endLogin = async (restore: boolean) => {
    const job = login;
    if (job === null) return;
    login = null;
    clearInterval(job.timer);
    await bb.sdk.terminals.close({ terminalId: job.terminalId, mode: "force" }).catch(() => undefined);
    if (restore && job.previousId !== null && !(await accounts.signedIn())) await accounts.switchTo(job.previousId).catch(() => undefined);
    await accounts.sync().catch(() => undefined);
    bb.rpc.experimental_invalidate([ACCOUNTS_TAG]);
    void refreshAll("account changed").catch(() => undefined);
  };
  const localHostId = async () => {
    const hosts = await bb.sdk.hosts.list();
    const host = hosts.find((h) => h.machineProviderId === null && h.status === "connected") ?? hosts[0];
    if (host === undefined) throw new AccountError("no local machine");
    return host.id;
  };
  const addAccount = () =>
    accountAction("add", async () => {
      if (login !== null) return null;
      const agyBin = await agy();
      if (agyBin === null) throw new AccountError("agy not found; set its path in the plugin settings");
      await accounts.sync();
      const previousId = (await accounts.state()).activeId;
      if (await accounts.signedIn()) await accounts.detach();
      const cwd = join(tmpdir(), "fuel-bb-login");
      await mkdir(cwd, { recursive: true });
      const terminal = await bb.sdk.terminals.create({
        cols: 120,
        rows: 40,
        title: "Antigravity sign-in",
        scope: { kind: "host_path", hostId: await localHostId(), cwd },
        start: { mode: "argv", argv: [agyBin] },
      });
      let seq = 0;
      let text = "";
      const answered = new Set<string>();
      const startedAt = Date.now();
      const timer = setInterval(() => {
        void (async () => {
          if (login === null) return;
          // Switched off mid sign-in: put the previous account back and stop touching the Keychain.
          if (!(await switchingOn())) return endLogin(true);
          if (await accounts.signedIn()) return endLogin(false);
          if (Date.now() - startedAt > LOGIN_TIMEOUT_MS) return endLogin(true);
          const out = await bb.sdk.terminals.output({ terminalId: terminal.id, sinceSeq: seq }).catch(() => null);
          if (out === null) return;
          seq = out.nextSeq;
          text = (text + out.chunks.map((c) => Buffer.from(c.dataBase64, "base64").toString("utf8")).join("")).slice(-20_000);
          const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
          const url = /https:\/\/accounts\.google\.com\/[^\s"'<>\x1b]+/.exec(plain)?.[0] ?? null;
          if (url !== null && login !== null && login.url !== url) {
            login.url = url;
            bb.rpc.experimental_invalidate([ACCOUNTS_TAG]);
          }
          // agy asks for a login method (Google OAuth is the default) and may ask
          // to trust its working folder, an empty temp folder.
          for (const [pattern, done] of [[/Select login method/i, "method"], [/Do you trust/i, "trust"]] as const) {
            if (!answered.has(done) && pattern.test(plain)) {
              answered.add(done);
              await press(terminal.id, "\r");
            }
          }
          if (out.status === "exited" && !(await accounts.signedIn())) return endLogin(true);
        })();
      }, 2_000);
      login = { startedAt, url: null, terminalId: terminal.id, previousId, timer };
      return null;
    });
  const press = (terminalId: string, text: string) =>
    bb.sdk.terminals.input({ terminalId, dataBase64: Buffer.from(text).toString("base64") }).catch(() => undefined);
  const submitLoginCode = (code: string) =>
    accountAction("login code", async () => {
      if (login === null) throw new AccountError("no sign-in in progress");
      await press(login.terminalId, `${code}\r`);
      return null;
    });
  const cancelAddAccount = () =>
    accountAction("cancel add", async () => {
      await endLogin(true);
      return null;
    });
  bb.onDispose(() => void endLogin(true));

  const removeAccount = (id: string) => accountAction("remove", async () => {
      await accounts.remove(id);
      return null;
    });

  // Strip settings, server-side so every window and device sees the same.
  // Providers bb reports are shown unless switched off here.
  const readPrefs = async (): Promise<Prefs> => {
    await legacyReady;
    const raw = await bb.storage.kv.get(PREFS_KEY).catch(() => undefined);
    const migrated = migratePrefs(raw);
    const stored = prefsSchema.safeParse(migrated);
    if (stored.success) {
      if (migrated !== raw) await bb.storage.kv.set(PREFS_KEY, stored.data).catch(() => undefined);
      return stored.data;
    }
    if (limits.polledAt === null) await poll().catch(() => undefined);
    const detected: Prefs = { show: {}, accent: THEME_ACCENT, lang: "auto" };
    await bb.storage.kv.set(PREFS_KEY, detected).catch(() => undefined);
    return detected;
  };

  bb.rpc.register(contract, {
    prefs: () => readPrefs(),
    setPrefs: async (input) => {
      const prefs = { ...input, accent: input.accent.toLowerCase() as Prefs["accent"] };
      const geminiTurnedOn = prefs.show[GEMINI_ID] === true && (await storedShow())?.[GEMINI_ID] !== true;
      await bb.storage.kv.set(PREFS_KEY, prefs);
      bb.rpc.experimental_invalidate([PREFS_TAG]);
      if (prefs.show[GEMINI_ID] !== true) {
        limits = { ...limits, gemini: { ...limits.gemini, status: "off" } };
        bb.rpc.experimental_invalidate([LIMITS_TAG]);
      } else if (geminiTurnedOn) {
        limits = { ...limits, gemini: { ...limits.gemini, status: limits.gemini.measuredAt === null ? "pending" : limits.gemini.status } };
        bb.rpc.experimental_invalidate([LIMITS_TAG]);
        void refreshAll("turned on").catch(() => undefined);
      }
      return prefs;
    },
    limits: async () => {
      if (limits.polledAt === null) await poll();
      return limits;
    },
    thread: ({ threadId }) => readThread(threadId),
    refreshGemini: async () => {
      await refreshAll("asked from the popover").catch(() => undefined);
      return limits;
    },
    setAccountSwitching: async ({ on }) => {
      await settings.experimental_set({ accountSwitching: on });
      bb.log.info(`account switching ${on ? "on" : "off"}`);
      bb.rpc.experimental_invalidate([ACCOUNTS_TAG]);
      return { ok: true, message: null };
    },
    compact: ({ threadId }) => compact(threadId),
    accounts: () => accountsState(),
    switchAccount: ({ id }) => switchAccount(id),
    removeAccount: ({ id }) => removeAccount(id),
    addAccount: () => addAccount(),
    cancelAddAccount: () => cancelAddAccount(),
    restartAntigravityNow: () => restartNow(),
    submitLoginCode: ({ code }) => submitLoginCode(code),
  });

  bb.background.schedule("poll", POLL_CRON, () => poll());
  void poll().catch((cause: unknown) => bb.log.warn(`first poll failed: ${cause instanceof Error ? cause.name : "Error"}`));

  // Turns, compactions and status changes refresh the open thread's row.
  const lastInvalidated = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const unsubscribe = bb.sdk.subscribe({
    event: "thread:changed",
    callback: (event) => {
      const id = (event as { id?: unknown }).id;
      if (typeof id === "string" && id !== "" && (providerOf.get(id) ?? AGY_PROVIDER_ID) === AGY_PROVIDER_ID) void trackAgy(id);
      if (typeof id === "string" && restartPending.has(id)) void settlePending(id);
      if (typeof id !== "string" || id === "" || timers.has(id)) return;
      const wait = Math.max(0, (lastInvalidated.get(id) ?? 0) + THREAD_INVALIDATE_MIN_MS - Date.now());
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          lastInvalidated.set(id, Date.now());
          if (lastInvalidated.size > 200) lastInvalidated.clear();
          bb.rpc.experimental_invalidate([threadTag(id)]);
        }, wait),
      );
    },
  });
  bb.onDispose(() => {
    unsubscribe();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  });

  const line = (w: { label?: string; name?: string; usedPercent: number; resetsAt: number | null }) =>
    `  ${w.label ?? w.name}: ${Math.round(w.usedPercent)}%${w.resetsAt === null ? "" : ` resets ${new Date(w.resetsAt).toISOString()}`}`;
  bb.cli.register({
    name: "fuel",
    summary: "Show what the Fuel BB sidebar block shows",
    commands: [
      { name: "status", summary: "Every provider's limits and the Gemini quota", usage: "bb fuel status [--refresh] [--json]" },
      { name: "thread", summary: "A thread's context fill", usage: "bb fuel thread <threadId> [--json]" },
      { name: "accounts", summary: "Saved Antigravity accounts and the active one", usage: "bb fuel accounts [--json]" },
      { name: "save-account", summary: "Save the current agy login", usage: "bb fuel save-account [label]" },
      { name: "switch-account", summary: "Switch agy to a saved login, or to the next one", usage: "bb fuel switch-account <id|next>" },
      { name: "remove-account", summary: "Forget a saved login", usage: "bb fuel remove-account <id>" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, arg] = argv.filter((a) => !a.startsWith("--"));
      if (command === "status") {
        if (argv.includes("--refresh") || limits.polledAt === null) await refreshAll();
        if (json) return { exitCode: 0, stdout: JSON.stringify(limits) };
        const g = limits.gemini;
        const lines = [
          `polled: ${limits.polledAt === null ? "never" : new Date(limits.polledAt).toISOString()}`,
          ...(limits.providersError === null ? [] : [`bb usage: ${limits.providersError}`]),
          ...limits.providers.flatMap((p) =>
            p.status === "ok"
              ? [
                  `${p.id}${p.source === "plugin" ? ` (read by the plugin, measured ${new Date(p.measuredAt ?? 0).toISOString()})` : ""}:`,
                  ...p.windows.map((w) => `${line(w)}${w.forecast === null ? "" : w.forecast.lasts ? " (lasts)" : " (runs out before reset)"}`),
                ]
              : [`${p.id}: ${p.status}${p.message ? ` (${p.message})` : ""}`],
          ),
          ...(g.status === "off"
            ? ["gemini: off (turn it on in the strip settings)"]
            : [
                ...(g.error === null ? [] : [`gemini: ${g.error.code} (${g.error.message})`]),
                ...g.groups.flatMap((gr) => [`gemini / ${gr.title}:`, ...gr.windows.map(line), ...gr.models.map(line)]),
              ]),
        ];
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      if (command === "thread" && arg !== undefined) {
        const state = await readThread(arg);
        if (json) return { exitCode: 0, stdout: JSON.stringify(state) };
        const ctx = state.context;
        return {
          exitCode: 0,
          stdout: `${state.threadId} ${state.active ? "answering" : "idle"} ${ctx === null ? "no context data" : `${Math.round(ctx.percent)}% ${ctx.usedTokens} / ${ctx.limitTokens}`}`,
        };
      }
      if (command === "accounts") {
        const st = await accountsState();
        if (json) return { exitCode: 0, stdout: JSON.stringify(st) };
        const lines = [
          `active: ${st.signedIn ? (st.activeEmail ?? "signed in, email unknown") : "not signed in"}${st.activeId === null ? " (not saved)" : ` (${st.activeId})`}`,
          ...st.accounts.map((a) => `${a.id === st.activeId ? "*" : " "} ${a.id}  ${a.label}${a.email && a.email !== a.label ? `  <${a.email}>` : ""}`),
        ];
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      const label = argv.filter((a) => !a.startsWith("--")).slice(1).join(" ").trim().slice(0, 60);
      const report = (r: { ok: boolean; message: string | null }, done: string) =>
        r.ok ? { exitCode: 0, stdout: done } : { exitCode: 1, stdout: `failed: ${r.message ?? "error"}` };
      if (command === "save-account") {
        const r = await saveAccount(label || null);
        return report(r, `saved: ${r.message ?? ""}`);
      }
      if (command === "switch-account" && arg !== undefined) {
        // `next`: the saved account after the active one, for agents that hit a limit.
        let id = arg;
        if (arg === "next") {
          const st = await accountsState();
          const others = st.accounts.filter((a) => a.id !== st.activeId);
          if (others.length === 0) return { exitCode: 1, stdout: "failed: no other saved account" };
          const at = st.accounts.findIndex((a) => a.id === st.activeId);
          id = (st.accounts.slice(at + 1).find((a) => a.id !== st.activeId) ?? others[0]).id;
        }
        const r = await switchAccount(id);
        return report(r, `switched to ${r.message ?? id}`);
      }
      if (command === "remove-account" && arg !== undefined) return report(await removeAccount(arg), `removed ${arg}`);
      return {
        exitCode: command === undefined ? 0 : 1,
        stdout: [
          "bb fuel status [--refresh] [--json]",
          "bb fuel thread <threadId> [--json]",
          "bb fuel accounts [--json]",
          "bb fuel save-account [label]",
          "bb fuel switch-account <id|next>",
          "bb fuel remove-account <id>",
        ].join("\n"),
      };
    },
  });

  bb.log.info("fuel-bb loaded");
}
