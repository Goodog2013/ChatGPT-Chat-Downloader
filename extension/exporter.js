/* Goodog Chat Export 3.2.0. Same-origin read-only JSON and attachment resolvers. */
(() => {
  "use strict";
  const VERSION = "3.2.0";
  const previous = globalThis.GoodogChatExport;
  if (previous?.version === VERSION) return;
  if (previous && ["collecting", "saving"].includes(previous.getState?.().phase)) {
    throw new Error("Во вкладке работает старая версия экспортёра. Обновите страницу ChatGPT и повторите.");
  }

  const MAX_DURATION = 480000;
  const MAX_PAGES = 1000;
  const MAX_MESSAGES = 250000;
  const MAX_RECEIVED_BYTES = 256 * 1024 * 1024;
  const MAX_CHUNK = 512 * 1024;
  const ORIGINS = new Set(["https://chatgpt.com", "https://chat.openai.com"]);
  let current = null;
  let counter = 0;

  class ExportError extends Error {
    constructor(code, message, status = 0) { super(message); this.name = "ExportError"; this.code = code; this.status = status; }
  }
  const failure = (code, message, status) => new ExportError(code, message, status);
  function warn(job, message) { job.warnings.add(message); }
  function allArchiveWarnings(job) { return [...new Set([...job.warnings, ...job.archiveWarnings])]; }

  // Coverage concerns the received current branch, not image binaries or other branches.
  // Keep transport evidence separate from serializer warnings and final MD counts.
  function evidence(job) {
    return { pages: job.pages, receivedCount: job.receivedCount,
      format: job.outputFormat, language: job.language, archiveAvailable: job.archiveAvailable,
      attachmentCount: job.attachments?.size || 0,
      ...(job.archiveProgress ? { archive: { ...job.archiveProgress } } : {}),
      pagination: { format: job.format, olderComplete: job.olderComplete, newerComplete: job.newerComplete,
        complete: job.transportComplete && (job.format !== "mapping" || job.coverage === "complete") },
      ...(job.stats ? { stats: { ...job.stats } } : {}) };
  }

  function safeStats(stats) {
    if (!stats || typeof stats !== "object") return null;
    const result = {};
    for (const key of ["visibleMessages", "textMessages", "nonTextMessages", "unfinishedMessages"]) {
      if (Number.isSafeInteger(stats[key]) && stats[key] >= 0) result[key] = stats[key];
    }
    return Object.keys(result).length ? result : null;
  }

  function synchronizeContext() {
    if (!current || current.url === location.href || current.phase === "saving") return;
    if (current.running) {
      current.contextChanged = true;
      current.controller.abort();
      current.message = "Открыт другой адрес. Останавливаю сбор прежнего разговора…";
    } else {
      current.assetEpoch++;
      for (const controller of current.assetControllers) controller.abort();
      current = null;
    }
  }

  function getState() {
    synchronizeContext();
    if (!current) return { phase: "idle", jobId: null, count: 0, pages: 0, receivedCount: 0,
      format: "zip", language: "en", archiveAvailable: false, attachmentCount: 0,
      pagination: { format: "unknown", olderComplete: false, newerComplete: false, complete: false },
      message: "Готов получить JSON текущего разговора.", warnings: [], coverage: "unknown" };
    return { phase: current.phase, jobId: current.id, count: current.count, message: current.message,
      warnings: current.outputFormat === "zip" ? allArchiveWarnings(current) : [...current.warnings], coverage: current.coverage,
      ...evidence(current),
      ...(current.error ? { error: current.error } : {}), ...(current.filename ? { filename: current.filename } : {}) };
  }

  function currentContext() {
    const url = new URL(location.href);
    const match = url.pathname.match(/\/c\/([A-Za-z0-9-]+)(?:\/|$)/u);
    if (!ORIGINS.has(url.origin) || !match || match[1].length > 200) {
      throw failure("NO_CONVERSATION", "Откройте сохранённый разговор ChatGPT по адресу /c/… или /g/…/c/… . Новый или временный чат без ID этим способом не экспортируется.");
    }
    return { url: url.href, origin: url.origin, conversationId: match[1] };
  }

  function start(options = {}) {
    synchronizeContext();
    if (current?.running || current?.resolving || current?.phase === "saving") return getState();
    const requested = Number(options?.maxDurationMs);
    const duration = Number.isFinite(requested) && requested > 0 ? Math.min(MAX_DURATION, Math.max(1000, requested)) : MAX_DURATION;
    const job = {
      id: globalThis.crypto?.randomUUID?.() || `gce-${Date.now()}-${++counter}`, phase: "collecting", count: 0,
      message: "Получаю JSON текущего разговора…", warnings: new Set(), archiveWarnings: new Set(), coverage: "unknown", error: null,
      includeLinks: options?.includeLinks !== false, autoDownload: options?.autoDownload !== false,
      outputFormat: options?.format === "md" ? "md" : "zip", language: options?.language === "ru" ? "ru" : "en",
      startedAt: new Date().toISOString(), deadline: performance.now() + duration,
      controller: new AbortController(), running: true, cancelled: false, timedOut: false, contextChanged: false,
      data: null, text: null, filename: null, pages: 0, receivedCount: 0, receivedBytes: 0,
      format: "unknown", olderComplete: false, newerComplete: false, snapshotConsistent: true,
      transportComplete: false, finalized: false, stats: null,
      archiveAvailable: false, archiveDescriptor: null, archiveText: null, archiveFilename: null,
      attachments: new Map(), assetControllers: new Set(), assetEpoch: 0, assetCancelled: false, resolving: false,
    };
    try { Object.assign(job, currentContext()); }
    catch (error) {
      current = job; job.url = location.href; job.running = false; job.phase = "error"; job.coverage = "partial";
      job.error = error.message; job.message = error.message; return getState();
    }
    current = job;
    job.deadlineTimer = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, duration);
    // Never return conversation contents or credentials through executeScript's result.
    void Promise.resolve().then(() => run(job)).catch(() => {
      clearTimeout(job.deadlineTimer); job.running = false; job.phase = "error"; job.coverage = "partial";
      job.error = "Не удалось обработать JSON. Используйте официальный экспорт данных ChatGPT."; job.message = job.error;
    });
    return getState();
  }

  function cancel() {
    const job = current;
    if (!job) return getState();
    job.assetCancelled = true; job.assetEpoch++;
    for (const controller of job.assetControllers) controller.abort();
    if (!job.running) {
      if (job.phase === "saving" || job.resolving) {
        job.message = job.language === "en" ? "Cancelling archive preparation…" : "Отменяем подготовку архива…";
      }
      return getState();
    }
    job.cancelled = true; job.phase = "cancelled"; job.coverage = "partial";
    job.message = "Сбор отменён. Уже полученные страницы подготавливаются для ручного сохранения.";
    job.controller.abort();
    return getState();
  }

  function check(job) {
    if (job.owner && job.owner.assetEpoch !== job.assetEpoch) throw failure("CANCELLED", "Получение вложений отменено.");
    if (job.contextChanged || location.href !== job.url) throw failure("CONTEXT_CHANGED", "Адрес разговора изменился. Данные разных чатов не объединялись.");
    if (job.cancelled) throw failure("CANCELLED", "Сбор отменён пользователем. Сохранена только уже полученная часть разговора.");
    if (job.timedOut || performance.now() >= job.deadline) throw failure("DEADLINE", "Истекло ограниченное время загрузки. Полученные страницы составляют только частичный экспорт.");
    if (job.controller.signal.aborted) throw failure("ABORTED", "Загрузка прервана. Полученные страницы сохранены как частичный результат.");
  }

  function allowedUrl(job, path) {
    const url = new URL(path, job.origin);
    const id = encodeURIComponent(job.conversationId);
    const session = url.pathname === "/api/auth/session";
    const conversation = url.pathname === `/backend-api/conversation/${id}` || url.pathname === `/backend-api/conversations/${id}`;
    // Attachment URLs are built from the current job's immutable manifest, never caller paths.
    const attachment = job.attachmentPaths?.has(url.pathname + url.search) === true;
    if (url.origin !== job.origin || !ORIGINS.has(url.origin) || !session && !conversation && !attachment || url.username || url.password || url.hash) throw failure("REQUEST_SCOPE", "Запрос за пределами текущего разговора запрещён.");
    const keys = [...url.searchParams.keys()];
    if (session && keys.length || conversation && !attachment && keys.some(key => !["num_turns", "include_has_versions", "before"].includes(key))) throw failure("REQUEST_SCOPE", "Недопустимые параметры запроса.");
    return url.href;
  }

  async function wait(job, milliseconds) {
    check(job);
    if (milliseconds >= job.deadline - performance.now()) throw failure("DEADLINE", "Лимита времени недостаточно для запрошенной сервером паузы. Повторите экспорт позднее.");
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); job.controller.signal.removeEventListener("abort", abort); try { check(job); } catch (error) { reject(error); return; } reject(failure("ABORTED", "Загрузка прервана.")); };
      const timer = setTimeout(() => { job.controller.signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
      job.controller.signal.addEventListener("abort", abort, { once: true });
      if (job.controller.signal.aborted) abort();
    });
  }

  function retryDelay(value, attempt) {
    if (!value) return 1500 * (attempt + 1);
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(1000, date - Date.now()) : 1500 * (attempt + 1);
  }

  async function jsonBody(job, response) {
    const type = response.headers.get("content-type") || "";
    if (!/\bapplication\/(?:[a-z0-9!#$&^_.+-]+\+)?json\b/iu.test(type)) throw failure("NOT_JSON", "ChatGPT вернул страницу вместо JSON. Обновите вкладку и войдите в аккаунт; если ошибка повторяется, используйте официальный экспорт данных.");
    if (!response.body?.getReader) {
      const text = await response.text(); job.receivedBytes += text.length * 2;
      if (job.receivedBytes > MAX_RECEIVED_BYTES) throw failure("SIZE_LIMIT", "Достигнут предел объёма загрузки. Для оставшейся истории используйте официальный экспорт данных.");
      check(job);
      try { return JSON.parse(text); } catch { throw failure("BAD_JSON", "Ответ ChatGPT не удалось разобрать как JSON. Используйте официальный экспорт данных."); }
    }
    const reader = response.body.getReader(), decoder = new TextDecoder(), pieces = [];
    try {
      while (true) {
        check(job);
        const { done, value } = await reader.read();
        if (done) break;
        job.receivedBytes += value.byteLength;
        if (job.receivedBytes > MAX_RECEIVED_BYTES) throw failure("SIZE_LIMIT", "Достигнут предел объёма загрузки. Сохранена только ранее полученная часть; используйте официальный экспорт данных.");
        pieces.push(decoder.decode(value, { stream: true }));
      }
      pieces.push(decoder.decode()); check(job);
      try { return JSON.parse(pieces.join("")); } catch { throw failure("BAD_JSON", "Ответ ChatGPT не удалось разобрать как JSON. Используйте официальный экспорт данных."); }
    } finally {
      try { await reader.cancel(); } catch { /* No response body or credential is exposed. */ }
      reader.releaseLock();
    }
  }

  async function requestJson(job, path, auth = null) {
    const url = allowedUrl(job, path);
    for (let attempt = 0; attempt <= 2; attempt++) {
      check(job);
      const controller = new AbortController();
      const abort = () => controller.abort();
      job.controller.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(), Math.min(45000, Math.max(1, job.deadline - performance.now())));
      let delay = null;
      try {
        const headers = { Accept: "application/json" };
        if (auth) {
          headers.Authorization = `Bearer ${auth.token}`;
          if (auth.accountId) headers["ChatGPT-Account-ID"] = auth.accountId;
        }
        const response = await fetch(url, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", headers, signal: controller.signal });
        if (response.status === 429 && attempt < 2) {
          delay = retryDelay(response.headers.get("retry-after"), attempt);
          try { await response.body?.cancel(); } catch { /* Discard error bodies unread. */ }
          if (delay > 60000) throw failure("RATE_LIMIT", "ChatGPT просит длительную паузу. Подождите и повторите экспорт; полученные страницы остаются частичными.", 429);
          job.message = `ChatGPT ограничил частоту запросов. Пауза ${Math.ceil(delay / 1000)} с; получено страниц: ${job.pages}, объектов сообщений: ${job.count}.`;
        } else if (!response.ok) {
          try { await response.body?.cancel(); } catch { /* Never display server error bodies. */ }
          const status = response.status;
          if (status === 401) throw failure("UNAUTHORIZED", "Сессия ChatGPT истекла. Обновите страницу и войдите в нужный аккаунт.", status);
          if (status === 403) throw failure("FORBIDDEN", "ChatGPT не разрешил чтение разговора. Проверьте вход и выбранное рабочее пространство; защитные проверки не обходятся. Можно использовать официальный экспорт данных.", status);
          if (status === 404) throw failure("NOT_FOUND", "Разговор недоступен в текущем аккаунте или рабочем пространстве. Откройте нужный чат либо используйте официальный экспорт данных.", status);
          if (status === 429) throw failure("RATE_LIMIT", "ChatGPT продолжает ограничивать запросы. Повторите экспорт позднее.", status);
          throw failure("HTTP_ERROR", `Не удалось получить JSON разговора (HTTP ${status}). Можно использовать официальный экспорт данных.`, status);
        } else return await jsonBody(job, response);
      } catch (error) {
        if (error instanceof ExportError) throw error;
        check(job);
        if (controller.signal.aborted) throw failure("REQUEST_TIMEOUT", "Превышено время ожидания страницы JSON. Полученные ранее страницы сохранены; повторите экспорт или используйте официальный экспорт данных.");
        throw failure("NETWORK", "Сетевой запрос ChatGPT не выполнен. Проверьте соединение и вход в аккаунт; данные не отправлялись другим адресатам.");
      } finally {
        clearTimeout(timer); job.controller.signal.removeEventListener("abort", abort);
      }
      if (delay !== null) await wait(job, delay);
    }
    throw failure("RATE_LIMIT", "Не удалось получить страницу после ограниченного числа повторов.");
  }

  function validConversation(job, data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw failure("SCHEMA", "Неизвестный формат JSON ChatGPT. Используйте официальный экспорт данных.");
    if (data.conversation_id && data.conversation_id !== job.conversationId) throw failure("WRONG_CONVERSATION", "Сервер вернул другой разговор. Экспорт остановлен без объединения данных.");
  }
  function messageId(message) { return typeof message?.id === "string" && message.id ? message.id : typeof message?.message?.id === "string" && message.message.id ? message.message.id : null; }

  async function readSession(job) {
    const data = await requestJson(job, "/api/auth/session");
    if (typeof data?.accessToken !== "string" || !data.accessToken || /[\u0000-\u0020\u007f]/u.test(data.accessToken)) throw failure("NO_SESSION", "В активной сессии нет доступа к JSON. Войдите в ChatGPT или используйте официальный экспорт данных.");
    const explicit = data.activeAccountId || data.account?.id || data.accountId || "";
    return { token: data.accessToken, accountId: typeof explicit === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(explicit) ? explicit : "", actor: typeof data.user?.id === "string" ? data.user.id : "" };
  }

  function clearCredentials(auth) { if (auth) { auth.token = ""; auth.actor = ""; auth.accountId = ""; } }

  async function run(job) {
    // Credentials live only in this async invocation, never on job/state or in the export.
    let auth = null;
    try {
      check(job);
      if (typeof globalThis.GoodogConversationData?.exportConversation !== "function") throw failure("NO_CONVERTER", "Модуль обработки JSON не загружен. Обновите расширение и повторите.");
      const session = () => readSession(job);
      auth = await session();
      let refreshed = false;
      const authenticated = async path => {
        try { return await requestJson(job, path, auth); }
        catch (error) {
          if (error.status !== 401 || refreshed) throw error;
          refreshed = true;
          const fresh = await session();
          if (fresh.actor !== auth.actor || fresh.accountId !== auth.accountId) { fresh.token = ""; throw failure("AUTH_CHANGED", "Во время экспорта сменился аккаунт или рабочее пространство. Экспорт остановлен; откройте нужный чат и повторите."); }
          auth.token = ""; auth = fresh;
          return requestJson(job, path, auth);
        }
      };
      const id = encodeURIComponent(job.conversationId);
      const base = `/backend-api/conversations/${id}?include_has_versions=true&num_turns=100`;
      let first;
      try { first = await authenticated(base); }
      catch (error) {
        if (![404, 405, 501].includes(error.status)) throw error;
        first = await authenticated(`/backend-api/conversation/${id}`);
      }
      check(job); validConversation(job, first);
      if (first.mapping && typeof first.mapping === "object" && !Array.isArray(first.mapping)) {
        job.format = "mapping"; job.data = first; job.pages = 1; job.count = Object.keys(first.mapping).length;
        job.receivedCount = job.count;
        job.transportComplete = true;
        job.message = `Получено дерево разговора: ${job.count} узлов. Проверяю текущую ветку…`;
      } else if (Array.isArray(first.messages)) {
        job.format = "messages";
        job.newerComplete = first.page_info?.has_next_page === false;
        job.data = { ...first, messages: [] };
        const seen = new Set(), cursors = new Set();
        const addPage = page => {
          validConversation(job, page);
          if (!Array.isArray(page.messages)) throw failure("SCHEMA", "Формат следующей страницы изменился. Результат частичный; используйте официальный экспорт данных.");
          if (first.current_node && page.current_node && first.current_node !== page.current_node) throw failure("BRANCH_CHANGED", "Текущая ветка разговора изменилась во время загрузки. Разные ветки не объединялись; результат частичный.");
          if (first.update_time && page.update_time && first.update_time !== page.update_time) {
            job.snapshotConsistent = false;
            warn(job, "Разговор изменялся во время постраничной загрузки. Согласованность полного снимка не подтверждена.");
          }
          const additions = [], pageIds = new Set();
          for (const message of page.messages) {
            const key = messageId(message);
            if (!key) throw failure("MISSING_ID", "Страница содержит сообщения без ID. Безопасное объединение страниц невозможно; сохранена предыдущая часть.");
            if (!seen.has(key) && !pageIds.has(key)) { pageIds.add(key); additions.push(message); }
          }
          if (seen.size + additions.length > MAX_MESSAGES) throw failure("MESSAGE_LIMIT", "Достигнут предел числа сообщений. Для всей истории используйте официальный экспорт данных.");
          for (const key of pageIds) seen.add(key);
          job.data.messages = additions.concat(job.data.messages);
          job.pages++; job.count = seen.size; job.receivedCount = seen.size;
          job.olderComplete = page.page_info?.has_previous_page === false;
          job.message = `Загружено страниц: ${job.pages}, объектов сообщений: ${job.receivedCount}. Начало: ${job.olderComplete ? "подтверждено API" : "загружаю ранние страницы"}; конец: ${job.newerComplete ? "подтверждён API" : "не подтверждён"}.`;
          return additions.length;
        };
        addPage(first);
        const newerUnconfirmed = first.page_info?.has_next_page !== false;
        if (newerUnconfirmed) warn(job, "Начальная страница не подтверждает отсутствие более новых сообщений. Полнота текущей ветки не установлена.");
        let page = first;
        while (page.page_info?.has_previous_page === true) {
          check(job);
          if (job.pages >= MAX_PAGES) throw failure("PAGE_LIMIT", "Достигнут предел числа страниц. Экспорт частичный; используйте официальный экспорт данных.");
          const before = page.page_info.start_cursor;
          if (typeof before !== "string" || !before || cursors.has(before)) throw failure("CURSOR", "Сервер не дал новый курсор ранних сообщений. Неполный результат не выдан за полный.");
          cursors.add(before);
          if (job.pages > 1) await wait(job, 250);
          const older = await authenticated(`${base}&before=${encodeURIComponent(before)}`);
          check(job);
          if (!addPage(older)) throw failure("NO_PROGRESS", "Следующая страница не добавила сообщений. Экспорт остановлен как частичный.");
          page = older;
        }
        const olderConfirmed = page.page_info?.has_previous_page === false;
        if (!olderConfirmed) warn(job, "Сервер не подтвердил конец ранней истории явным флагом пагинации. Результат считается частичным.");
        job.data.page_info = { ...(first.page_info || {}), start_cursor: page.page_info?.start_cursor,
          has_previous_page: !olderConfirmed, has_next_page: newerUnconfirmed };
        job.transportComplete = olderConfirmed && !newerUnconfirmed && job.snapshotConsistent;
      } else throw failure("SCHEMA", "Ответ не содержит ни дерева mapping, ни массива messages. Используйте официальный экспорт данных ChatGPT.");
      check(job);
    } catch (error) {
      job.transportComplete = false;
      const message = error instanceof ExportError ? error.message : "Не удалось загрузить JSON. Можно использовать официальный экспорт данных ChatGPT.";
      warn(job, message);
      if (!job.data) job.error = message;
    } finally {
      clearCredentials(auth); auth = null;
      clearTimeout(job.deadlineTimer); job.running = false;
      finalize(job);
    }
  }

  function finalize(job) {
    job.coverage = job.transportComplete && !job.cancelled && !job.timedOut && !job.contextChanged ? "complete" : "partial";
    if (!job.data) {
      job.phase = job.cancelled ? "cancelled" : "error";
      job.message = job.cancelled ? "Сбор отменён; страниц разговора не получено." : job.error || "Доступный JSON разговора не найден.";
      job.count = 0; job.finalized = true; return;
    }
    try {
      const meta = { includeLinks: job.includeLinks, coverage: job.coverage, warnings: [...job.warnings],
        id: job.conversationId, conversationId: job.conversationId, url: job.url,
        exportedAt: new Date().toISOString(), language: job.language };
      if (typeof globalThis.GoodogArchiveData?.prepare === "function") {
        try {
          const descriptor = GoodogArchiveData.prepare(job.data, meta);
          if (!descriptor || descriptor.schemaVersion !== 1 || !Array.isArray(descriptor.messages) || !Array.isArray(descriptor.attachments) || descriptor.id && descriptor.id !== job.conversationId) throw new Error("Archive descriptor schema");
          const attachments = new Map();
          for (const attachment of descriptor.attachments) {
            if (!attachment || typeof attachment.key !== "string" || !attachment.key || attachment.key.length > 1000 || attachments.has(attachment.key)) throw new Error("Archive attachment identity");
            attachments.set(attachment.key, attachment);
          }
          job.archiveDescriptor = descriptor; job.attachments = attachments;
          job.archiveAvailable = descriptor.messages.length > 0 || attachments.size > 0;
          for (const message of descriptor.warnings || []) if (typeof message === "string") job.archiveWarnings.add(message);
          if (descriptor.coverage !== "complete") job.coverage = "partial";
        } catch { job.archiveWarnings.add(job.language === "en" ? "The ZIP descriptor could not be prepared. MD export remains available." : "Не удалось подготовить список файлов ZIP. Текстовый экспорт остаётся доступен."); }
      } else if (job.outputFormat === "zip") job.archiveWarnings.add(job.language === "en" ? "The archive module is not loaded. Update the extension; MD remains available." : "Модуль архива не загружен. Обновите расширение; MD остаётся доступен.");
      const result = globalThis.GoodogConversationData.exportConversation(job.data, { ...meta, allowEmpty: true,
        coverage: job.coverage, warnings: [...job.warnings] });
      if (!result || typeof result.text !== "string" || !Number.isSafeInteger(result.count) || result.count < 0 || result.count === 0 && !job.archiveAvailable) throw failure("EMPTY", "JSON не содержит доступных сообщений текущей ветки. Используйте официальный экспорт данных.");
      job.count = result.count;
      job.text = result.text || (job.language === "en" ? "ChatGPT conversation export\nNo readable text is available. See the archive for attachments.\n" : "Экспорт разговора ChatGPT\nДоступного текстового содержимого нет. Вложения сохранены отдельно в архиве.\n");
      job.textFilename = String(result.filename || `ChatGPT-${job.conversationId}.md`);
      job.archiveFilename = job.textFilename.replace(/\.md$/iu, "") + ".zip";
      job.filename = job.outputFormat === "zip" ? job.archiveFilename : job.textFilename;
      job.stats = safeStats(result.stats);
      for (const message of result.warnings || []) if (typeof message === "string") warn(job, message);
      if (result.coverage !== "complete") job.coverage = "partial";
      if (job.archiveDescriptor) {
        job.archiveDescriptor.coverage = job.coverage;
        job.archiveDescriptor.warnings = allArchiveWarnings(job);
      }
      if (job.format === "mapping" && job.coverage === "complete") { job.olderComplete = true; job.newerComplete = true; }
      job.data = null; job.error = null;
      job.phase = job.cancelled ? "cancelled" : "ready";
      const completeDescription = job.format === "messages"
        ? `Все страницы текущей ветки получены (${job.pages} стр.; начало и конец подтверждены API).`
        : "Дерево JSON получено; связи текущей ветки проверены конвертером.";
      job.message = job.cancelled ? `Сбор отменён (${job.pages} стр.). Частичный результат доступен для ручного сохранения.`
        : job.coverage === "complete" ? `${completeDescription} В MD: ${job.count} сообщений.`
          : job.transportComplete ? job.format === "messages"
            ? `Все страницы JSON получены (${job.pages} стр.). Связи или полнота текста требуют проверки — см. предупреждения. Доступно ручное скачивание.`
            : "Дерево JSON получено, но полнота восстановленной ветки не подтверждена. Проверьте предупреждения; доступно ручное скачивание."
            : `Получен частичный результат (${job.pages} стр.). Полнота страниц или снимка не подтверждена; автосохранение отключено. Доступно ручное скачивание.`;
      job.finalized = true;
      if (job.autoDownload && job.coverage === "complete" && (job.outputFormat !== "zip" || job.archiveAvailable) && !job.cancelled && current === job && location.href === job.url) {
        try {
          if (!globalThis.chrome?.runtime?.sendMessage) throw new Error("No extension runtime");
          const response = chrome.runtime.sendMessage({ target: "background", type: "GCE_READY", jobId: job.id });
          response?.catch?.(() => { warn(job, "Автосохранение не запустилось. Результат остаётся в памяти; сохраните вручную."); });
        } catch { warn(job, "Автосохранение не запустилось. Результат остаётся в памяти; сохраните вручную."); }
      }
    } catch (error) {
      job.phase = "error"; job.coverage = "partial"; job.finalized = true;
      if (!job.text) job.count = 0;
      job.error = error instanceof ExportError ? error.message : "Не удалось преобразовать JSON в текст. Используйте официальный экспорт данных ChatGPT.";
      job.message = job.error;
    }
  }

  function prepareExport() {
    synchronizeContext();
    const job = current;
    if (!job || job.running || !job.finalized || !job.text) throw new Error("Нет подготовленного результата. Дождитесь окончания загрузки либо используйте официальный экспорт данных.");
    return { jobId: job.id, filename: job.textFilename, chars: job.text.length, count: job.count, warnings: [...job.warnings], coverage: job.coverage, ...evidence(job) };
  }

  function prepareArchive() {
    synchronizeContext();
    const job = current;
    if (!job || job.running || !job.finalized || !job.archiveAvailable || !job.archiveDescriptor) throw new Error("Архив текущего разговора не подготовлен. Повторите получение JSON или сохраните доступный MD.");
    if (job.resolving) throw new Error("Дождитесь завершения текущей группы вложений.");
    job.assetCancelled = false;
    job.archiveText ||= JSON.stringify(job.archiveDescriptor);
    return { jobId: job.id, filename: job.archiveFilename, chars: job.archiveText.length, count: job.count,
      attachmentCount: job.attachments.size, warnings: allArchiveWarnings(job), coverage: job.coverage, ...evidence(job) };
  }

  function readArchiveChunk(offset, length) {
    synchronizeContext();
    const job = current, start = Number(offset), amount = Number(length);
    if (!job?.archiveText || !job.finalized) throw new Error("Сначала вызовите prepareArchive().");
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(amount) || amount < 0) throw new Error("Недопустимые границы фрагмента.");
    return job.archiveText.slice(start, start + Math.min(amount, MAX_CHUNK));
  }

  function attachmentPath(job, attachment) {
    const source = attachment.source;
    if (!source || source.type !== "file" || typeof source.value !== "string") throw failure("ASSET_TYPE", "У вложения нет поддерживаемого указателя файла.");
    if (source.conversationId && source.conversationId !== job.conversationId) throw failure("ASSET_SCOPE", "Вложение относится к другому разговору.");
    if (source.value.startsWith("sandbox:")) {
      // ArchiveData already decoded Markdown's URL once. Never double-decode a path.
      const path = source.value.slice("sandbox:".length);
      if (!path.startsWith("/mnt/data/") || path.length > 2000 || /[\u0000-\u001f\u007f\\]/u.test(path) || /%(?:2e|2f|5c)/iu.test(path) || path.split("/").some(segment => segment === "." || segment === "..")) throw failure("ASSET_PATH", "Неподдерживаемый путь файла sandbox.");
      const message = source.messageId || attachment.messageIds?.[0];
      if (typeof message !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(message)) throw failure("ASSET_SCOPE", "Для файла sandbox не указан допустимый ID сообщения.");
      const query = new URLSearchParams({ message_id: message, sandbox_path: path });
      return `/backend-api/conversation/${encodeURIComponent(job.conversationId)}/interpreter/download?${query}`;
    }
    const id = source.value.replace(/^(?:sediment|file-service):\/\//u, "");
    if (!/^[A-Za-z0-9_-]{1,256}$/u.test(id)) throw failure("ASSET_ID", "Этот формат указателя вложения пока не поддерживается.");
    // Match the primary browser exporter's file resolver contract (empty post_id).
    const query = new URLSearchParams({ post_id: "", inline: "false" });
    return `/backend-api/files/download/${encodeURIComponent(id)}?${query}`;
  }

  function validatedAssetUrl(job, value) {
    if (typeof value !== "string" || !value || value.length > 20000) throw failure("ASSET_URL", "Сервер не вернул допустимую ссылку вложения.");
    let url;
    try { url = new URL(value, job.origin); } catch { throw failure("ASSET_URL", "Некорректная ссылка вложения."); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443") throw failure("ASSET_URL", "Небезопасная ссылка вложения отклонена.");
    if (url.origin === job.origin && url.pathname === "/backend-api/estuary/content") return url.href;
    const host = url.hostname.toLowerCase();
    if (host === "oaiusercontent.com" || host.endsWith(".oaiusercontent.com")) return url.href;
    if (host.endsWith(".blob.core.windows.net") && host.length > ".blob.core.windows.net".length && url.searchParams.get("sig")) return url.href;
    throw failure("ASSET_HOST", "Адрес вложения вне разрешённых хранилищ. Файл будет отмечен недоступным; произвольные адреса не загружаются.");
  }

  function assetName(value, fallback) {
    const name = Array.from(String(value || fallback || "attachment").split(/[\\/]/u).pop().replace(/[<>:"|?*\u0000-\u001f\u007f]/gu, "_").replace(/[. ]+$/gu, "")).slice(0, 180).join("") || "attachment";
    return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name) ? `_${name}` : name;
  }
  function assetMime(value) { const type = String(value || "").split(";")[0].trim(); return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(type) ? type : "application/octet-stream"; }

  async function resolveAttachments(input = {}) {
    synchronizeContext();
    const job = current;
    if (!job || input.jobId !== job.id || job.running || !job.finalized || !job.archiveAvailable) throw new Error("Архив этого задания больше не доступен.");
    if (!Array.isArray(input.keys) || input.keys.length > 8 || input.keys.some(key => typeof key !== "string")) throw new Error("Разрешено не более восьми ключей вложений за запрос.");
    if (job.assetCancelled) throw new Error("Получение вложений отменено. Для повтора заново подготовьте архив.");
    if (job.resolving) throw new Error("Предыдущая группа вложений ещё обрабатывается.");
    const keys = [...new Set(input.keys)];
    if (!keys.length) return { files: [] };
    const controller = new AbortController();
    const transport = { ...job, controller, deadline: performance.now() + 120000, receivedBytes: 0,
      timedOut: false, cancelled: false, contextChanged: false, owner: job, assetEpoch: job.assetEpoch,
      attachmentPaths: new Set() };
    let auth = null, authError = null, refreshed = false;
    const files = [];
    job.resolving = true; job.assetControllers.add(controller);
    const timer = setTimeout(() => { transport.timedOut = true; controller.abort(); }, 120000);
    try {
      for (const key of keys) {
        const attachment = job.attachments.get(key);
        if (!attachment) { files.push({ key, error: "Вложения с таким ключом нет в текущем разговоре." }); continue; }
        try {
          check(transport);
          let value = attachment.source?.value, details = null;
          if (attachment.source?.type !== "url") {
            const path = attachmentPath(job, attachment);
            const url = new URL(path, job.origin); transport.attachmentPaths.add(url.pathname + url.search);
            if (authError) throw authError;
            if (!auth) {
              try { auth = await readSession(transport); }
              catch (error) { authError = error; throw error; }
            }
            try { details = await requestJson(transport, path, auth); }
            catch (error) {
              if (error.status !== 401 || refreshed) throw error;
              refreshed = true;
              let fresh;
              try { fresh = await readSession(transport); }
              catch (error) { authError = error; throw error; }
              if (fresh.actor !== auth.actor || fresh.accountId !== auth.accountId) {
                clearCredentials(fresh);
                authError = failure("AUTH_CHANGED", "Аккаунт или рабочее пространство изменились. Получение вложений остановлено.");
                throw authError;
              }
              clearCredentials(auth); auth = fresh;
              details = await requestJson(transport, path, auth);
            }
            if (!details || details.status === "error") throw failure("ASSET_UNAVAILABLE", "Сервис ChatGPT не предоставил файл. Возможно, вложение удалено или срок хранения истёк.");
            value = details.download_url || details.url;
          }
          check(transport);
          const url = validatedAssetUrl(job, value);
          const result = { key, url, name: assetName(details?.file_name || attachment.name, attachment.id || "attachment"),
            mime: assetMime(details?.mime_type || attachment.mime) };
          if (Number.isSafeInteger(details?.file_size_bytes) && details.file_size_bytes >= 0) result.size = details.file_size_bytes;
          files.push(result);
        } catch (error) {
          // A shared rate limit must not trigger another retry burst for every file.
          if (error instanceof ExportError && error.code === "RATE_LIMIT") authError = error;
          files.push({ key, error: error instanceof ExportError ? error.message : "Не удалось получить ссылку вложения. Файл будет отмечен недоступным." });
        }
      }
      return { files };
    } finally {
      clearCredentials(auth); auth = null; clearTimeout(timer);
      job.assetControllers.delete(controller); job.resolving = false;
    }
  }

  async function resolveAttachment(input = {}) {
    const result = await resolveAttachments({ jobId: input.jobId, keys: [input.key] });
    const file = result.files[0];
    if (!file || file.error) throw new Error(file?.error || "Ссылка вложения не получена.");
    return file;
  }

  function safeArchiveProgress(value) {
    if (!value || typeof value !== "object") return null;
    const result = {};
    if (["preparing", "resolving", "downloading", "packing", "complete", "cancelled", "error"].includes(value.stage)) result.stage = value.stage;
    if (["unknown", "complete", "partial"].includes(value.coverage)) result.coverage = value.coverage;
    if (["resolving", "downloading", "packing", "complete", "partial", "cancelled", "error"].includes(value.phase)) result.phase = value.phase;
    for (const key of ["total", "completed", "downloaded", "failed", "missing", "bytes", "totalBytes", "index"]) if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
    for (const key of ["message", "current"]) if (typeof value[key] === "string") result[key] = value[key].replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 500);
    return Object.keys(result).length ? result : null;
  }

  function readExportChunk(offset, length) {
    synchronizeContext();
    const job = current, start = Number(offset), amount = Number(length);
    if (!job?.text || !job.finalized) throw new Error("Сначала подготовьте результат экспорта.");
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(amount) || amount < 0) throw new Error("Недопустимые границы фрагмента.");
    return job.text.slice(start, start + Math.min(amount, MAX_CHUNK));
  }

  function downloadResult(result = {}) {
    synchronizeContext();
    const job = current;
    if (!job || result.jobId !== job.id || !["saving", "saved", "error"].includes(result.phase) || job.running || !job.finalized) return getState();
    if (result.progressOnly && job.phase !== "saving") return getState();
    if (Object.prototype.hasOwnProperty.call(result, "archive")) job.archiveProgress = safeArchiveProgress(result.archive);
    if (result.format === "zip" || result.format === "md") job.outputFormat = result.format;
    if (result.phase === "error") {
      job.phase = "error"; job.error = String(result.error || result.message || "Не удалось сохранить файл.");
      job.message = "Ошибка сохранения. Текст остаётся в памяти; можно повторить скачивание.";
    } else {
      job.phase = result.phase; job.error = null;
      job.message = String(result.message || (result.phase === "saving" ? "Сохраняю локальный MD-файл…" : "MD-файл сохранён."));
    }
    if (result.filename) job.filename = String(result.filename);
    return getState();
  }

  globalThis.GoodogChatExport = Object.freeze({ version: VERSION, getState, start, cancel, prepareExport, readExportChunk,
    prepareArchive, readArchiveChunk, resolveAttachment, resolveAttachments, downloadResult });
})();
