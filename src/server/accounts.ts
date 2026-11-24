// Antigravity account switching. agy keeps its login in the Keychain item
// gemini/antigravity; each saved account is a copy of that item under its own
// service. Login blobs go Keychain to Keychain through `security -i` stdin:
// never into argv, logs, plugin storage or disk.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { GeminiAccounts } from "../shared/contract";

const SECURITY = "/usr/bin/security";
const ACTIVE = { service: "gemini", account: "antigravity" };
// The plugin was called Limits Panel; saved logins keep that Keychain service so they survive the rename.
const STORE_SERVICE = "limits-panel-gemini-accounts";
const KEYRING_PREFIX = "go-keyring-base64:";
/** Characters a go-keyring blob can hold; anything else is refused so stdin commands stay unambiguous. */
const SAFE_BLOB = /^[A-Za-z0-9+/=:_-]+$/;
const SAFE_ID = /^acc_[a-f0-9]{12}$/;

export class AccountError extends Error {}

export interface SavedAccount {
  id: string;
  label: string;
  email: string | null;
  savedAt: number;
}

interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

const INDEX_KEY = "gemini-accounts";

function readItem(service: string, account: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(SECURITY, ["find-generic-password", "-s", service, "-a", account, "-w"], { timeout: 10_000, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

function securityStdin(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(SECURITY, ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    child.on("error", () => reject(new AccountError("security tool failed to start")));
    child.stdin.on("error", () => reject(new AccountError("Keychain write failed")));
    child.on("close", (code) => {
      clearTimeout(timer);
      // `security -i` reports item errors on stderr with a zero exit code.
      if (code !== 0 || /error|could not|failed/i.test(stderr)) reject(new AccountError("Keychain write failed"));
      else resolve();
    });
    child.stdin.end(`${command}\n`);
  });
}

/** Writes the item and reads it back, so a write `security -i` silently dropped is an error. */
async function writeItem(service: string, account: string, blob: string): Promise<void> {
  if (!SAFE_BLOB.test(blob)) throw new AccountError("login data is not in the expected format");
  await securityStdin(`add-generic-password -U -s ${service} -a ${account} -w ${blob}`);
  if ((await readItem(service, account)) !== blob) throw new AccountError("Keychain write did not stick");
}

/** Exit code 44 is "item not found", which counts as deleted. */
function deleteItem(service: string, account: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(SECURITY, ["delete-generic-password", "-s", service, "-a", account], { timeout: 10_000 }, (error) => {
      const code = (error as { code?: unknown } | null)?.code;
      if (error && code !== 44) reject(new AccountError("Keychain delete failed"));
      else resolve();
    });
  });
}

function decode(blob: string): { email: string | null; refresh: string | null } {
  try {
    const json = blob.startsWith(KEYRING_PREFIX) ? Buffer.from(blob.slice(KEYRING_PREFIX.length), "base64").toString("utf8") : blob;
    const parsed = JSON.parse(json) as { id_token_email?: unknown; token?: { refresh_token?: unknown } };
    return {
      email: typeof parsed.id_token_email === "string" && parsed.id_token_email !== "" ? parsed.id_token_email : null,
      refresh: typeof parsed.token?.refresh_token === "string" ? parsed.token.refresh_token : null,
    };
  } catch {
    return { email: null, refresh: null };
  }
}

