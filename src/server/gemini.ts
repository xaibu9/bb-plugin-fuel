// Antigravity (Gemini) quota. The agy CLI keeps its OAuth token in the macOS
// Keychain; it is read per poll, held in memory only and never logged.
import { execFile } from "node:child_process";
import { access, constants, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { LimitWindow, ModelQuota, QuotaGroup } from "../shared/contract";

const SECURITY = "/usr/bin/security";
const KEYCHAIN_SERVICE = "gemini";
const KEYCHAIN_ACCOUNT = "antigravity";
const KEYRING_PREFIX = "go-keyring-base64:";
const AGY_FALLBACK_DIRS = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];

/** The agy CLI: the configured path, else the first agy on PATH or in the usual install folders. */
export async function agyPath(configured: string): Promise<string | null> {
  const executable = (path: string) => access(path, constants.X_OK).then(() => true, () => false);
  if (configured.trim() !== "") return (await executable(configured.trim())) ? configured.trim() : null;
  const dirs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), ...AGY_FALLBACK_DIRS];
  for (const dir of dirs) {
    const candidate = join(dir, "agy");
    if (await executable(candidate)) return candidate;
  }
  return null;
}
const API = "https://cloudcode-pa.googleapis.com/v1internal";
const USER_AGENT = "antigravity/1.2.11 darwin/arm64";
const PROJECT = "aicode-consumers";
const EXPIRY_MARGIN_MS = 60_000;
const TIMEOUT_MS = 15_000;

/** Why there is no quota: the app shows a hint per code. */
export type GeminiErrorCode = "not_macos" | "agy_missing" | "signed_out" | "timeout" | "failed";
export type GeminiResult = { ok: true; groups: QuotaGroup[] } | { ok: false; code: GeminiErrorCode; reason: string };

class Reason extends Error {
  constructor(
    message: string,
    readonly code: GeminiErrorCode = "failed",
  ) {
    super(message);
  }
}

interface Token {
  accessToken: string;
  expiresAt: number | null;
}

