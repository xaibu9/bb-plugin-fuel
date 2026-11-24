// Fuel BB frontend: an app overlay that portals a full-width strip with
// provider and context buttons into the sidebar footer; each button opens a
// popover with details, and every popover header opens the shared settings.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  experimental_ProviderIcon as BbProviderIcon,
  experimental_useProviders,
  experimental_useRpcQuery,
  useBbContext,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { contract, GEMINI_ID, THEME_ACCENT, type LimitWindow, type Limits, type ModelQuota, type Prefs, type ProviderLimits, type ThreadContext } from "./src/shared/contract";
import { LangContext, resolveLang, STRINGS, useT } from "./src/app/i18n";
import "./app.css";

const PLUGIN_ID = "fuel-bb";
const REFRESH_MS = 2 * 60_000;
const ACTIVE_REFRESH_MS = 15_000;
const POPOVER_GAP = 8;
const VIEWPORT_MARGIN = 12;
const HIDE_FOOTER_CLASS = "lp-footer-hidden";

/** A provider id from bb, `gemini`, or `context`. */
type Section = string;
const CONTEXT = "context";

/** bb's display name and icon record for a provider id. */
function useProviderInfo(): (id: string) => { name: string; record: { id: string } } {
  const { providers } = experimental_useProviders();
  return useCallback(
    (id: string) => {
      const info = providers.find((p) => p.id === id);
      const name = info?.displayName ?? id.replace(/^acp-/, "").replace(/-code$/, "").replace(/^\w/, (c) => c.toUpperCase());
      return { name, record: info ?? { id } };
    },
    [providers],
  );
}

function ProviderIcon({ record }: { record: { id: string } }) {
  return <BbProviderIcon providerKind="agent" provider={record} className="lp-icon" aria-hidden />;
}

function rootElement(extra: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `lp-root ${extra}`;
  el.setAttribute("data-bb-plugin-root", "");
  el.setAttribute("data-bb-plugin", PLUGIN_ID);
  return el;
}

function visible(selector: string): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(selector));
  return all.find((el) => el.getClientRects().length > 0) ?? all[0] ?? null;
}

/** The thread the user is looking at: the highlighted sidebar row, else the route. */
function threadIdFromDom(): string | null {
  const row = document.querySelector<HTMLElement>('[data-sidebar-thread-id][aria-current="page"]');
  const fromRow = row?.getAttribute("data-sidebar-thread-id");
  if (fromRow) return fromRow;
  return /\b(thr_[a-z0-9]+)/i.exec(`${window.location.pathname}${window.location.hash}`)?.[1] ?? null;
}

/**
 * Puts a container in place of bb's sidebar footer row (hidden while it is
 * mounted), with the footer's horizontal padding. Also tracks the open thread.
 */