export function createAccounts(kv: Kv) {
  const list = async () => (await kv.get<SavedAccount[]>(INDEX_KEY)) ?? [];
  // Mutations run one at a time: they read and rewrite the index and the active item.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  /** The saved account the active login belongs to: same email, else same refresh token. */
  const match = async (blob: string, accounts: SavedAccount[]) => {
    const active = decode(blob);
    if (active.email !== null) return [...accounts].reverse().find((a) => a.email === active.email) ?? null;
    for (const a of accounts) {
      const saved = await readItem(STORE_SERVICE, a.id);
      if (saved !== null && active.refresh !== null && decode(saved).refresh === active.refresh) return a;
    }
    return null;
  };

  const state = async (): Promise<Omit<GeminiAccounts, "enabled" | "login" | "restartThreads">> => {
    const accounts = await list();
    const blob = await readItem(ACTIVE.service, ACTIVE.account);
    const active = blob === null ? null : await match(blob, accounts);
    return {
      signedIn: blob !== null,
      activeEmail: blob === null ? null : decode(blob).email,
      activeId: active?.id ?? null,
      accounts: accounts.map(({ id, label, email, savedAt }) => ({ id, label, email, savedAt })),
    };
  };

  const save = async (blob: string, label: string | null): Promise<SavedAccount> => {
    const accounts = await list();
    const existing = await match(blob, accounts);
    const email = decode(blob).email;
    const account: SavedAccount = {
      id: existing?.id ?? `acc_${randomBytes(6).toString("hex")}`,
      label: label?.trim() || existing?.label || email || `Account ${accounts.length + 1}`,
      email,
      savedAt: Date.now(),
    };
    await writeItem(STORE_SERVICE, account.id, blob);
    await kv.set(INDEX_KEY, [...accounts.filter((a) => a.id !== account.id), account]);
    return account;
  };

  const activeBlob = async () => {
    const blob = await readItem(ACTIVE.service, ACTIVE.account);
    if (blob === null) throw new AccountError("agy is not signed in");
    return blob;
  };

  const saveCurrent = (label: string | null) => serial(async () => save(await activeBlob(), label));

  const switchTo = (id: string): Promise<SavedAccount> => serial(async () => {
    if (!SAFE_ID.test(id)) throw new AccountError("unknown account");
    const accounts = await list();
    const target = accounts.find((a) => a.id === id);
    if (target === undefined) throw new AccountError("unknown account");
    const next = await readItem(STORE_SERVICE, id);
    if (next === null) throw new AccountError("saved login is missing from the Keychain");
    // Keep the active login (saving it if it never was) before replacing it.
    const current = await readItem(ACTIVE.service, ACTIVE.account);
    if (current !== null) {
      const owner = (await match(current, accounts)) ?? (await save(current, null));
      if (owner.id === id) {
        await writeItem(STORE_SERVICE, id, current);
        return target;
      }
      await writeItem(STORE_SERVICE, owner.id, current);
    }
    await writeItem(ACTIVE.service, ACTIVE.account, next);
    return target;
  });

  const remove = (id: string): Promise<void> => serial(async () => {
    if (!SAFE_ID.test(id)) throw new AccountError("unknown account");
    await deleteItem(STORE_SERVICE, id);
    await kv.set(INDEX_KEY, (await list()).filter((a) => a.id !== id));
  });

  /** Saves the active login, then removes only the local Keychain item (no token revocation) so agy asks to sign in again. */
  const detach = (): Promise<SavedAccount> => serial(async () => {
    const blob = await activeBlob();
    const saved = await save(blob, null);
    if ((await readItem(STORE_SERVICE, saved.id)) !== blob) throw new AccountError("could not keep a copy of the current login");
    await deleteItem(ACTIVE.service, ACTIVE.account);
    return saved;
  });

  /** Saves the active login if it is new, or refreshes its saved copy when agy rotated it. */
  const sync = (): Promise<void> =>
    serial(async () => {
      const blob = await readItem(ACTIVE.service, ACTIVE.account);
      if (blob === null) return;
      const owner = await match(blob, await list());
      if (owner === null) await save(blob, null);
      else if ((await readItem(STORE_SERVICE, owner.id)) !== blob) await writeItem(STORE_SERVICE, owner.id, blob);
    });

  const signedIn = async () => (await readItem(ACTIVE.service, ACTIVE.account)) !== null;

  return { state, saveCurrent, switchTo, remove, detach, sync, signedIn };
}