function run(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, encoding: "utf8", maxBuffer: 1 << 20, env: { ...process.env, NO_COLOR: "1" } }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function readToken(): Promise<Token> {
  let raw: string;
  try {
    raw = (await run(SECURITY, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"], 10_000)).trim();
  } catch {
    throw new Reason("agy is not signed in (no Keychain item gemini/antigravity)", "signed_out");
  }
  let parsed: unknown;
  try {
    const json = raw.startsWith(KEYRING_PREFIX) ? Buffer.from(raw.slice(KEYRING_PREFIX.length), "base64").toString("utf8") : raw;
    parsed = JSON.parse(json);
  } catch {
    throw new Reason("keychain item is not in the expected format");
  }
  const token = (parsed as { token?: { access_token?: unknown; expiry?: unknown } } | null)?.token;
  if (typeof token?.access_token !== "string" || token.access_token === "") throw new Reason("no access token in keychain item");
  const expiry = typeof token.expiry === "string" ? Date.parse(token.expiry.replace(/(\.\d{3})\d+/, "$1")) : NaN;
  return { accessToken: token.access_token, expiresAt: Number.isFinite(expiry) ? expiry : null };
}

/** `agy models` authenticates without an inference turn and rewrites the Keychain token. */
async function refreshViaAgy(agy: string): Promise<void> {
  try {
    await run(agy, ["models"], 30_000);
  } catch {
    // The re-read token tells whether it worked.
  }
}

async function post(token: string, method: string, body: unknown): Promise<Response> {
  return fetch(`${API}:${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

type Family = "gemini" | "thirdParty";

const WINDOW_LABELS: Record<string, string> = { weekly: "week", "5h": "5h", daily: "day" };
const WINDOW_RANK: Record<string, number> = { "5h": 0, daily: 1, weekly: 2 };

function quota(remaining: unknown, reset: unknown): { usedPercent: number; resetsAt: number | null } | null {
  // Proto3 JSON omits zero values: an exhausted bucket may carry only its reset.
  if (remaining === undefined && typeof reset === "string") remaining = 0;
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
  const at = typeof reset === "string" ? Date.parse(reset) : NaN;
  return { usedPercent: Math.max(0, Math.min(100, (1 - remaining) * 100)), resetsAt: Number.isFinite(at) ? at : null };
}

function familyOf(text: string): Family | null {
  if (/claude|gpt/i.test(text)) return "thirdParty";
  if (/gemini/i.test(text)) return "gemini";
  return null;
}

interface Draft extends QuotaGroup {
  family: Family | null;
}

function fromSummary(json: unknown): Draft[] {
  const groups = (json as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group: { displayName?: unknown; description?: unknown; buckets?: unknown }) => {
    if (typeof group?.displayName !== "string" || !Array.isArray(group.buckets)) return [];
    const description = typeof group.description === "string" ? group.description : null;
    const rank = (b: { window?: unknown }) => (typeof b.window === "string" ? WINDOW_RANK[b.window] ?? 3 : 3);
    const windows: LimitWindow[] = [...group.buckets]
      .sort((a: { window?: unknown }, b: { window?: unknown }) => rank(a) - rank(b))
      .flatMap((b: { window?: unknown; displayName?: unknown; remainingFraction?: unknown; resetTime?: unknown }) => {
        const q = quota(b?.remainingFraction, b?.resetTime);
        if (q === null) return [];
        const label = (typeof b.window === "string" ? WINDOW_LABELS[b.window] : undefined) ?? (typeof b.displayName === "string" ? b.displayName : "limit");
        return [{ label, ...q, forecast: null }];
      });
    return [{ title: group.displayName, description: null, windows, models: [], family: familyOf(`${group.displayName} ${description ?? ""}`) }];
  });
}

/** Per-model quota; internal ids (chat_*, tab_*) and duplicate display names are dropped. */
function fromModels(json: unknown): Array<ModelQuota & { family: Family }> {
  const models = (json as { models?: unknown } | null)?.models;
  if (models === null || typeof models !== "object") return [];
  const byName = new Map<string, ModelQuota & { family: Family }>();
  for (const [id, model] of Object.entries(models as Record<string, { displayName?: unknown; quotaInfo?: { remainingFraction?: unknown; resetTime?: unknown } }>)) {
    if (/^(chat|tab)_/i.test(id)) continue;
    const family = familyOf(id);
    const q = quota(model?.quotaInfo?.remainingFraction, model?.quotaInfo?.resetTime);
    if (family === null || q === null) continue;
    const name = typeof model.displayName === "string" && model.displayName !== "" ? model.displayName : id;
    const prev = byName.get(name);
    if (prev === undefined || q.usedPercent > prev.usedPercent) byName.set(name, { name, ...q, family });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Group titles are keys the app translates. */
const FAMILY_TITLES: Record<Family, string> = { gemini: "gemini", thirdParty: "claude_gpt" };

function merge(summary: Draft[], models: Array<ModelQuota & { family: Family }>): QuotaGroup[] {
  const groups = [...summary];
  for (const family of ["gemini", "thirdParty"] as const) {
    const own = models.filter((m) => m.family === family).map(({ family: _, ...m }) => m);
    if (own.length === 0) continue;
    const group = groups.find((g) => g.family === family);
    if (group !== undefined) group.models = own;
    else groups.push({ title: FAMILY_TITLES[family], description: null, windows: [], models: own, family });
  }
  const rank = (g: Draft) => (g.family === "gemini" ? 0 : g.family === "thirdParty" ? 1 : 2);
  return groups
    .filter((g) => g.windows.length > 0 || g.models.length > 0)
    .sort((a, b) => rank(a) - rank(b))
    .map(({ family, title, ...g }) => ({ ...g, title: family === null ? title : FAMILY_TITLES[family] }));
}

async function query(token: string): Promise<QuotaGroup[]> {
  const [summary, models] = await Promise.all([
    post(token, "retrieveUserQuotaSummary", { project: PROJECT }),
    post(token, "fetchAvailableModels", { project: PROJECT }),
  ]);
  if (summary.status === 401 || models.status === 401) throw new Unauthorized();
  if (!summary.ok && !models.ok) throw new Reason(`quota request failed (HTTP ${models.status})`);
  const groups = merge(summary.ok ? fromSummary(await summary.json()) : [], models.ok ? fromModels(await models.json()) : []);
  if (groups.length === 0) throw new Reason("no quota in the response");
  return groups;
}

class Unauthorized extends Error {}

const USAGE_TIMEOUT_MS = 90_000;
const USAGE_GROUPS: Record<string, string> = { "gemini models": "gemini", "claude and gpt models": "claude_gpt" };

/** Windows in the order the panel shows them: 5 hours, then the week. */
function usageWindow(label: string): { label: string; rank: number } {
  if (/five hour|5.?h/i.test(label)) return { label: "5h", rank: 0 };
  if (/week/i.test(label)) return { label: "week", rank: 1 };
  return { label, rank: 2 };
}

/**
 * agy's own `/usage` (print mode, no model turn): the only source that has the
 * Gemini weekly and 5-hour windows; the quota API returns just the Claude and
 * GPT group. Lines are `group<TAB>window<TAB>NN%<TAB>reset`.
 */
async function readViaAgy(agy: string): Promise<QuotaGroup[]> {
  const cwd = join(tmpdir(), "fuel-bb-agy");
  await mkdir(cwd, { recursive: true });
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      agy,
      ["-p", "/usage", "--print-timeout", "60s", "--log-file", "/dev/null"],
      { cwd, timeout: USAGE_TIMEOUT_MS, encoding: "utf8", maxBuffer: 1 << 20, env: { ...process.env, NO_COLOR: "1" } },
      (error, out) => (error ? reject(new Reason("agy /usage failed")) : resolve(out)),
    );
  });
  const groups = new Map<string, Array<LimitWindow & { rank: number }>>();
  for (const line of stdout.split("\n")) {
    const [group, window, pct, reset] = line.split("\t");
    const left = Number.parseFloat(pct ?? "");
    if (!group || !window || !Number.isFinite(left)) continue;
    const at = Date.parse(reset ?? "");
    const { label, rank } = usageWindow(window);
    const title = USAGE_GROUPS[group.trim().toLowerCase()] ?? group.trim();
    groups.set(title, [...(groups.get(title) ?? []), { label, rank, usedPercent: Math.max(0, Math.min(100, 100 - left)), resetsAt: Number.isFinite(at) ? at : null, forecast: null }]);
  }
  if (groups.size === 0) throw new Reason("agy /usage returned no quota");
  return [...groups].map(([title, windows]) => ({
    title,
    description: null,
    windows: windows.sort((a, b) => a.rank - b.rank).map(({ rank: _, ...w }) => w),
    models: [],
  }));
}

/** agy `/usage` first; the quota API (Claude and GPT group, per-model quota) when agy fails. */
export async function readGeminiQuota(agy: string | null): Promise<GeminiResult> {
  if (process.platform !== "darwin") return { ok: false, code: "not_macos", reason: "Antigravity quota is read on macOS only" };
  if (agy === null) return { ok: false, code: "agy_missing", reason: "agy not found (the configured path, or PATH and ~/.local/bin, /opt/homebrew/bin, /usr/local/bin)" };
  try {
    return { ok: true, groups: await readViaAgy(agy) };
  } catch {
    return readViaApi(agy);
  }
}

async function readViaApi(agy: string): Promise<GeminiResult> {
  try {
    let token = await readToken();
    if (token.expiresAt !== null && token.expiresAt - Date.now() < EXPIRY_MARGIN_MS) {
      await refreshViaAgy(agy);
      token = await readToken();
    }
    try {
      return { ok: true, groups: await query(token.accessToken) };
    } catch (cause) {
      if (!(cause instanceof Unauthorized)) throw cause;
      await refreshViaAgy(agy);
      token = await readToken();
      return { ok: true, groups: await query(token.accessToken) };
    }
  } catch (cause) {
    if (cause instanceof Reason) return { ok: false, code: cause.code, reason: cause.message };
    if (cause instanceof Unauthorized) return { ok: false, code: "signed_out", reason: "token rejected after agy refresh" };
    const name = cause instanceof Error ? cause.name : "Error";
    return name === "TimeoutError"
      ? { ok: false, code: "timeout", reason: "agy and the quota request did not answer in time" }
      : { ok: false, code: "failed", reason: `quota request failed (${name})` };
  }
}