function useFooterHost(): { host: HTMLElement | null; domThreadId: string | null } {
  const [host] = useState(() => rootElement("lp-host"));
  const [attached, setAttached] = useState(false);
  const [domThreadId, setDomThreadId] = useState<string | null>(threadIdFromDom);
  useEffect(() => {
    let frame: number | null = null;
    const ensure = () => {
      frame = null;
      setDomThreadId(threadIdFromDom());
      const footer = visible('[data-sidebar="footer"]');
      const slot = footer?.parentElement;
      if (footer == null || slot == null) {
        document.documentElement.classList.remove(HIDE_FOOTER_CLASS);
        host.remove();
        setAttached(false);
        return;
      }
      if (footer.nextElementSibling !== host) footer.after(host);
      const cs = getComputedStyle(footer);
      for (const side of ["paddingLeft", "paddingRight"] as const) {
        if (host.style[side] !== cs[side]) host.style[side] = cs[side];
      }
      document.documentElement.classList.add(HIDE_FOOTER_CLASS);
      setAttached(true);
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(ensure);
    };
    ensure();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-current"] });
    window.addEventListener("popstate", schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener("popstate", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
      document.documentElement.classList.remove(HIDE_FOOTER_CLASS);
      host.remove();
    };
  }, [host]);
  return { host: attached ? host : null, domThreadId };
}

function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function useEvery(ms: number, fn: () => unknown) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const id = window.setInterval(() => ref.current(), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

type T = ReturnType<typeof useT>;

function formatIn(at: number, now: number, t: T): string {
  const min = Math.max(0, Math.round((at - now) / 60_000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return `${d} ${t.days} ${h} ${t.hours}`;
  if (h > 0) return `${h} ${t.hours} ${m} ${t.minutes}`;
  return `${m} ${t.minutes}`;
}

function formatAt(at: number, now: number, t: T): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(t.locale, { hour: "2-digit", minute: "2-digit" });
  if (new Date(now).toDateString() === date.toDateString()) return `${t.today} ${time}`;
  const days = (at - now) / 86_400_000;
  const day = days < 6 ? date.toLocaleDateString(t.locale, { weekday: "short" }) : date.toLocaleDateString(t.locale, { day: "numeric", month: "short" });
  return `${day} ${time}`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function level(percent: number | null): "ok" | "warn" | "crit" | undefined {
  if (percent === null) return undefined;
  return percent >= 95 ? "crit" : percent >= 80 ? "warn" : "ok";
}

const clamp = (p: number) => Math.max(0, Math.min(100, p));

/* Icons */

function GeminiIcon() {
  return (
    <svg viewBox="0 0 24 24" className="lp-icon" aria-hidden>
      <path d="M12 2C12.6 7.4 16.6 11.4 22 12 16.6 12.6 12.6 16.6 12 22 11.4 16.6 7.4 12.6 2 12 7.4 11.4 11.4 7.4 12 2Z" fill="currentColor" />
    </svg>
  );
}

function ContextIcon() {
  return (
    <svg viewBox="0 0 24 24" className="lp-icon" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.6 3h8.8C19.3 3 21 4.7 21 7.6v8.8c0 2.9-1.7 4.6-4.6 4.6H7.6C4.7 21 3 19.3 3 16.4V7.6C3 4.7 4.7 3 7.6 3Z" />
      <path d="M7.75 8.5h8.5M7.75 12h8.5M7.75 15.5h4.5" />
    </svg>
  );
}

/* Popover pieces */

function Meter({ label, percent, children }: { label: string; percent: number; children?: ReactNode }) {
  const p = clamp(percent);
  return (
    <div className="lp-meter" data-level={level(p)}>
      <div className="lp-meter-head">
        <span className="lp-meter-label">{label}</span>
        <span className="lp-pct">{Math.round(p)}%</span>
      </div>
      <span className="lp-bar" aria-hidden>
        <span className="lp-fill" style={{ width: `${p}%` }} />
      </span>
      {children}
    </div>
  );
}

function ResetLine({ at, now }: { at: number | null; now: number }) {
  const t = useT();
  if (at === null) return null;
  return (
    <div className="lp-meta-line">
      <span>{t.resetsIn(formatIn(at, now, t))}</span>
      <span>{formatAt(at, now, t)}</span>
    </div>
  );
}

function WindowMeter({ w, now }: { w: LimitWindow; now: number }) {
  const t = useT();
  const f = w.forecast;
  return (
    <Meter label={t.windowName(w.label)} percent={w.usedPercent}>
      <ResetLine at={w.resetsAt} now={now} />
      {f === null ? null : f.lasts ? (
        <div className="lp-forecast" data-ok>
          {f.projectedPercent === null ? t.lasts : t.lastsAt(Math.round(Math.min(f.projectedPercent, 100)))}
        </div>
      ) : (
        <div className="lp-forecast" data-short>
          {f.runOutAt === null ? t.exhausted : t.runsOut(formatIn(f.runOutAt, now, t))}
        </div>
      )}
    </Meter>
  );
}

/** Opens the shared settings view; set by the popover around every details view. */
const SettingsOpener = createContext<(() => void) | null>(null);

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M19.4 13.6a7.6 7.6 0 0 0 0-3.2l1.7-1.3-1.8-3.1-2 .8a7.5 7.5 0 0 0-2.8-1.6L14.2 3h-3.6l-.3 2.2a7.5 7.5 0 0 0-2.8 1.6l-2-.8-1.8 3.1 1.7 1.3a7.6 7.6 0 0 0 0 3.2l-1.7 1.3 1.8 3.1 2-.8a7.5 7.5 0 0 0 2.8 1.6l.3 2.2h3.6l.3-2.2a7.5 7.5 0 0 0 2.8-1.6l2 .8 1.8-3.1-1.7-1.3Z" />
    </svg>
  );
}

function PopHeader({ icon, title, chip }: { icon: ReactNode; title: string; chip?: string }) {
  const t = useT();
  const openSettings = useContext(SettingsOpener);
  return (
    <div className="lp-pop-head">
      <span className="lp-pop-icon">{icon}</span>
      <span className="lp-pop-title" id="lp-pop-title">
        {title}
      </span>
      {chip ? <span className="lp-chip">{chip}</span> : null}
      {openSettings === null ? null : (
        <button type="button" className="lp-gear" aria-label={t.settings} title={t.settings} onClick={openSettings}>
          <GearIcon />
        </button>
      )}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="lp-empty">{children}</p>;
}

function ProviderDetails({ provider, name, icon, now }: { provider: ProviderLimits | undefined; name: string; icon: ReactNode; now: number }) {
  const t = useT();
  const stale = provider?.source === "plugin" && provider.measuredAt !== null && now - provider.measuredAt > 20 * 60_000;
  return (
    <>
      <PopHeader icon={icon} title={provider?.plan ? `${name} · ${provider.plan}` : name} />
      {provider === undefined ? (
        <Empty>{t.loadingLimits}</Empty>
      ) : provider.status !== "ok" ? (
        <Empty>{t.providerStatus(provider.status, provider.message)}</Empty>
      ) : provider.windows.length === 0 ? (
        <Empty>{provider.source === "plugin" ? t.pluginNoData : t.claudeEmpty}</Empty>
      ) : (
        <div className="lp-stack">
          {provider.windows.map((w) => (
            <WindowMeter key={w.label} w={w} now={now} />
          ))}
        </div>
      )}
      {stale && provider?.measuredAt != null ? <p className="lp-hint">{t.measuredStale(formatAt(provider.measuredAt, now, t))}</p> : null}
    </>
  );
}

type AccountConfirm = { kind: "switch" | "remove"; id: string; label: string } | { kind: "restart" };

function SwitchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16.8 3.5 20 6.7l-3.2 3.2M20 6.7H8.6A4.6 4.6 0 0 0 4 11.3M7.2 20.5 4 17.3l3.2-3.2M4 17.3h11.4a4.6 4.6 0 0 0 4.6-4.6" />
    </svg>
  );
}

function AccountsSection() {
  const t = useT();
  const rpc = useRpc<typeof contract>();
  const navigate = useBbNavigate();
  const query = experimental_useRpcQuery({ contract, method: "accounts", input: null });
  const [confirm, setConfirm] = useState<AccountConfirm | null>(null);
  const [pending, setPending] = useState(false);
  const [codeValue, setCodeValue] = useState("");
  const st = query.data;
  const loginPending = st?.login != null;
  useEvery(loginPending ? 2_000 : REFRESH_MS, () => void query.refetch());
  const run = async (action: () => Promise<{ ok: boolean; message: string | null }>, done: ((message: string | null) => string) | null) => {
    setPending(true);
    try {
      const result = await action();
      if (!result.ok) toast.error(t.failed(result.message ?? t.error));
      else if (done !== null) toast.success(done(result.message));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t.failedShort);
    } finally {
      setPending(false);
      setConfirm(null);
      void query.refetch();
    }
  };
  if (st === undefined) return <Empty>{query.error ? t.accountsFailed : t.loadingAccounts}</Empty>;
  if (!st.enabled) return null;
  const active = st.accounts.find((a) => a.id === st.activeId) ?? null;
  const others = st.accounts.filter((a) => a.id !== st.activeId);
  return (
    <section className="lp-accounts" aria-label={t.accountsLabel}>
      <div className="lp-account lp-account-active">
        <span className="lp-account-dot" data-on={st.signedIn || undefined} aria-hidden />
        <span className="lp-account-name">{st.signedIn ? (active?.label ?? st.activeEmail ?? t.noEmail) : loginPending ? t.waitingGoogle : t.signedOut}</span>
      </div>
      {others.map((a) => (
        <div className="lp-account" key={a.id}>
          <span className="lp-account-dot" aria-hidden />
          <span className="lp-account-name" title={a.email ?? undefined}>
            {a.label}
          </span>
          <button type="button" className="lp-icon-btn" aria-label={t.switchTo(a.label)} title={t.switch} disabled={pending || loginPending} onClick={() => setConfirm({ kind: "switch", id: a.id, label: a.label })}>
            <SwitchIcon />
          </button>
          <button type="button" className="lp-icon-btn" aria-label={t.forgetNamed(a.label)} title={t.forget} disabled={pending || loginPending} onClick={() => setConfirm({ kind: "remove", id: a.id, label: a.label })}>
            <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M7 7l10 10M17 7L7 17" />
            </svg>
          </button>
        </div>
      ))}
      {st.restartThreads.length > 0 && confirm === null ? (
        <div className="lp-restart">
          <p className="lp-hint lp-warn-text">{t.restartPending(st.restartThreads.length)}</p>
          {st.restartThreads.map((th) => (
            <button type="button" key={th.id} className="lp-thread-link" onClick={() => navigate.toThread(th.id)} title={th.title}>
              {th.title}
            </button>
          ))}
          <button type="button" className="lp-link" disabled={pending} onClick={() => setConfirm({ kind: "restart" })}>
            {t.restartNow}
          </button>
        </div>
      ) : null}
      {loginPending ? (
        <div className="lp-login">
          <p className="lp-hint">{t.loginHint}</p>
          <form
            className="lp-code"
            onSubmit={(e) => {
              e.preventDefault();
              const code = codeValue.trim();
              if (code !== "") void run(() => rpc.call("submitLoginCode", { code }), () => t.codeSent).then(() => setCodeValue(""));
            }}
          >
            <input className="lp-input" value={codeValue} onChange={(e) => setCodeValue(e.target.value)} placeholder={t.code} aria-label={t.code} autoComplete="off" spellCheck={false} />
            <button type="submit" className="lp-btn lp-btn-sm" disabled={pending || codeValue.trim() === ""}>
              {t.enter}
            </button>
          </form>
          <div className="lp-confirm-actions">
            <button type="button" className="lp-btn" disabled={pending} onClick={() => run(() => rpc.call("cancelAddAccount", null), null)}>
              {t.cancel}
            </button>
            {st.login?.url ? (
              <a className="lp-btn lp-btn-primary" href={st.login.url} target="_blank" rel="noreferrer">
                {t.openLogin}
              </a>
            ) : (
              <span className="lp-btn lp-btn-primary" aria-disabled>
                {t.opening}
              </span>
            )}
          </div>
        </div>
      ) : confirm === null ? (
        <button type="button" className="lp-link" disabled={pending} onClick={() => run(() => rpc.call("addAccount", null), null)}>
          {t.addAccount}
        </button>
      ) : (
        <div className="lp-confirm" role="alertdialog" aria-label={t.confirm}>
          <span className="lp-confirm-text">
            {confirm.kind === "switch" ? t.confirmSwitch(confirm.label) : confirm.kind === "remove" ? t.confirmForget(confirm.label) : t.confirmRestartNow}
          </span>
          {confirm.kind === "switch" ? (
            <p className="lp-hint">
              {t.switchHint}
            </p>
          ) : null}
          <div className="lp-confirm-actions">
            <button type="button" className="lp-btn" disabled={pending} onClick={() => setConfirm(null)}>
              {t.cancel}
            </button>
            <button
              type="button"
              className="lp-btn lp-btn-primary"
              disabled={pending}
              autoFocus
              onClick={() =>
                confirm.kind === "switch"
                  ? run(() => rpc.call("switchAccount", { id: confirm.id }), (m) => `Antigravity: ${m ?? confirm.label}`)
                  : confirm.kind === "remove"
                    ? run(() => rpc.call("removeAccount", { id: confirm.id }), () => t.forgotten(confirm.label))
                    : run(() => rpc.call("restartAntigravityNow", null), null)
              }
            >
              {pending ? t.wait : confirm.kind === "switch" ? t.yesSwitch : confirm.kind === "remove" ? t.yesForget : t.yesRestart}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** A group without windows of its own: one line for its tightest model. */
function modelsWindow(models: ModelQuota[]): Array<{ label: string; usedPercent: number; resetsAt: number | null }> {
  if (models.length === 0) return [];
  const top = models.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
  return [{ label: "models", usedPercent: top.usedPercent, resetsAt: top.resetsAt }];
}

function GeminiDetails({ gemini, now, onRefresh }: { gemini: Limits["gemini"] | undefined; now: number; onRefresh: () => Promise<unknown> }) {
  const t = useT();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };
  const hasData = gemini !== undefined && gemini.groups.length > 0 && gemini.measuredAt !== null;
  const failing = gemini?.status === "error" && gemini.error !== null;
  const groups = hasData
    ? gemini.groups.map((g) => {
        const windows = g.windows.length > 0 ? g.windows : modelsWindow(g.models);
        return (
          <section className="lp-group" key={g.title} data-stale={failing || undefined}>
            <span className="lp-group-title">{t.groupName(g.title)}</span>
            <div className="lp-stack">
              {windows.map((w) => (
                <WindowMeter key={w.label} w={{ ...w, forecast: null }} now={now} />
              ))}
            </div>
          </section>
        );
      })
    : null;
  return (
    <>
      <PopHeader icon={<GeminiIcon />} title="Gemini" chip={t.viaAgy} />
      <AccountsSection />
      {gemini === undefined ? (
        <Empty>{t.loadingQuota}</Empty>
      ) : gemini.status === "pending" || (gemini.status === "ok" && !hasData) ? (
        <Empty>{t.geminiFirst}</Empty>
      ) : failing && !hasData ? (
        <div className="lp-stack">
          <Empty>{t.geminiError(gemini.error!.code)}</Empty>
          <button type="button" className="lp-btn lp-btn-wide" disabled={refreshing} onClick={refresh}>
            {refreshing ? t.wait : t.checkAgain}
          </button>
        </div>
      ) : (
        <>
          {groups}
          <div className="lp-measured">
            <span data-warn={failing || undefined}>
              {failing ? t.geminiStale(formatAt(gemini.measuredAt!, now, t)) : t.measuredEvery(formatAt(gemini.measuredAt!, now, t))}
            </span>
            <button type="button" className="lp-link" disabled={refreshing} onClick={refresh}>
              {refreshing ? t.wait : failing ? t.retryNow : t.refresh}
            </button>
          </div>
        </>
      )}
    </>
  );
}

function ContextDetails({ threadId, state, error, onCompacted }: { threadId: string | null; state: ThreadContext | undefined; error: boolean; onCompacted: () => void }) {
  const t = useT();
  const rpc = useRpc<typeof contract>();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const ctx = state?.context ?? null;
  const active = state?.active ?? false;
  useEffect(() => setConfirming(false), [threadId, active]);
  const compact = async () => {
    if (threadId === null) return;
    setPending(true);
    try {
      const result = await rpc.call("compact", { threadId });
      if (!result.ok) toast.error(t.compactFailed(result.message ?? t.error));
      else toast.success(t.compactStarted);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t.compactFailedShort);
    } finally {
      setPending(false);
      setConfirming(false);
      onCompacted();
    }
  };
  return (
    <>
      <PopHeader icon={<ContextIcon />} title={t.context} />
      {threadId === null ? (
        <Empty>{t.openThread}</Empty>
      ) : state === undefined ? (
        <Empty>{error ? t.contextFailed : t.loadingContext}</Empty>
      ) : ctx === null ? (
        <Empty>{t.contextUnknown}</Empty>
      ) : (
        <>
          <div className="lp-ctx" data-level={level(clamp(ctx.percent))}>
            <span className="lp-ctx-pct">{Math.round(clamp(ctx.percent))}%</span>
            <span className="lp-ctx-tokens" title={t.tokensOf(ctx.usedTokens.toLocaleString(t.locale), ctx.limitTokens.toLocaleString(t.locale))}>
              {formatTokens(ctx.usedTokens)} / {formatTokens(ctx.limitTokens)}
            </span>
          </div>
          <span className="lp-bar lp-bar-ctx" aria-hidden data-level={level(clamp(ctx.percent))}>
            <span className="lp-fill" style={{ width: `${clamp(ctx.percent)}%` }} />
          </span>
          {confirming ? (
            <div className="lp-confirm" role="alertdialog" aria-label={t.confirmCompactLabel}>
              <span className="lp-confirm-text">{t.confirmCompact}</span>
              <div className="lp-confirm-actions">
                <button type="button" className="lp-btn" onClick={() => setConfirming(false)} disabled={pending}>
                  {t.cancel}
                </button>
                <button type="button" className="lp-btn lp-btn-primary" onClick={compact} disabled={pending || active} autoFocus>
                  {pending ? t.compacting : t.yesCompact}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="lp-btn lp-btn-wide" disabled={active || pending} onClick={() => setConfirming(true)}>
              {t.compact}
            </button>
          )}
          {active ? <p className="lp-hint">{t.answering}</p> : null}
        </>
      )}
    </>
  );
}

/* Popover shell */

function Popover({ anchor, onClose, style, children }: { anchor: HTMLElement; onClose: (restoreFocus: boolean) => void; style?: React.CSSProperties; children: ReactNode }) {
  const [host] = useState(() => rootElement("lp-pop-host"));
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; width: number; bottom: number; maxHeight: number } | null>(null);
  useEffect(() => {
    document.body.append(host);
    return () => host.remove();
  }, [host]);
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect();
      if (r.width === 0) {
        onClose(false);
        return;
      }
      const width = Math.max(r.width, 260);
      const left = Math.max(VIEWPORT_MARGIN, Math.min(r.left, window.innerWidth - width - VIEWPORT_MARGIN));
      setBox({ left, width, bottom: window.innerHeight - r.top + POPOVER_GAP, maxHeight: Math.max(120, r.top - POPOVER_GAP - VIEWPORT_MARGIN) });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchor, onClose]);
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      onClose(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose(true);
      }
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);
  if (box === null) return null;
  return createPortal(
    <div
      ref={ref}
      className="lp-pop"
      role="dialog"
      aria-labelledby="lp-pop-title"
      style={{ ...style, left: box.left, width: box.width, bottom: box.bottom, maxHeight: box.maxHeight }}
    >
      {children}
    </div>,
    host,
  );
}

