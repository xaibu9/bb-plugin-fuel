import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const LIMITS_TAG = "limits";
export const ACCOUNTS_TAG = "accounts";
export const PREFS_TAG = "prefs";

/** "theme" paints the strip with the active bb theme's accent. */
export const THEME_ACCENT = "theme";
export const GEMINI_ID = "gemini";
export const prefsSchema = z.object({
  /**
   * Strip buttons by provider id (bb provider ids plus `gemini`); a provider
   * missing here is shown when it has data. The context button is always there.
   */
  show: z.record(z.string().max(80), z.boolean()),
  accent: z.union([z.literal(THEME_ACCENT), z.string().regex(/^#[0-9a-fA-F]{6}$/)]),
  lang: z.enum(["auto", "ru", "en"]),
});
export type Prefs = z.infer<typeof prefsSchema>;
export const threadTag = (threadId: string) => `thread:${threadId}`;

const forecastSchema = z.object({
  /** True when the window is projected to last until its reset. */
  lasts: z.boolean(),
  /** Projected use at the reset, percent. */
  projectedPercent: z.number().nullable(),
  /** Epoch ms when the window is projected to run out, or null. */
  runOutAt: z.number().nullable(),
});
export type Forecast = z.infer<typeof forecastSchema>;

const windowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.number().nullable(),
  forecast: forecastSchema.nullable(),
});
export type LimitWindow = z.infer<typeof windowSchema>;

const modelQuotaSchema = z.object({
  name: z.string(),
  usedPercent: z.number(),
  resetsAt: z.number().nullable(),
});
export type ModelQuota = z.infer<typeof modelQuotaSchema>;

const quotaGroupSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  windows: z.array(windowSchema),
  models: z.array(modelQuotaSchema),
});
export type QuotaGroup = z.infer<typeof quotaGroupSchema>;

export const geminiStateSchema = z.object({
  /** off: switched off in settings; pending: first measurement running; ok / error: last read. */
  status: z.enum(["off", "pending", "ok", "error"]),
  /** The last good measurement; kept while a later read fails. */
  groups: z.array(quotaGroupSchema),
  measuredAt: z.number().nullable(),
  error: z
    .object({ code: z.enum(["not_macos", "agy_missing", "signed_out", "timeout", "failed"]), message: z.string() })
    .nullable(),
  /** The quota can be read on this machine (macOS). */
  supported: z.boolean(),
});
export type GeminiState = z.infer<typeof geminiStateSchema>;

const providerLimitsSchema = z.object({
  /** bb provider id, e.g. `claude-code`, `kimi-code`, `acp-cursor`. */
  id: z.string(),
  /** bb's usage status; `ok` carries windows. */
  status: z.enum(["ok", "not_installed", "unauthenticated", "expired", "error"]),
  plan: z.string().nullable(),
  windows: z.array(windowSchema),
  message: z.string().nullable(),
  /** `bb`: from system.usageLimits; `plugin`: read by this plugin when bb had no data. */
  source: z.enum(["bb", "plugin"]),
  /** When a plugin-read window was measured; it can be older than the poll. */
  measuredAt: z.number().nullable(),
});
export type ProviderLimits = z.infer<typeof providerLimitsSchema>;

export const limitsSchema = z.object({
  polledAt: z.number().nullable(),
  /** Every provider bb reports usage for, in bb's order. */
  providers: z.array(providerLimitsSchema),
  /** null: usage limits could not be read this poll (the last good list is kept when there is one). */
  providersError: z.string().nullable(),
  /** Antigravity quota the plugin reads itself through agy (bb does not report it). */
  gemini: geminiStateSchema,
});
export type Limits = z.infer<typeof limitsSchema>;

export const threadContextSchema = z.object({
  threadId: z.string(),
  active: z.boolean(),
  context: z
    .object({ usedTokens: z.number(), limitTokens: z.number(), percent: z.number(), model: z.string().nullable() })
    .nullable(),
});
export type ThreadContext = z.infer<typeof threadContextSchema>;

export const geminiAccountsSchema = z.object({
  /** Account switching is on in the plugin settings; when off nothing else is read. */
  enabled: z.boolean(),
  signedIn: z.boolean(),
  activeEmail: z.string().nullable(),
  /** The saved account the active login belongs to, if it is saved. */
  activeId: z.string().nullable(),
  accounts: z.array(z.object({ id: z.string(), label: z.string(), email: z.string().nullable(), savedAt: z.number() })),
  /** An add-account sign-in in progress: the Google page agy printed, once seen. */
  login: z.object({ startedAt: z.number(), url: z.string().nullable() }).nullable(),
  /** Antigravity threads still answering on the previous account; restarted when they go idle. */
  restartThreads: z.array(z.object({ id: z.string(), title: z.string() })),
});
export type GeminiAccounts = z.infer<typeof geminiAccountsSchema>;

const resultSchema = z.object({ ok: z.boolean(), message: z.string().nullable() });

export const contract = defineRpcContract({
  prefs: {
    input: z.null(),
    output: prefsSchema,
    tags: () => [PREFS_TAG],
  },
  setPrefs: {
    input: prefsSchema,
    output: prefsSchema,
  },
  limits: {
    input: z.null(),
    output: limitsSchema,
    tags: () => [LIMITS_TAG],
  },
  thread: {
    input: z.object({ threadId: z.string().min(1).max(200) }),
    output: threadContextSchema,
    tags: ({ threadId }) => [threadTag(threadId)],
  },
  compact: {
    input: z.object({ threadId: z.string().min(1).max(200) }),
    output: resultSchema,
  },
  accounts: {
    input: z.null(),
    output: geminiAccountsSchema,
    tags: () => [ACCOUNTS_TAG],
  },
  switchAccount: {
    input: z.object({ id: z.string().max(40) }),
    output: resultSchema,
  },
  addAccount: {
    input: z.null(),
    output: resultSchema,
  },
  submitLoginCode: {
    // An OAuth authorization code: URL-safe characters only, so it cannot carry terminal control input.
    input: z.object({ code: z.string().min(10).max(512).regex(/^[A-Za-z0-9/_.~-]+$/) }),
    output: resultSchema,
  },
  /** Re-reads the Gemini quota now. */
  refreshGemini: {
    input: z.null(),
    output: limitsSchema,
  },
  /** Turns Antigravity account switching on or off (the plugin setting). */
  setAccountSwitching: {
    input: z.object({ on: z.boolean() }),
    output: resultSchema,
  },
  restartAntigravityNow: {
    input: z.null(),
    output: resultSchema,
  },
  cancelAddAccount: {
    input: z.null(),
    output: resultSchema,
  },
  removeAccount: {
    input: z.object({ id: z.string().max(40) }),
    output: resultSchema,
  },
});
