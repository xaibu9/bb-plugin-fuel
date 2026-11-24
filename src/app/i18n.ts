// UI strings in Russian and English. Window and group labels from the server
// are keys (`5h`, `week_model:Fable`, `claude_gpt`); unknown ones show as is.
import { createContext, useContext } from "react";

export type Lang = "ru" | "en";

const ru = {
  stripLabel: "Лимиты и контекст",
  context: "Контекст",
  noData: "нет данных",
  used: (p: number) => `использовано ${p}%`,
  left: (p: number) => `осталось ${p}%`,
  resetsIn: (t: string) => `Сброс через ${t}`,
  today: "сегодня",
  lasts: "Хватит до сброса",
  lastsAt: (p: number) => `Хватит до сброса, к сбросу около ${p}%`,
  exhausted: "Лимит исчерпан",
  runsOut: (t: string) => `Не хватит: закончится через ${t}`,
  loadingLimits: "Загружаю лимиты…",
  loadingQuota: "Загружаю квоту…",
  claudeEmpty: "bb не сообщил ни одного окна лимитов.",
  providerStatus: (status: string, message: string | null): string =>
    status === "not_installed"
      ? "Провайдер не установлен."
      : status === "unauthenticated"
        ? "Вход не выполнен."
        : status === "expired"
          ? "Вход истёк, войдите заново."
          : `bb не отдал лимиты${message ? `: ${message}` : ""}.`,
  providerShort: (status: string): string =>
    status === "not_installed" ? "не установлен" : status === "unauthenticated" ? "нет входа" : status === "expired" ? "вход истёк" : "ошибка",
  noProviders: "bb пока не сообщил ни одного провайдера.",
  pluginNoData: "Вход есть, но цифр пока нет. Они появятся, когда Kimi Code в следующий раз поработает и обновит вход.",
  viaAgy: "через agy",
  geminiFirst: "Первый замер через agy, обычно 10–15 секунд.",
  geminiError: (code: string): string =>
    code === "agy_missing"
      ? "Не нашёл agy (искал в PATH, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin). Установите Antigravity CLI и войдите в Google или укажите путь к agy в настройках плагина, потом нажмите «Проверить снова»."
      : code === "signed_out"
        ? "agy установлен, но вход в Google не выполнен. Выполните в терминале agy и выберите вход через Google."
        : code === "not_macos"
          ? "Лимиты Antigravity читаются через Связку ключей macOS. На этом компьютере её нет."
          : code === "timeout"
            ? "agy и запасной запрос к Google не ответили вовремя."
            : "Не удалось прочитать квоту Antigravity.",
  checkAgain: "Проверить снова",
  geminiStale: (at: string) => `Замер ${at}. Свежий не получился, повторю через 5 минут.`,
  measuredEvery: (at: string) => `Замер ${at}, раз в 5 мин`,
  retryNow: "Повторить сейчас",
  refresh: "Обновить",
  fromBb: "Лимиты из bb",
  fromBbHint: "Список берётся из bb: что не установлено или без входа, здесь неактивно.",
  ownSources: "Плагин читает сам",
  macOnly: "только macOS",
  geminiNotMac: "Лимиты Antigravity читаются через Связку ключей macOS. На этом компьютере её нет.",
  geminiOffHint: "bb не отдаёт лимиты Antigravity. Плагин может читать их сам через ваш agy.",
  geminiDoes1: "Раз в 5 минут запускает agy -p /usage, около 10 секунд, без запроса к модели.",
  geminiDoes2: "Если agy не ответил, берёт токен входа agy из Связки ключей macOS и спрашивает квоту у Google напрямую. Токен не сохраняется и не пишется в лог.",
  switching: "Переключение аккаунтов",
  switchingHint: "Хранит копии вашего входа agy в Google в Связке ключей и подменяет их. Перезапускает чаты Antigravity.",
  switchingConfirmTitle: "Включить переключение аккаунтов?",
  switchingConfirmLead: "agy хранит ваш вход в Google (токены доступа и обновления и email) в Связке ключей macOS, запись gemini / antigravity. Плагин будет:",
  switchingConfirmItems: [
    "копировать этот вход в свои записи Связки ключей и при переключении ставить копию на место текущего;",
    "при добавлении аккаунта на время убирать текущий вход (копия остаётся) и открывать agy в терминале bb для входа в Google;",
    "после переключения останавливать чаты Antigravity: свободные сразу, отвечающие после ответа.",
  ] as readonly string[],
  switchingConfirmTail: "Токены не попадают в логи, на диск и в хранилище плагина. Не выходите через /logout в agy: сохранённая копия может перестать работать.",
  turnOn: "Включить",
  themeAccent: "Общий: как в сайдбаре или теме",
  geminiFailed: (r: string) => `Квота Antigravity недоступна: ${r}.`,
  measuredStale: (at: string) => `Замер ${at}. Новые цифры появятся, когда провайдер снова поработает.`,
  error: "ошибка",
  failed: (m: string) => `Не получилось: ${m}`,
  failedShort: "Не получилось",
  accountsFailed: "Не удалось прочитать аккаунты.",
  loadingAccounts: "Загружаю аккаунты…",
  accountsLabel: "Аккаунты Antigravity",
  noEmail: "Аккаунт без email",
  waitingGoogle: "Ждём вход в Google…",
  signedOut: "Вход не выполнен",
  switchTo: (a: string) => `Переключить на ${a}`,
  switch: "Переключить",
  forget: "Забыть",
  forgetNamed: (a: string) => `Забыть ${a}`,
  loginHint: "Откройте вход и выберите аккаунт Google. Если страница покажет код, вставьте его сюда. Аккаунт сохранится сам.",
  codeSent: "Код отправлен",
  code: "Код авторизации",
  enter: "Ввести",
  cancel: "Отмена",
  openLogin: "Открыть вход",
  opening: "Открываю…",
  addAccount: "+ Добавить аккаунт",
  confirm: "Подтверждение",
  confirmSwitch: (a: string) => `Переключить Antigravity на ${a}?`,
  confirmForget: (a: string) => `Забыть ${a}? Сохранённый вход удалится из Связки ключей.`,
  switchHint: "Свободные чаты Gemini перезапустятся сразу и продолжат с новым аккаунтом. Чаты, которые сейчас отвечают, перезапустятся после ответа.",
  restartPending: (n: number): string =>
    n % 10 === 1 && n % 100 !== 11
      ? "Этот чат Gemini ещё работает на старом аккаунте и перезапустится после ответа:"
      : "Эти чаты Gemini ещё работают на старом аккаунте и перезапустятся после ответа:",
  restartNow: "Перезапустить сейчас",
  confirmRestartNow: "Прервать текущие ответы и перезапустить?",
  yesRestart: "Да, прервать",
  forgotten: (a: string) => `Забыт: ${a}`,
  wait: "Минуту…",
  yesSwitch: "Да, переключить",
  yesForget: "Да, забыть",
  compactFailed: (m: string) => `Контекст не сжат: ${m}`,
  compactFailedShort: "Контекст не сжат",
  compactStarted: "Сжатие контекста запущено",
  openThread: "Откройте тред, чтобы увидеть заполнение его контекста.",
  contextFailed: "Не удалось получить контекст треда.",
  loadingContext: "Загружаю контекст…",
  contextUnknown: "bb ещё не прислал размер контекста этого треда. Он появится после следующего ответа.",
  tokensOf: (a: string, b: string) => `${a} из ${b} токенов`,
  confirmCompactLabel: "Подтверждение сжатия",
  confirmCompact: "Сжать контекст этого чата?",
  compacting: "Сжимаю…",
  yesCompact: "Да, сжать",
  compact: "Сжать контекст",
  answering: "Тред отвечает. Сжать можно после ответа.",
  settings: "Настройки",
  back: "Назад",
  buttons: "Кнопки на полосе",
  contextAlways: "Контекст показывается всегда.",
  accent: "Акцентный цвет",
  customColor: "Свой цвет",
  language: "Язык",
  langAuto: "Авто",
  saveFailed: "Настройки не сохранились",
  days: "д",
  hours: "ч",
  minutes: "мин",
  windows: {
    "5h": "5 часов",
    week: "Неделя",
    day: "Сутки",
    month: "Месяц",
    month_code: "Месяц, код",
    month_total: "Месяц, всего",
    week_all: "Неделя, все модели",
    models: "Лимит моделей",
    limit: "Лимит",
  } as Record<string, string>,
  weekModel: (m: string) => `${m}, неделя`,
  groups: { gemini: "Gemini", claude_gpt: "Claude и GPT" } as Record<string, string>,
};