/* Strip */

/** The strip shows the longest window for every provider: month, else week, else the rest. */
function longest(windows: Array<{ label: string; usedPercent: number }>): { percent: number; window: string } | null {
  const rank = (label: string) => (/^month/.test(label) ? 2 : /^week/.test(label) ? 1 : 0);
  const top = Math.max(-1, ...windows.map((w) => rank(w.label)));
  const picked = windows.filter((w) => rank(w.label) === top);
  if (picked.length === 0) return null;
  const worst = picked.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
  return { percent: clamp(worst.usedPercent), window: worst.label };
}

function Segment({
  id,
  label,
  icon,
  percent,
  windowLabel,
  badge = null,
  open,
  onToggle,
}: {
  id: Section;
  label: string;
  icon: ReactNode;
  percent: number | null;
  windowLabel?: string | null;
  /** Shown instead of the percent: "···" while measuring, "!" when the source needs attention. */
  badge?: string | null;
  open: boolean;
  onToggle: (id: Section, el: HTMLButtonElement) => void;
}) {
  const t = useT();
  const name = windowLabel ? t.windowName(windowLabel) : null;
  const value = percent === null ? t.noData : t.used(Math.round(percent));
  return (
    <button
      type="button"
      className="lp-seg"
      data-section={id}
      data-level={level(percent)}
      data-open={open || undefined}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={name === null ? `${label}: ${value}` : `${label}, ${name}: ${value}`}
      title={name === null || percent === null ? label : `${label}: ${name.toLowerCase()}, ${value}`}
      style={{ "--lp-seg-fill": `${percent ?? 0}%` } as React.CSSProperties}
      onClick={(e) => onToggle(id, e.currentTarget)}
    >
      {icon}
      <span className="lp-seg-pct" data-badge={badge === "!" || undefined}>
        {badge ?? (percent === null ? "–" : `${Math.round(percent)}%`)}
      </span>
    </button>
  );
}

