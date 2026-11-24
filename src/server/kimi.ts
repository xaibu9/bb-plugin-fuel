// Kimi Code quota from the usage endpoint the CLI's own provider uses. The
// login path and API base come from ~/.kimi-code/config.toml (CLI 2.6 keeps
// credentials/<oauth key>.json, not credentials/kimi-code.json). The access
// token is read per poll, kept in memory only, and never refreshed here: a
// refresh racing a running kimi could sign it out.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { LimitWindow } from "../shared/contract";

const PROVIDER = "managed:kimi-code";
const TIMEOUT_MS = 15_000;
const EXPIRY_MARGIN_S = 30;

/** Usage keys in display order, with the label keys the app translates. */
const WINDOWS = [
  ["limit_5h", "5h"],
  ["limit_7d", "week"],
  ["limit_month_code", "month_code"],
  ["limit_month_total", "month_total"],
] as const;

export type KimiRead =
  | { kind: "ok"; windows: LimitWindow[] }
  | { kind: "signedOut" }
  | { kind: "expired" }
  | { kind: "error"; reason: string };

function kimiHome(): string {
  return process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");
}

/** The `[providers."managed:kimi-code"]` base URL and its oauth key, from a small TOML subset. */
function providerConfig(toml: string): { baseUrl: string | null; oauthKey: string | null } {
  let section = "";
  let baseUrl: string | null = null;
  let oauthKey: string | null = null;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1].replace(/\s+/g, "");
      continue;
    }
    const kv = /^([A-Za-z_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (!kv) continue;
    if (section === `providers."${PROVIDER}"` && kv[1] === "base_url") baseUrl = kv[2];
    if (section === `providers."${PROVIDER}".oauth` && kv[1] === "key") oauthKey = kv[2];
  }
  return { baseUrl, oauthKey };
}

async function readToken(): Promise<{ baseUrl: string; token: string; expiresAt: number | null } | null> {
  const home = kimiHome();
  const toml = await readFile(join(home, "config.toml"), "utf8").catch(() => "");
  const { baseUrl, oauthKey } = providerConfig(toml);
  const names = oauthKey === null ? ["kimi-code.json"] : [`${basename(oauthKey)}.json`, "kimi-code.json"];
  for (const name of names) {
    const raw = await readFile(join(home, "credentials", name), "utf8").catch(() => null);
    if (raw === null) continue;
    try {
      const parsed = JSON.parse(raw) as { access_token?: unknown; expires_at?: unknown };
      if (typeof parsed.access_token !== "string" || parsed.access_token === "") continue;
      return {
        baseUrl: (baseUrl ?? "https://api.kimi.com/coding/v1").replace(/\/+$/, ""),
        token: parsed.access_token,
        expiresAt: typeof parsed.expires_at === "number" ? parsed.expires_at : null,
      };
    } catch {
      continue;
    }
  }
  return null;
}

function toWindows(payload: unknown): LimitWindow[] {
  const usages = (payload as { usages?: Record<string, { used_ratio?: unknown; reset_time?: unknown }> } | null)?.usages ?? {};
  return WINDOWS.flatMap(([key, label]) => {
    const entry = usages[key];
    if (typeof entry?.used_ratio !== "number" || !Number.isFinite(entry.used_ratio)) return [];
    const at = typeof entry.reset_time === "string" ? Date.parse(entry.reset_time) : NaN;
    return [{ label, usedPercent: Math.max(0, Math.min(100, entry.used_ratio * 100)), resetsAt: Number.isFinite(at) ? at : null, forecast: null }];
  });
}

export async function readKimiQuota(): Promise<KimiRead> {
  const cred = await readToken();
  if (cred === null) return { kind: "signedOut" };
  if (cred.expiresAt !== null && cred.expiresAt - EXPIRY_MARGIN_S < Date.now() / 1000) return { kind: "expired" };
  try {
    const response = await fetch(`${cred.baseUrl}/usages`, {
      headers: { authorization: `Bearer ${cred.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) return { kind: "expired" };
    if (!response.ok) return { kind: "error", reason: `usage endpoint returned HTTP ${response.status}` };
    const windows = toWindows(await response.json());
    return windows.length === 0 ? { kind: "error", reason: "no quota windows in the answer" } : { kind: "ok", windows };
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : "Error";
    return { kind: "error", reason: name === "TimeoutError" ? "usage request timed out" : `usage request failed (${name})` };
  }
}