export type Strings = typeof ru;

const en: Strings = {
  stripLabel: "Limits and context",
  context: "Context",
  noData: "no data",
  used: (p) => `${p}% used`,
  left: (p) => `${p}% left`,
  resetsIn: (t) => `Resets in ${t}`,
  today: "today",
  lasts: "Lasts until reset",
  lastsAt: (p) => `Lasts until reset, about ${p}% at reset`,
  exhausted: "Limit reached",
  runsOut: (t) => `Runs out in ${t}`,
  loadingLimits: "Loading limits…",
  loadingQuota: "Loading quota…",
  claudeEmpty: "bb reported no limit windows.",
  providerStatus: (status, message) =>
    status === "not_installed"
      ? "The provider is not installed."
      : status === "unauthenticated"
        ? "Not signed in."
        : status === "expired"
          ? "The sign-in expired; sign in again."
          : `bb returned no limits${message ? `: ${message}` : ""}.`,
  providerShort: (status) => (status === "not_installed" ? "not installed" : status === "unauthenticated" ? "not signed in" : status === "expired" ? "sign-in expired" : "error"),
  noProviders: "bb has not reported any provider yet.",
  pluginNoData: "Signed in, no numbers yet. They appear the next time Kimi Code runs and refreshes its sign-in.",
  viaAgy: "via agy",
  geminiFirst: "First measurement through agy, usually 10–15 seconds.",
  geminiError: (code) =>
    code === "agy_missing"
      ? "agy not found (looked on PATH, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin). Install the Antigravity CLI and sign in with Google, or set the agy path in the plugin settings, then press Check again."
      : code === "signed_out"
        ? "agy is installed but not signed in. Run agy in a terminal and choose Google sign-in."
        : code === "not_macos"
          ? "Antigravity limits are read through the macOS Keychain, which this computer does not have."
          : code === "timeout"
            ? "agy and the fallback request to Google did not answer in time."
            : "Could not read the Antigravity quota.",
  checkAgain: "Check again",
  geminiStale: (at) => `Measured ${at}. A fresh read failed; retrying in 5 minutes.`,
  measuredEvery: (at) => `Measured ${at}, every 5 min`,
  retryNow: "Retry now",
  refresh: "Refresh",
  fromBb: "Limits from bb",
  fromBbHint: "The list comes from bb: providers that are not installed or not signed in are inactive here.",
  ownSources: "Read by the plugin",
  macOnly: "macOS only",
  geminiNotMac: "Antigravity limits are read through the macOS Keychain, which this computer does not have.",
  geminiOffHint: "bb does not report Antigravity limits. The plugin can read them itself through your agy.",
  geminiDoes1: "Every 5 minutes runs agy -p /usage, about 10 seconds, no model request.",
  geminiDoes2: "If agy does not answer, reads agy's sign-in token from the macOS Keychain and asks Google for the quota directly. The token is not stored or logged.",
  switching: "Account switching",
  switchingHint: "Keeps copies of your agy Google sign-in in the Keychain and swaps them. Restarts Antigravity chats.",
  switchingConfirmTitle: "Turn on account switching?",
  switchingConfirmLead: "agy keeps your Google sign-in (access and refresh tokens, email) in the macOS Keychain item gemini / antigravity. The plugin will:",
  switchingConfirmItems: [
    "copy that sign-in into its own Keychain items and put a copy in its place on switch;",
    "when adding an account, remove the current sign-in for a while (a copy stays) and open agy in a bb terminal for a Google sign-in;",
    "after a switch, stop Antigravity chats: idle ones at once, answering ones after their reply.",
  ],
  switchingConfirmTail: "Tokens never go to logs, disk or plugin storage. Do not sign out with /logout in agy: the saved copy may stop working.",
  turnOn: "Turn on",
  themeAccent: "Shared: same as the sidebar or theme",
  geminiFailed: (r) => `Antigravity quota unavailable: ${r}.`,
  measuredStale: (at) => `Measured ${at}. New numbers appear the next time the provider runs.`,
  error: "error",
  failed: (m) => `Failed: ${m}`,
  failedShort: "Failed",
  accountsFailed: "Could not read accounts.",
  loadingAccounts: "Loading accounts…",
  accountsLabel: "Antigravity accounts",
  noEmail: "Account without email",
  waitingGoogle: "Waiting for Google sign-in…",
  signedOut: "Not signed in",
  switchTo: (a) => `Switch to ${a}`,
  switch: "Switch",
  forget: "Forget",
  forgetNamed: (a) => `Forget ${a}`,
  loginHint: "Open the sign-in and pick a Google account. If the page shows a code, paste it here. The account saves itself.",
  codeSent: "Code sent",
  code: "Authorization code",
  enter: "Enter",
  cancel: "Cancel",
  openLogin: "Open sign-in",
  opening: "Opening…",
  addAccount: "+ Add account",
  confirm: "Confirm",
  confirmSwitch: (a) => `Switch Antigravity to ${a}?`,
  confirmForget: (a) => `Forget ${a}? Its saved sign-in is removed from the Keychain.`,
  switchHint: "Idle Gemini chats restart at once and continue on the new account. Chats that are answering now restart after their reply.",
  restartPending: (n) => (n === 1 ? "This Gemini chat is still on the old account and restarts after its reply:" : "These Gemini chats are still on the old account and restart after their reply:"),
  restartNow: "Restart now",
  confirmRestartNow: "Interrupt the current replies and restart?",
  yesRestart: "Interrupt",
  forgotten: (a) => `Forgot ${a}`,
  wait: "One moment…",
  yesSwitch: "Switch",
  yesForget: "Forget",
  compactFailed: (m) => `Context not compacted: ${m}`,
  compactFailedShort: "Context not compacted",
  compactStarted: "Compacting started",
  openThread: "Open a thread to see its context fill.",
  contextFailed: "Could not read the thread's context.",
  loadingContext: "Loading context…",
  contextUnknown: "bb has not reported this thread's context size yet. It appears after the next reply.",
  tokensOf: (a, b) => `${a} of ${b} tokens`,
  confirmCompactLabel: "Confirm compacting",
  confirmCompact: "Compact this chat's context?",
  compacting: "Compacting…",
  yesCompact: "Compact",
  compact: "Compact context",
  answering: "The thread is answering. Compact after it finishes.",
  settings: "Settings",
  back: "Back",
  buttons: "Strip buttons",
  contextAlways: "Context is always shown.",
  accent: "Accent color",
  customColor: "Custom color",
  language: "Language",
  langAuto: "Auto",
  saveFailed: "Settings were not saved",
  days: "d",
  hours: "h",
  minutes: "min",
  windows: {
    "5h": "5 hours",
    week: "Week",
    day: "Day",
    month: "Month",
    month_code: "Month, code",
    month_total: "Month, total",
    week_all: "Week, all models",
    models: "Model limit",
    limit: "Limit",
  },
  weekModel: (m) => `${m}, week`,
  groups: { gemini: "Gemini", claude_gpt: "Claude and GPT" },
};

export function resolveLang(pref: "auto" | Lang | undefined): Lang {
  if (pref === "ru" || pref === "en") return pref;
  return typeof navigator !== "undefined" && /^ru\b/i.test(navigator.language) ? "ru" : "en";
}

export const STRINGS: Record<Lang, Strings> = { ru, en };

export const LangContext = createContext<Lang>("ru");

export function useT(): Strings & { lang: Lang; locale: string; windowName(label: string): string; groupName(title: string): string } {
  const lang = useContext(LangContext);
  const s = STRINGS[lang];
  return {
    ...s,
    lang,
    locale: lang === "ru" ? "ru-RU" : "en-US",
    windowName: (label) => (label.startsWith("week_model:") ? s.weekModel(label.slice("week_model:".length)) : (s.windows[label] ?? label)),
    groupName: (title) => s.groups[title] ?? title,
  };
}