/* Settings */

const ACCENTS = ["#b795f3", "#7aa2f7", "#8be9fd", "#ff79c6", "#ffb86c"];
const DEFAULT_PREFS: Prefs = { show: {}, accent: THEME_ACCENT, lang: "auto" };

/** A provider's strip button: shown unless switched off; Gemini only when switched on. */
const shown = (prefs: Prefs, id: string) => (id === GEMINI_ID ? prefs.show[id] === true : prefs.show[id] !== false);
/** Inline accent for a picked color; the shared accent (sidebar or theme) needs nothing. */
function accentVars(accent: Prefs["accent"]): React.CSSProperties {
  return accent === THEME_ACCENT ? {} : ({ "--lp-accent": accent } as React.CSSProperties);
}

/** A hex field that commits a valid #rrggbb on Enter or blur and reverts anything else. */
function HexInput({ value, label, onCommit }: { value: string; label: string; onCommit: (hex: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const hex = `#${draft.trim().replace(/^#/, "").toLowerCase()}`;
    if (/^#[0-9a-f]{6}$/.test(hex) && hex !== value.toLowerCase()) onCommit(hex);
    else setDraft(value);
  };
  return (
    <input
      className="lp-input lp-hex"
      value={draft}
      aria-label={label}
      spellCheck={false}
      maxLength={7}
      placeholder="#rrggbb"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

/** Account switching is off by default; turning it on first shows exactly what it touches. */
function AccountSwitchingToggle() {
  const t = useT();
  const rpc = useRpc<typeof contract>();
  const query = experimental_useRpcQuery({ contract, method: "accounts", input: null });
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const on = query.data?.enabled === true;
  const set = async (next: boolean) => {
    setPending(true);
    try {
      await rpc.call("setAccountSwitching", { on: next });
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t.failedShort);
    } finally {
      setPending(false);
      setConfirming(false);
      void query.refetch();
    }
  };
  return (
    <div className="lp-switching">
      <label className="lp-check">
        <input
          type="checkbox"
          role="switch"
          disabled={pending || query.data === undefined}
          checked={on}
          onChange={(e) => (e.target.checked ? setConfirming(true) : void set(false))}
        />
        <span>{t.switching}</span>
      </label>
      <p className="lp-hint">{t.switchingHint}</p>
      {confirming ? (
        <div className="lp-confirm lp-confirm-warn" role="alertdialog" aria-label={t.switchingConfirmTitle}>
          <span className="lp-confirm-text">{t.switchingConfirmTitle}</span>
          <p className="lp-hint">{t.switchingConfirmLead}</p>
          <ul className="lp-bullets">
            {t.switchingConfirmItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="lp-hint">{t.switchingConfirmTail}</p>
          <div className="lp-confirm-actions">
            <button type="button" className="lp-btn" disabled={pending} onClick={() => setConfirming(false)}>
              {t.cancel}
            </button>
            <button type="button" className="lp-btn lp-btn-primary" disabled={pending} autoFocus onClick={() => void set(true)}>
              {pending ? t.wait : t.turnOn}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SettingsView({
  prefs,
  disabled,
  providers,
  gemini,
  onChange,
  onBack,
}: {
  prefs: Prefs;
  disabled: boolean;
  providers: ProviderLimits[];
  gemini: Limits["gemini"] | undefined;
  onChange: (next: Prefs) => void;
  onBack: () => void;
}) {
  const t = useT();
  const info = useProviderInfo();
  const themed = prefs.accent === THEME_ACCENT;
  const custom = !themed && !ACCENTS.includes(prefs.accent.toLowerCase());
  const toggle = (id: string, on: boolean) => onChange({ ...prefs, show: { ...prefs.show, [id]: on } });
  return (
    <>
      <div className="lp-pop-head">
        <button type="button" className="lp-icon-btn" aria-label={t.back} title={t.back} onClick={onBack} autoFocus>
          <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.5 5.5 8 12l6.5 6.5" />
          </svg>
        </button>
        <span className="lp-pop-title" id="lp-pop-title">
          {t.settings}
        </span>
      </div>
      <fieldset className="lp-field" disabled={disabled}>
        <legend className="lp-field-title">{t.fromBb}</legend>
        {providers.length === 0 ? <p className="lp-hint">{t.noProviders}</p> : null}
        {providers.map((p) => {
          const { name, record } = info(p.id);
          const ready = p.status === "ok";
          return (
            <label className="lp-check" key={p.id} data-off={ready ? undefined : ""}>
              <input type="checkbox" disabled={!ready} checked={ready && shown(prefs, p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
              <span className="lp-check-icon">
                <ProviderIcon record={record} />
              </span>
              <span>{name}</span>
              <span className="lp-check-source">{ready ? (p.plan ?? "") : t.providerShort(p.status)}</span>
            </label>
          );
        })}
        <p className="lp-hint">{t.fromBbHint}</p>
      </fieldset>
      <fieldset className="lp-field" disabled={disabled}>
        <legend className="lp-field-title">{t.ownSources}</legend>
        <label className="lp-check" data-off={gemini?.supported === false ? "" : undefined}>
          <input
            type="checkbox"
            disabled={gemini?.supported === false}
            checked={gemini?.supported !== false && shown(prefs, GEMINI_ID)}
            onChange={(e) => toggle(GEMINI_ID, e.target.checked)}
          />
          <span className="lp-check-icon">
            <GeminiIcon />
          </span>
          <span>Gemini</span>
          <span className="lp-check-source">{gemini?.supported === false ? t.macOnly : "Antigravity"}</span>
        </label>
        {gemini?.supported === false ? (
          <p className="lp-hint">{t.geminiNotMac}</p>
        ) : shown(prefs, GEMINI_ID) ? (
          <>
            <ul className="lp-bullets">
              <li>{t.geminiDoes1}</li>
              <li>{t.geminiDoes2}</li>
            </ul>
            <AccountSwitchingToggle />
          </>
        ) : (
          <p className="lp-hint">{t.geminiOffHint}</p>
        )}
        <p className="lp-hint">{t.contextAlways}</p>
      </fieldset>
      <fieldset className="lp-field" disabled={disabled}>
        <legend className="lp-field-title">{t.accent}</legend>
        <div className="lp-swatches">
          <button
            type="button"
            className="lp-swatch lp-swatch-theme"
            aria-label={t.themeAccent}
            title={t.themeAccent}
            aria-pressed={themed}
            onClick={() => onChange({ ...prefs, accent: THEME_ACCENT })}
          />
          {ACCENTS.map((color) => (
            <button
              type="button"
              key={color}
              className="lp-swatch"
              style={{ background: color }}
              aria-label={color}
              aria-pressed={prefs.accent.toLowerCase() === color}
              onClick={() => onChange({ ...prefs, accent: color })}
            />
          ))}
          <label className="lp-swatch lp-swatch-custom" aria-pressed={custom} title={t.customColor} style={custom ? { background: prefs.accent } : undefined}>
            <input type="color" value={themed ? "#888888" : prefs.accent} aria-label={t.customColor} onChange={(e) => onChange({ ...prefs, accent: e.target.value })} />
          </label>
          <HexInput value={themed ? "" : prefs.accent} label={t.customColor} onCommit={(accent) => onChange({ ...prefs, accent })} />
        </div>
      </fieldset>
      <fieldset className="lp-field" disabled={disabled}>
        <legend className="lp-field-title">{t.language}</legend>
        <div className="lp-segmented" role="radiogroup" aria-label={t.language}>
          {(
            [
              ["auto", t.langAuto],
              ["ru", "RU"],
              ["en", "EN"],
            ] as const
          ).map(([value, name]) => (
            <button type="button" key={value} role="radio" aria-checked={prefs.lang === value} onClick={() => onChange({ ...prefs, lang: value })}>
              {name}
            </button>
          ))}
        </div>
      </fieldset>
    </>
  );
}

function Panel({ threadId, prefs, prefsLoaded, onPrefs }: { threadId: string | null; prefs: Prefs; prefsLoaded: boolean; onPrefs: (next: Prefs) => void }) {
  const t = useT();
  const now = useNow();
  const info = useProviderInfo();
  const rpc = useRpc<typeof contract>();
  const limits = experimental_useRpcQuery({ contract, method: "limits", input: null });
  useEvery(REFRESH_MS, limits.refetch);
  const thread = experimental_useRpcQuery({ contract, method: "thread", input: { threadId: threadId ?? "-" }, enabled: threadId !== null });
  const threadState = threadId !== null && thread.data?.threadId === threadId ? thread.data : undefined;
  useEvery(threadState?.active ? ACTIVE_REFRESH_MS : REFRESH_MS, () => {
    if (threadId !== null) void thread.refetch();
  });
  const stripRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Section | null>(null);
  const [settings, setSettings] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const providers = limits.data?.providers ?? [];
  const gemini = limits.data?.gemini;
  const geminiGroup = gemini === undefined ? undefined : (gemini.groups.find((g) => g.title === "gemini") ?? gemini.groups[0]);
  const geminiBadge =
    gemini === undefined || gemini.status === "pending" || (gemini.status === "ok" && geminiGroup === undefined)
      ? "···"
      : gemini.status === "error" && geminiGroup === undefined
        ? "!"
        : null;
  const geminiTop = geminiGroup === undefined ? null : longest(geminiGroup.windows.length > 0 ? geminiGroup.windows : modelsWindow(geminiGroup.models));
  const ctxPct = threadState?.context ? clamp(threadState.context.percent) : null;

  const segments: Array<{ id: string; label: string; icon: ReactNode; top: ReturnType<typeof longest>; badge?: string | null }> = [
    ...providers
      .filter((p) => p.status === "ok" && shown(prefs, p.id))
      .map((p) => {
        const { name, record } = info(p.id);
        return { id: p.id, label: name, icon: <ProviderIcon record={record} />, top: longest(p.windows) };
      }),
    ...(shown(prefs, GEMINI_ID) && gemini?.supported !== false ? [{ id: GEMINI_ID, label: "Gemini", icon: <GeminiIcon />, top: geminiTop, badge: geminiBadge }] : []),
  ];
  const openProvider = providers.find((p) => p.id === open);

  useEffect(() => {
    if (open !== null && open !== CONTEXT && !settings && !segments.some((sg) => sg.id === open)) setOpen(null);
  }, [open, segments, settings]);

  const onToggle = useCallback(
    (id: Section, el: HTMLButtonElement) => {
      triggerRef.current = el;
      setSettings(false);
      setOpen((cur) => (cur === id ? null : id));
      if (id === CONTEXT && threadId !== null) void thread.refetch();
    },
    [thread, threadId],
  );
  const onClose = useCallback((restoreFocus: boolean) => {
    setOpen(null);
    setSettings(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);
  const accentStyle = accentVars(prefs.accent);

  return (
    <>
      <div
        className="lp-strip"
        ref={stripRef}
        role="group"
        aria-label={t.stripLabel}
        style={{ ...accentStyle, gridTemplateColumns: `repeat(${segments.length + 1}, minmax(0, 1fr))` }}
      >
        {segments.map((sg) => (
          <Segment key={sg.id} id={sg.id} label={sg.label} icon={sg.icon} percent={sg.top?.percent ?? null} windowLabel={sg.top?.window ?? null} badge={sg.badge ?? null} open={open === sg.id} onToggle={onToggle} />
        ))}
        <Segment id={CONTEXT} label={t.context} icon={<ContextIcon />} percent={ctxPct} open={open === CONTEXT} onToggle={onToggle} />
      </div>
      {open !== null && stripRef.current !== null ? (
        <Popover anchor={stripRef.current} onClose={onClose} style={accentStyle}>
          {settings ? (
            <SettingsView prefs={prefs} disabled={!prefsLoaded} providers={providers} gemini={gemini} onChange={onPrefs} onBack={() => setSettings(false)} />
          ) : (
            <SettingsOpener.Provider value={() => setSettings(true)}>
              {open === GEMINI_ID ? (
                <GeminiDetails gemini={gemini} now={now} onRefresh={() => rpc.call("refreshGemini", null).then(() => limits.refetch())} />
              ) : open === CONTEXT ? (
                <ContextDetails threadId={threadId} state={threadState} error={thread.error != null} onCompacted={() => void thread.refetch()} />
              ) : (
                <ProviderDetails provider={openProvider} name={info(open).name} icon={<ProviderIcon record={info(open).record} />} now={now} />
              )}
            </SettingsOpener.Provider>
          )}
        </Popover>
      ) : null}
    </>
  );
}

/** Settings from the server, changed optimistically; saves run in order and a failed one rolls back. */
const PREFS_CACHE = "fuel-bb:prefs";

/** The last settings the server sent, only to paint the first frame before it answers. */
function cachedPrefs(): Prefs | null {
  try {
    const raw = window.localStorage.getItem(PREFS_CACHE);
    return raw === null ? null : (JSON.parse(raw) as Prefs);
  } catch {
    return null;
  }
}

function usePrefs(): [Prefs, boolean, (next: Prefs) => void] {
  const rpc = useRpc<typeof contract>();
  const query = experimental_useRpcQuery({ contract, method: "prefs", input: null });
  const [local, setLocal] = useState<Prefs | null>(null);
  const [cached] = useState(cachedPrefs);
  const seq = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (query.data === undefined) return;
    try {
      window.localStorage.setItem(PREFS_CACHE, JSON.stringify(query.data));
    } catch {
      // A cache miss only costs the first frame.
    }
  }, [query.data]);
  const prefs = local ?? query.data ?? cached ?? DEFAULT_PREFS;
  const loaded = query.data !== undefined;
  const lang = resolveLang(prefs.lang);
  const save = useCallback(
    (next: Prefs) => {
      const mine = ++seq.current;
      setLocal(next);
      chain.current = chain.current
        .then(() => rpc.call("setPrefs", next))
        .then(
          async () => {
            if (mine !== seq.current) return;
            await query.refetch();
            if (mine === seq.current) setLocal(null);
          },
          () => {
            if (mine === seq.current) setLocal(null);
            toast.error(STRINGS[lang].saveFailed);
          },
        );
    },
    [rpc, query, lang],
  );
  return [prefs, loaded, save];
}

function LimitsOverlay() {
  const { host, domThreadId } = useFooterHost();
  const { threadId: routeThreadId } = useBbContext();
  const [prefs, prefsLoaded, setPrefs] = usePrefs();
  const threadId = domThreadId ?? routeThreadId;
  return host === null
    ? null
    : createPortal(
        <LangContext.Provider value={resolveLang(prefs.lang)}>
          <Panel threadId={threadId} prefs={prefs} prefsLoaded={prefsLoaded} onPrefs={setPrefs} />
        </LangContext.Provider>,
        host,
      );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "sidebar-limits", component: LimitsOverlay });
});
