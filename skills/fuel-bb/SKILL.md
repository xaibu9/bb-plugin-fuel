---
name: fuel-bb
description: Read what the Fuel BB sidebar strip shows (Claude limit windows with forecasts, every Antigravity quota window and per-model quota, a thread's context fill) with the `bb fuel` CLI.
---

# Fuel BB

The sidebar footer gets a full-width strip: a button for every provider bb reports usage for (`system.usageLimits`: claude-code, kimi-code, acp-cursor, acp-opencode, ...; not installed or not signed in means no button), an optional Gemini (Antigravity) button and Context. Each shows the longest window's percent used; a click opens a popover with details. Compacting the context there asks for confirmation and is disabled while the thread is answering.

- `bb fuel status [--refresh] [--json]` — every provider and window bb reports (from bb's own usage data, no extra provider calls) with its reset and, when the Usage Forecast plugin is installed, whether it lasts until the reset; then every Antigravity quota group (weekly and 5-hour windows) and per-model quota. `--refresh` re-polls now instead of waiting for the 2-minute schedule.
- `bb fuel thread <threadId> [--json]` — the thread's context fill and whether it is answering.

## Antigravity accounts

Off by default: the plugin setting `accountSwitching` (`bb plugin config fuel-bb set accountSwitching true`) must be on, otherwise these commands fail and the plugin does not touch the Keychain items below.

- `bb fuel accounts [--json]` — the active agy login (email), saved accounts and a sign-in in progress; `*` marks the active one.
- `bb fuel switch-account <id|next>` — make a saved login active (`next`: the next saved account); the current one is saved first.
- `bb fuel remove-account <id>` — forget a saved login.
- `bb fuel save-account [label]` — save the current login now (the plugin also saves and refreshes it on every poll).

Saved logins are copies of the Keychain item `gemini`/`antigravity` under the service `limits-panel-gemini-accounts`; plugin storage holds only ids, labels and emails. "+ Add account" in the Gemini popover parks the current login, runs `agy` in a bb terminal (it picks Google OAuth), shows its Google sign-in link and an authorization-code field, saves the new login when it lands and closes the terminal; cancelling or a 5-minute timeout restores the previous account. Do not use agy's `/logout` to change accounts: it may revoke the token a saved copy relies on. An Antigravity thread runs `agy-acp`, which starts a fresh `agy --conversation` per turn; that process reads the login when it starts, so a turn already running finishes on the old account. After a switch the plugin stops idle `acp-antigravity` threads at once (`threads.stop` releases the runtime; the next message starts a new one) and queues answering ones, stopping each when it goes idle; the queue survives plugin reloads. The Gemini popover shows how many are queued and offers a confirmed restart-now that interrupts them.

## Gemini quota source

The quota API (`retrieveUserQuotaSummary`) returns only the Claude and GPT group; the Gemini weekly and 5-hour windows come from `agy -p /usage` (no model turn, ~10 s). agy runs only while Gemini is in use: every 5 minutes while an Antigravity thread answers, once after its turn, when the popover opens on a reading older than 2 minutes, after an account switch, with `status --refresh`, and on the `geminiBackground` setting (`off`, `30m` default, `1h`). The plugin log names each read and its reason. The API is the fallback when agy fails. An unused window reads 100% left with a reset one full window from now; the popover then hides the reset.

Gemini is read with the agy OAuth token from the macOS Keychain (service `gemini`); when it is expired the plugin runs `agy models` to refresh it. A failure shows the reason in the Gemini popover and in `bb plugin logs fuel-bb`.

## Kimi Code quota

When bb's own kimi-code entry is not `ok`, the Kimi button reads `GET <base_url>/usages` with the kimi CLI's own login, nothing else (no model requests). `base_url` and the login file come from `~/.kimi-code/config.toml` (`[providers."managed:kimi-code"]` and its `.oauth` `key`): CLI 2.6 stores `credentials/<oauth key>.json`, so a hard-coded `credentials/kimi-code.json` reads as signed out, and the global region uses `api.kimi.ai`, not `api.kimi.com`. Windows shown: 5 hours, week (when the plan has one), month code, month total. The access token lives 15 minutes and only kimi refreshes it; the plugin never refreshes or copies it, and between kimi runs it shows the last measured windows (kept in plugin storage, numbers only) with a passed reset counted as unused. `bb fuel status` prints the Kimi windows too.

## Settings

A gear in every popover header opens one settings view: which provider buttons the strip shows (every provider bb found, plus Gemini; Context is always there, and the buttons share the width equally), the accent color (default: the bb theme accent) and the language (Auto, RU, EN). Settings live in the plugin's server storage (RPC `prefs` / `setPrefs`), so every window and device sees the same. Providers bb reports as `ok` are shown unless switched off; Gemini is shown only when switched on (on first read it is on when agy already returned a quota). Window and group labels from the server are keys (`5h`, `week`, `month_code`, `week_model:Fable`, `claude_gpt`) that the app translates.

## When an Antigravity (Gemini) request hits a limit

Some limits are hidden (for example image generation on `gemini-3.1-flash-image`) and show only as a quota or resource-exhausted error. When a generation fails that way:

1. Run `bb fuel switch-account next`. It prints the account it switched to, or fails when there is no other saved account; then report that and stop.
2. Do not retry in the same turn: this turn's `agy` process keeps the old login. Finish the turn and say the account was switched; the plugin restarts the thread when it goes idle, and the next message runs on the new account.
3. Do not switch more than once per failure, and never read `~/.gemini/oauth_creds.json` or `google_accounts.json` to tell the account: they belong to Gemini CLI, not agy. `bb fuel accounts` shows the active one.
