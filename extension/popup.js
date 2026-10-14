"use strict";

(() => {
  const parameters = new URLSearchParams(location.search);
  let language = "en";
  try { const savedLanguage = localStorage.getItem("gce-language"); if (["ru", "en"].includes(savedLanguage)) language = savedLanguage; } catch { /* Language preference is optional. Chat data is never stored. */ }
  const requestedTab = parameters.get("tabId");
  const targetFromQuery = /^\d+$/u.test(requestedTab || "") && Number.isSafeInteger(Number(requestedTab)) ? Number(requestedTab) : null;
  const wide = parameters.get("wide") === "1" || targetFromQuery !== null;
  document.documentElement.classList.toggle("wide", wide);
  document.body.classList.toggle("wide", wide);
  const byId = (id) => document.getElementById(id);
  const elements = Object.fromEntries([
    "workspace", "unsupported", "unsupported-message", "include-links", "phase-label", "format-options", "format-zip", "format-txt", "format-hint", "format-badge", "current-format",
    "status-message", "count-label", "message-count", "page-count", "text-only-note", "progress", "coverage", "filename",
    "keep-open", "error", "warnings", "warning-list", "primary-action", "primary-label",
    "cancel-action", "restart-action", "wide-action", "local-file", "local-open", "local-status",
    "local-selection", "local-conversation", "local-download", "local-error", "local-warnings", "local-warning-list",
    "archive-status", "archive-stage", "archive-count", "archive-coverage",
    "ui-language", "permission-note", "local-folder-controls", "local-folder", "local-folder-open", "local-folder-status", "local-archive",
  ].map((id) => [id, byId(id)]));
  const phaseLabels = {
    idle: "Готов к работе", collecting: "Получение данных", ready: "Данные получены",
    cancelled: "Получение остановлено", error: "Нужно внимание", saving: "Сохранение", saved: "Файл сохранён",
  };
  const defaultMessages = {
    idle: "Загрузите все страницы текущей ветки и сохраните её в выбранном формате ZIP или TXT.",
    collecting: "Загружаем все страницы текущей ветки без прокрутки чата…",
    ready: "Полученные сообщения готовы к сохранению в выбранном формате.",
    cancelled: "Получение остановлено. Доступную часть можно сохранить.",
    error: "Если прямое получение недоступно, откройте JSON из официального экспорта ниже.",
    saving: "Выберите имя и папку в окне сохранения. Дождитесь завершения загрузки.",
    saved: "Файл сохранён. При необходимости скачайте его ещё раз или выберите другой формат.",
  };
  let state = { phase: "idle", count: 0, pages: null, nonTextMessages: 0, archiveAvailable: false, format: "zip", archive: null, message: "", warnings: [], coverage: "unknown", filename: "", error: "" };
  let tabId = null;
  let initialized = false;
  let disposed = false;
  let pollTimer = null;
  let pollInFlight = false;
  let pendingAction = "";
  let actionEpoch = 0;
  let cancelRequested = false;
  let transportError = "";
  let localWorker = null;
  let localRequestSequence = 0;
  let localRequestId = null;
  let localLoading = false;
  let localExporting = false;
  let localConversations = [];
  let localWarnings = [];
  let localError = "";
  let localStatus = "Файл обрабатывается только в памяти этой вкладки и никуда не отправляется.";
  let localFiles = [];
  let localArchive = null;
  let permissionDenied = false;
  const downloadUrls = new Set();
  const originalText = new WeakMap();
  const CDN_ORIGINS = ["https://*.oaiusercontent.com/*", "https://*.blob.core.windows.net/*"];

  elements["wide-action"].hidden = wide;
  elements["format-zip"].checked = parameters.get("format") !== "txt";
  elements["format-txt"].checked = parameters.get("format") === "txt";
  elements["ui-language"].value = language;

  function t(value) { return globalThis.GoodogI18n?.translate(String(value), language) || String(value); }
  function localizePage() {
    document.documentElement.lang = language;
    document.title = t("Goodog · Экспорт чата");
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.nodeValue.trim() || node.parentElement?.closest("#local-conversation,#filename")) continue;
      if (!originalText.has(node)) originalText.set(node, node.nodeValue);
      const source = originalText.get(node);
      const leading = source.match(/^\s*/u)[0], trailing = source.match(/\s*$/u)[0];
      node.nodeValue = leading + t(source.trim()) + trailing;
    }
    for (const element of document.querySelectorAll("[aria-label]")) {
      if (!element.dataset.originalLabel) element.dataset.originalLabel = element.getAttribute("aria-label");
      element.setAttribute("aria-label", t(element.dataset.originalLabel));
    }
  }

  function selectedFormat() { return elements["format-txt"].checked ? "txt" : "zip"; }
  function safeCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
  function bytesLabel(bytes) {
    if (bytes < 1024) return `${bytes.toLocaleString("ru-RU")} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} КБ`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
    return `${(bytes / (1024 * 1024 * 1024)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ГБ`;
  }

  function messageOf(value, fallback = "Не удалось связаться с расширением. Откройте это окно снова.") {
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value.message === "string" && value.message.trim()) return value.message;
    return fallback;
  }

  function applyState(value) {
    if (!value || typeof value !== "object") throw new Error("Расширение не вернуло состояние экспорта.");
    initialized = true;
    state = {
      phase: Object.hasOwn(phaseLabels, value.phase) ? value.phase : "idle",
      count: Number.isSafeInteger(value.count) && value.count >= 0 ? value.count : 0,
      pages: Number.isSafeInteger(value.pages) && value.pages >= 0 ? value.pages : null,
      nonTextMessages: Number.isSafeInteger(value.stats?.nonTextMessages) && value.stats.nonTextMessages >= 0 ? value.stats.nonTextMessages : 0,
      archiveAvailable: value.archiveAvailable === true,
      format: ["zip", "txt"].includes(value.format) ? value.format : state.format,
      archive: value.archive && typeof value.archive === "object" ? {
        total: safeCount(value.archive.total), downloaded: safeCount(value.archive.downloaded), missing: safeCount(value.archive.missing), bytes: safeCount(value.archive.bytes),
        stage: typeof value.archive.stage === "string" ? value.archive.stage : "",
        coverage: ["complete", "partial"].includes(value.archive.coverage) ? value.archive.coverage : "unknown",
      } : null,
      message: typeof value.message === "string" ? value.message : "",
      warnings: Array.isArray(value.warnings) ? value.warnings.filter((entry) => typeof entry === "string" && entry.trim()) : [],
      coverage: ["unknown", "complete", "partial"].includes(value.coverage) ? value.coverage : "unknown",
      filename: typeof value.filename === "string" ? value.filename : "",
      error: messageOf(value.error, ""),
    };
    if (!["collecting", "saving"].includes(state.phase)) cancelRequested = false;
    transportError = "";
    render();
  }

  function render() {
    const collecting = state.phase === "collecting";
    const saving = state.phase === "saving";
    const busy = collecting || saving || Boolean(pendingAction);
    const hasText = state.count > 0;
    const hasExport = hasText || state.archiveAvailable;
    const format = selectedFormat();
    const formatLabel = format.toUpperCase();
    const canCancel = collecting || (saving && state.format === "zip" && !["complete", "ready", "done"].includes(state.archive?.stage));
    const partial = state.coverage === "partial" || ["cancelled", "error"].includes(state.phase);
    document.body.dataset.phase = state.phase;
    document.body.dataset.coverage = state.coverage;
    elements["phase-label"].textContent = !initialized ? "Подключаемся к вкладке" : phaseLabels[state.phase];
    elements["status-message"].textContent = pendingAction === "GCE_START" ? `Начинаем загрузку текущей ветки для ${formatLabel}…` : state.message || defaultMessages[state.phase];
    elements["format-options"].disabled = busy || localLoading || localExporting;
    elements["permission-note"].hidden = !permissionDenied || format !== "zip";
    elements["permission-note"].textContent = "Доступ к хранилищам вложений не предоставлен. История будет получена; часть файлов может оказаться недоступной и будет отмечена в предупреждениях ZIP.";
    elements["format-hint"].textContent = format === "zip"
      ? "ZIP включает текст текущей ветки и доступные оригиналы файлов. Недоступные вложения будут перечислены в предупреждениях; полнота истории и файлов показывается отдельно."
      : "TXT сохраняет весь доступный текст текущей ветки, код, ссылки и подписи. Картинки и вложения в TXT не входят.";
    elements["format-badge"].textContent = `.${(hasExport || busy ? state.format : format).toUpperCase()}`;
    elements["current-format"].hidden = !hasExport && !busy;
    elements["current-format"].textContent = `Текущий экспорт: ${state.format.toUpperCase()}. Для следующего сохранения выбран ${formatLabel}.`;
    elements["message-count"].textContent = state.count.toLocaleString("ru-RU");
    elements["count-label"].textContent = collecting || !hasExport ? "Получено сообщений" : "Сообщений с текстом";
    elements["page-count"].hidden = !collecting && pendingAction !== "GCE_START" && !(state.pages > 0);
    elements["page-count"].textContent = state.pages !== null
      ? `Получено страниц: ${state.pages.toLocaleString("ru-RU")}${collecting ? " · загружаем историю до начала ветки…" : ""}`
      : "Загружаем все страницы текущей ветки…";
    elements["text-only-note"].hidden = collecting || state.format !== "txt" || state.nonTextMessages === 0;
    elements["text-only-note"].textContent = `Сообщений без текста пропущено: ${state.nonTextMessages.toLocaleString("ru-RU")} (картинки и вложения).`;
    elements.progress.hidden = !busy;
    elements["keep-open"].hidden = !collecting && pendingAction !== "GCE_START";
    elements["include-links"].disabled = busy || localLoading || localExporting;
    elements["primary-action"].disabled = !initialized || busy || (!hasText && state.archiveAvailable && format === "txt");
    elements["primary-action"].setAttribute("aria-busy", String(busy));
    elements["primary-label"].textContent = collecting || pendingAction === "GCE_START"
      ? "Загружаем все страницы…"
      : saving || pendingAction === "GCE_DOWNLOAD"
        ? `Сохраняем ${formatLabel}…`
        : !hasText && state.archiveAvailable && format === "txt" ? "В этой ветке есть только вложения — выберите ZIP" : hasExport
          ? partial ? `Сохранить доступную часть в ${formatLabel}` : state.phase === "saved" ? `Скачать ${formatLabel} ещё раз` : `Сохранить в ${formatLabel}`
          : format === "zip" ? "Получить чат и вложения в ZIP" : "Получить весь текст в TXT";
    elements["cancel-action"].hidden = !canCancel;
    elements["cancel-action"].disabled = Boolean(pendingAction) || cancelRequested;
    elements["cancel-action"].textContent = cancelRequested ? "Останавливаем получение…" : saving ? "Отменить подготовку ZIP" : "Остановить получение";
    elements["restart-action"].hidden = !hasExport || busy;
    elements["restart-action"].disabled = Boolean(pendingAction);
    elements.coverage.hidden = !hasExport && !collecting;
    elements.coverage.textContent = state.coverage === "partial"
      ? "Полная история текущей ветки не подтверждена. В экспорт войдёт доступная часть; причины указаны в предупреждениях."
      : state.coverage === "complete"
        ? "История текущей ветки получена полностью. Полнота вложений показывается отдельно."
        : "Полнота истории текущей ветки ещё не подтверждена.";
    renderArchive();
    elements.filename.hidden = !state.filename;
    elements.filename.textContent = state.filename ? `${t("Файл:")} ${state.filename}` : "";
    const error = transportError || state.error;
    elements.error.hidden = !error;
    elements.error.textContent = error;
    const warningItems = state.warnings.map((warning) => {
      const item = document.createElement("li");
      item.textContent = warning;
      return item;
    });
    elements["warning-list"].replaceChildren(...warningItems);
    elements.warnings.hidden = warningItems.length === 0;
    renderLocal();
    localizePage();
  }

  function renderArchive() {
    const archive = state.archive;
    elements["archive-status"].hidden = state.format !== "zip" || !archive;
    if (!archive) return;
    const stages = { preparing: "Подготовка списка вложений", collecting: "Поиск вложений текущей ветки", metadata: "Подготовка списка вложений", resolving: "Получение адресов вложений", downloading: "Загрузка оригиналов вложений", packing: "Сборка ZIP", writing: "Сборка ZIP", packaging: "Сборка ZIP", ready: "ZIP подготовлен", complete: "ZIP подготовлен", done: "ZIP подготовлен" };
    elements["archive-stage"].textContent = stages[archive.stage] || "Подготовка вложений ZIP";
    elements["archive-count"].textContent = `Файлов загружено: ${archive.downloaded.toLocaleString("ru-RU")} из ${archive.total.toLocaleString("ru-RU")} · недоступно: ${archive.missing.toLocaleString("ru-RU")} · ${bytesLabel(archive.bytes)}`;
    const coverage = archive.missing > 0 ? "partial" : archive.coverage;
    elements["archive-coverage"].hidden = coverage === "unknown";
    elements["archive-coverage"].dataset.coverage = coverage;
    elements["archive-coverage"].textContent = coverage === "complete"
      ? "Все найденные в данных вложения включены в ZIP."
      : "Часть вложений недоступна. Эти файлы не включены в ZIP; проверьте предупреждения.";
  }

  function renderLocal() {
    const busy = localLoading || localExporting;
    elements["local-open"].disabled = busy;
    elements["local-open"].textContent = localLoading ? "Читаем JSON…" : localConversations.length ? "Открыть другой JSON" : "Открыть JSON из экспорта ChatGPT";
    elements["local-status"].textContent = localStatus;
    elements["local-selection"].hidden = localConversations.length === 0;
    elements["local-conversation"].disabled = busy;
    elements["local-folder-controls"].hidden = selectedFormat() !== "zip";
    elements["local-folder-open"].disabled = busy;
    elements["local-folder-status"].textContent = localFiles.length
      ? `Выбрано файлов в папке: ${localFiles.length.toLocaleString("ru-RU")}. Для ZIP будут использованы только вложения выбранной ветки.`
      : "Необязательно: выберите распакованную папку официального экспорта. В ZIP попадут только файлы выбранной ветки, которые удастся сопоставить; без папки недоступные вложения будут отмечены.";
    elements["local-download"].disabled = busy || !localConversations.length;
    elements["local-download"].textContent = localExporting ? `Готовим ${selectedFormat().toUpperCase()}…` : `Сохранить выбранный чат в ${selectedFormat().toUpperCase()}`;
    elements["local-archive"].hidden = selectedFormat() !== "zip" || !localArchive;
    elements["local-archive"].textContent = localArchive
      ? `Файлов включено: ${safeCount(localArchive.downloaded).toLocaleString("ru-RU")} из ${safeCount(localArchive.total).toLocaleString("ru-RU")} · недоступно: ${safeCount(localArchive.missing).toLocaleString("ru-RU")} · ${bytesLabel(safeCount(localArchive.bytes))}` : "";
    elements["local-download"].setAttribute("aria-busy", String(localExporting));
    elements["local-error"].textContent = localError;
    elements["local-error"].hidden = !localError;
    elements["local-warning-list"].replaceChildren(...localWarnings.map(text => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }));
    elements["local-warnings"].hidden = localWarnings.length === 0;
  }

  function failLocal(error) {
    localLoading = false;
    localExporting = false;
    localError = messageOf(error, "Не удалось обработать JSON. Выберите файл повторно.");
    localStatus = "Файл не отправлялся в сеть. Можно выбрать JSON повторно.";
    render();
  }

  function safeLocalFilename(value, format) {
    let name = String(value || "ChatGPT").normalize("NFC")
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, "_")
      .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "").replace(/\.(?:txt|zip)$/iu, "").trim();
    name = [...name].slice(0, 140).join("").replace(/[. ]+$/gu, "") || "ChatGPT";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) name = `ChatGPT_${name}`;
    return `${name}.${format === "zip" ? "zip" : "txt"}`;
  }

  function downloadLocal(message) {
    const format = message.format === "zip" ? "zip" : "txt";
    if (format === "zip" ? !(message.blob instanceof Blob) || !message.blob.size : typeof message.text !== "string" || !message.text.length) throw new Error("Не удалось подготовить файл выбранного разговора.");
    const filename = safeLocalFilename(message.filename, format);
    const blob = format === "zip" ? message.blob : new Blob(["\uFEFF", message.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    downloadUrls.add(url);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    try { anchor.click(); } finally { anchor.remove(); }
    setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 120000);
    const count = Number.isSafeInteger(message.count) && message.count >= 0 ? message.count.toLocaleString("ru-RU") : "—";
    const coverageNote = message.coverage === "complete"
      ? " История выбранной ветки в JSON полная."
      : message.coverage === "partial" ? " Полная история выбранной ветки не подтверждена — проверьте предупреждения." : " Полнота истории выбранной ветки не подтверждена.";
    const nonTextNote = Number.isSafeInteger(message.stats?.nonTextMessages) && message.stats.nonTextMessages > 0
      ? ` Сообщений без текста пропущено: ${message.stats.nonTextMessages.toLocaleString("ru-RU")}.` : "";
    const filesNote = format === "txt" ? " Картинки и вложения исключены."
      : safeCount(message.archive?.missing) > 0 || message.archive?.coverage !== "complete" ? " Полнота вложений ZIP не подтверждена; проверьте предупреждения." : " Все найденные вложения включены в ZIP.";
    localArchive = format === "zip" ? message.archive || null : null;
    localStatus = `Файл передан браузеру для сохранения: ${filename}. Сообщений с текстом: ${count}.${coverageNote}${format === "txt" ? nonTextNote : ""}${filesNote}`;
  }

  function getLocalWorker() {
    if (localWorker) return localWorker;
    const worker = new Worker(chrome.runtime.getURL("json-worker.js"));
    localWorker = worker;
    worker.addEventListener("message", event => {
      const message = event.data;
      if (disposed || worker !== localWorker || !message || message.requestId !== localRequestId) return;
      if (message.type === "ERROR") { failLocal(message.error); return; }
      if (message.type === "PROGRESS" && (localLoading || localExporting)) {
        const count = Number.isSafeInteger(message.count) && message.count >= 0 ? ` Обработано объектов: ${message.count.toLocaleString("ru-RU")}.` : "";
        localStatus = `${typeof message.message === "string" && message.message.trim() ? message.message : "Обрабатываем JSON…"}${count} Оставьте это окно открытым.`;
        if (message.archive && typeof message.archive === "object") localArchive = message.archive;
        renderLocal();
        localizePage();
        return;
      }
      try {
        if (message.type === "LOADED" && localLoading) {
          if (!Array.isArray(message.conversations)) throw new Error("JSON обработан без списка разговоров.");
          localConversations = message.conversations.filter(item => item && Number.isSafeInteger(item.index) && item.index >= 0);
          localLoading = false;
          localWarnings = Array.isArray(message.warnings) ? message.warnings.filter(text => typeof text === "string") : [];
          renderConversationOptions();
          localStatus = localConversations.length ? `JSON открыт. Доступно разговоров: ${localConversations.length.toLocaleString("ru-RU")}. Выберите нужный и формат сохранения.` : "В JSON не найдены разговоры. Выберите conversations.json из распакованного экспорта ChatGPT.";
          render();
        } else if (message.type === "EXPORTED" && localExporting) {
          localExporting = false;
          const warnings = Array.isArray(message.warnings) ? message.warnings.filter(text => typeof text === "string") : [];
          localWarnings = [...new Set([...localWarnings, ...warnings])];
          downloadLocal(message);
          render();
        }
      } catch (error) { failLocal(error); }
    });
    worker.addEventListener("error", event => {
      event.preventDefault();
      if (disposed || worker !== localWorker) return;
      worker.terminate();
      localWorker = null;
      localConversations = [];
      elements["local-conversation"].replaceChildren();
      failLocal("Не удалось обработать JSON в памяти браузера. Откройте широкое окно и выберите файл повторно.");
    });
    return worker;
  }

  function renderConversationOptions() {
    const selected = elements["local-conversation"].value;
    const options = document.createDocumentFragment();
    for (const item of localConversations) {
      const option = document.createElement("option");
      option.value = String(item.index);
      const count = Number.isSafeInteger(item.messageCount) && item.messageCount >= 0 ? ` · ${t(`${item.messageCount.toLocaleString("ru-RU")} сообщений`)}` : "";
      option.textContent = `${String(item.title || t("Без названия")).slice(0, 220)}${count}`;
      options.append(option);
    }
    elements["local-conversation"].replaceChildren(options);
    if (localConversations.some(item => String(item.index) === selected)) elements["local-conversation"].value = selected;
  }

  function loadLocalFile() {
    const file = elements["local-file"].files?.[0];
    elements["local-file"].value = "";
    if (!file || disposed || localLoading || localExporting) return;
    if (!/\.json$/iu.test(file.name)) { failLocal("Выберите файл .json из распакованного экспорта. ZIP сначала нужно распаковать."); return; }
    localConversations = [];
    elements["local-conversation"].replaceChildren();
    localWarnings = [];
    localArchive = null;
    localError = "";
    localLoading = true;
    localStatus = `Читаем ${file.name} в отдельном Worker. Для большого файла потребуется время; оставьте это окно открытым.`;
    localRequestId = ++localRequestSequence;
    render();
    try { getLocalWorker().postMessage({ type: "LOAD", requestId: localRequestId, file, includeLinks: elements["include-links"].checked }); }
    catch (error) { failLocal(error); }
  }

  function exportLocal() {
    if (disposed || localLoading || localExporting || !localWorker) return;
    const index = Number(elements["local-conversation"].value);
    if (!localConversations.some(item => item.index === index)) return;
    localExporting = true;
    localError = "";
    const format = selectedFormat();
    localArchive = null;
    localStatus = format === "zip" ? "Готовим ZIP выбранной ветки и сопоставляем вложения из выбранной папки… Оставьте это окно открытым." : "Восстанавливаем текст выбранной ветки из JSON без картинок и вложений… Оставьте это окно открытым.";
    localRequestId = ++localRequestSequence;
    render();
    try { localWorker.postMessage({ type: "EXPORT", requestId: localRequestId, index, includeLinks: elements["include-links"].checked, format, language, ...(format === "zip" ? { files: localFiles.map(file => ({ file, path: file.webkitRelativePath || file.name })) } : {}) }); }
    catch (error) { failLocal(error); }
  }

  async function request(type, options) {
    let response;
    try {
      response = await chrome.runtime.sendMessage({ target: "background", type, tabId, ...(options ? { options } : {}) });
    } catch {
      throw new Error("Фоновая часть расширения недоступна. Откройте это окно снова и повторите попытку.");
    }
    if (!response?.ok) throw new Error(messageOf(response?.error));
    return response.state;
  }

  function schedulePoll() {
    if (disposed || tabId === null) return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(refreshStatus, 1000);
  }

  async function refreshStatus() {
    if (disposed || tabId === null) return;
    if (pollInFlight || pendingAction) { schedulePoll(); return; }
    const epoch = actionEpoch;
    pollInFlight = true;
    try {
      const next = await request("GCE_STATUS");
      if (!disposed && epoch === actionEpoch) applyState(next);
    } catch (error) {
      if (!disposed && epoch === actionEpoch) { transportError = messageOf(error); render(); }
    } finally {
      pollInFlight = false;
      schedulePoll();
    }
  }

  async function runAction(type) {
    if (!initialized || disposed || pendingAction || (["saving", "collecting"].includes(state.phase) && type !== "GCE_CANCEL")) return;
    pendingAction = type;
    actionEpoch += 1;
    transportError = "";
    if (type === "GCE_CANCEL") cancelRequested = true;
    render();
    try {
      if (["GCE_START", "GCE_DOWNLOAD"].includes(type) && selectedFormat() === "zip") {
        try { permissionDenied = !await chrome.permissions.request({ origins: CDN_ORIGINS }); }
        catch { permissionDenied = true; }
        if (!disposed) render();
      }
      const options = type === "GCE_START"
        ? { includeLinks: elements["include-links"].checked, autoDownload: true, format: selectedFormat(), language }
        : type === "GCE_DOWNLOAD" ? { format: selectedFormat(), language } : undefined;
      const next = await request(type, options);
      if (!disposed) applyState(next);
    } catch (error) {
      if (!disposed) {
        transportError = messageOf(error);
        if (type === "GCE_CANCEL") cancelRequested = false;
      }
    } finally {
      pendingAction = "";
      if (!disposed) { render(); schedulePoll(); }
    }
  }

  function showUnsupported(message) {
    elements.workspace.hidden = true;
    elements.unsupported.hidden = false;
    if (message) elements["unsupported-message"].textContent = message;
  }

  elements["primary-action"].addEventListener("click", () => void runAction(state.count > 0 || (selectedFormat() === "zip" && state.archiveAvailable) ? "GCE_DOWNLOAD" : "GCE_START"));
  elements["restart-action"].addEventListener("click", () => void runAction("GCE_START"));
  elements["cancel-action"].addEventListener("click", () => void runAction("GCE_CANCEL"));
  elements["local-open"].addEventListener("click", () => elements["local-file"].click());
  elements["local-file"].addEventListener("change", loadLocalFile);
  elements["local-download"].addEventListener("click", exportLocal);
  elements["local-folder-open"].addEventListener("click", () => elements["local-folder"].click());
  elements["local-folder"].addEventListener("change", () => {
    if (localLoading || localExporting || disposed) return;
    localFiles = [...elements["local-folder"].files];
    elements["local-folder"].value = "";
    render();
  });
  elements["ui-language"].addEventListener("change", () => {
    language = elements["ui-language"].value === "en" ? "en" : "ru";
    try { localStorage.setItem("gce-language", language); } catch { /* Preference only. */ }
    renderConversationOptions();
    render();
  });
  elements["format-zip"].addEventListener("change", render);
  elements["format-txt"].addEventListener("change", render);
  elements["wide-action"].addEventListener("click", () => {
    const url = new URL(chrome.runtime.getURL("popup.html"));
    url.searchParams.set("wide", "1");
    url.searchParams.set("format", selectedFormat());
    if (Number.isInteger(tabId)) url.searchParams.set("tabId", String(tabId));
    void chrome.tabs.create({ url: url.href }).catch(() => {
      localError = "Не удалось открыть отдельную вкладку расширения. Попробуйте ещё раз.";
      render();
    });
  });
  window.addEventListener("pagehide", () => {
    disposed = true;
    clearTimeout(pollTimer);
    localWorker?.terminate();
    localWorker = null;
    localFiles = [];
    for (const url of downloadUrls) URL.revokeObjectURL(url);
    downloadUrls.clear();
  }, { once: true });

  async function initialize() {
    try {
      if (wide && targetFromQuery === null) { showUnsupported(); return; }
      const tab = targetFromQuery !== null ? await chrome.tabs.get(targetFromQuery) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (disposed) return;
      let supported = false;
      try { supported = ["https://chatgpt.com", "https://chat.openai.com"].includes(new URL(tab?.url).origin); } catch { /* Missing URL is not authorization to inspect the page. */ }
      if (!supported || !Number.isInteger(tab?.id)) { showUnsupported(); return; }
      tabId = tab.id;
      render();
      await refreshStatus();
    } catch {
      if (!disposed) showUnsupported("Не удалось определить активную вкладку. Откройте разговор в ChatGPT и попробуйте снова.");
    } finally {
      if (!disposed) { elements["wide-action"].disabled = false; render(); }
    }
  }

  render();
  void initialize();
})();
