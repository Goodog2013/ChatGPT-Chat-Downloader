"use strict";

const HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
const POPUP_URL = chrome.runtime.getURL("popup.html");
const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");
const injections = new Map();
const saves = new Map();
const saveTokens = new Map();
let creatingOffscreen = null;

function isChatUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && HOSTS.has(url.hostname); }
  catch { return false; }
}

async function requireChatTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Не удалось определить вкладку с чатом.");
  const tab = await chrome.tabs.get(tabId);
  if (!isChatUrl(tab.url)) throw new Error("Откройте нужный чат на chatgpt.com и нажмите значок расширения в этой вкладке.");
  return tab;
}

async function ensureExporter(tabId) {
  await requireChatTab(tabId);
  if (!injections.has(tabId)) {
    const task = (async () => {
      const [existing] = await chrome.scripting.executeScript({
        target: { tabId }, world: "ISOLATED",
        func: () => globalThis.GoodogChatExport?.version === "3.2.0",
      });
      if (!existing?.result) await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", files: ["i18n.js", "conversation-data.js", "archive-data.js", "exporter.js"] });
    })().finally(() => { if (injections.get(tabId) === task) injections.delete(tabId); });
    injections.set(tabId, task);
  }
  await injections.get(tabId);
}

async function invoke(tabId, method, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId }, world: "ISOLATED",
    func: (name, values) => {
      const api = globalThis.GoodogChatExport;
      if (!api || typeof api[name] !== "function") throw new Error("Расширение нужно заново открыть в этой вкладке.");
      return api[name](...values);
    }, args: [method, args],
  });
  if (!result || result.result === undefined) throw new Error("Вкладка перестала отвечать. Откройте расширение ещё раз.");
  return result.result;
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [OFFSCREEN_URL] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "offscreen.html", reasons: ["BLOBS"],
      justification: "Create the user's local MD or ZIP conversation export and release temporary memory after saving.",
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function blobCommand(type, fields = {}) {
  const response = await chrome.runtime.sendMessage({ target: "offscreen", type, ...fields });
  if (!response?.ok) throw new Error(response?.error || "Не удалось подготовить MD-файл.");
  return response;
}

function safeFilename(value, format = "md") {
  let name = String(value || "ChatGPT.md").normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, "_")
    .replace(/[\ud800-\udfff]/gu, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/[. ]+$/gu, "").trim();
  name = name.replace(/\.(?:md|txt|zip)$/iu, "");
  name = [...name].slice(0, 150).join("").replace(/[. ]+$/gu, "");
  if (!name) name = "ChatGPT";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) name = `ChatGPT_${name}`;
  return `${name}.${format === "zip" ? "zip" : "md"}`;
}

async function reportDownload(tabId, jobId, result) {
  try { await invoke(tabId, "downloadResult", [{ jobId, ...result }]); }
  catch { /* Navigating away ends the in-memory job; never read another page. */ }
}

async function finishDownload(downloadId, state, downloadError) {
  if (!await hasOffscreen()) return;
  const { job } = await blobCommand("GCE_BLOB_FIND_DOWNLOAD", { downloadId });
  if (!job) return;
  const key = `${job.tabId}:${job.jobId}`;
  const operation = saveTokens.get(key);
  if (operation?.token === job.token) saveTokens.delete(key);
  try {
    if (state === "complete") await reportDownload(job.tabId, job.jobId, { phase: "saved", filename: job.filename, format: job.format,
      ...(job.archive ? { archive: { ...job.archive, stage: "complete" } } : {}),
      message: job.format === "zip" ? job.archive?.missing ? "ZIP сохранён. Некоторые вложения недоступны — проверьте manifest.json в архиве." : "ZIP с чатом и доступными вложениями сохранён." : "MD-файл сохранён. Можно экспортировать другой чат." });
    else await reportDownload(job.tabId, job.jobId, { phase: "error", message: "Сохранение прервано. Собранный чат можно сохранить повторно.", error: String(downloadError || "Скачивание прервано.") });
  } finally { await blobCommand("GCE_BLOB_RELEASE", { token: job.token }); }
}

async function saveExport(tabId, expectedJobId, options = {}) {
  const state = await invoke(tabId, "getState");
  if (expectedJobId && state.jobId !== expectedJobId) return;
  if (state.phase === "collecting") throw new Error("Дождитесь сбора истории или остановите его для частичного сохранения.");
  if (state.phase === "saving") return;
  if (!state.count && !state.archiveAvailable) throw new Error("Пока нет сообщений для сохранения.");
  const format = (options.format || state.format) === "zip" ? "zip" : "md";
  const language = (options.language || state.language) === "ru" ? "ru" : "en";
  const jobId = state.jobId;
  const key = `${tabId}:${jobId}`;
  if (saves.has(key)) return saves.get(key);
  const task = (async () => {
    const token = crypto.randomUUID();
    const operation = { token, cancelled: false, downloadId: null };
    saveTokens.set(key, operation);
    let blobCreated = false;
    try {
      await reportDownload(tabId, jobId, { phase: "saving", format, language,
        archive: format === "zip" ? { stage: "preparing", total: 0, downloaded: 0, missing: 0, bytes: 0, coverage: "unknown" } : null,
        message: format === "zip" ? "Подготовка ZIP с чатом и вложениями…" : "Подготовка MD-файла…" });
      const meta = await invoke(tabId, "prepareExport", [{ language }]);
      if (meta.jobId !== jobId || !Number.isSafeInteger(meta.chars) || meta.chars < 1 || meta.chars > 134217728) throw new Error("Чат изменился или слишком велик для сохранения за один раз.");
      const filename = safeFilename(meta.filename, format);
      await ensureOffscreen();
      const tab = await requireChatTab(tabId);
      await blobCommand(format === "zip" ? "GCE_ARCHIVE_BEGIN" : "GCE_BLOB_BEGIN", { token, tabId, jobId, filename, language, origin: new URL(tab.url).origin });
      blobCreated = true;
      for (let offset = 0; offset < meta.chars;) {
        if (operation.cancelled) throw new Error("Archive cancelled.");
        const current = await invoke(tabId, "getState");
        if (current.jobId !== jobId) throw new Error("В этой вкладке начат другой экспорт. Предыдущее сохранение остановлено.");
        const chunk = await invoke(tabId, "readExportChunk", [offset, Math.min(262144, meta.chars - offset)]);
        if (typeof chunk !== "string" || !chunk.length || chunk.length > 262144) throw new Error("Не удалось прочитать собранный текст. Попробуйте сохранить повторно.");
        await blobCommand("GCE_BLOB_APPEND", { token, text: chunk });
        offset += chunk.length;
      }
      if (format === "zip") {
        const archiveMeta = await invoke(tabId, "prepareArchive", [{ language }]);
        if (archiveMeta.jobId !== jobId || !Number.isSafeInteger(archiveMeta.chars) || archiveMeta.chars < 1 || archiveMeta.chars > 134217728) throw new Error("Conversation archive is unavailable or too large.");
        for (let offset = 0; offset < archiveMeta.chars;) {
          if (operation.cancelled) throw new Error("Archive cancelled.");
          const current = await invoke(tabId, "getState");
          if (current.jobId !== jobId) throw new Error("The selected conversation changed during export.");
          const chunk = await invoke(tabId, "readArchiveChunk", [offset, Math.min(262144, archiveMeta.chars - offset)]);
          if (typeof chunk !== "string" || !chunk.length || chunk.length > 262144) throw new Error("Invalid archive data chunk.");
          await blobCommand("GCE_ARCHIVE_APPEND", { token, text: chunk });
          offset += chunk.length;
        }
        const { keys, archive } = await blobCommand("GCE_ARCHIVE_PARSE", { token });
        await reportDownload(tabId, jobId, { phase: "saving", progressOnly: true, archive: { ...archive, stage: "resolving" } });
        for (let offset = 0; offset < keys.length; offset += 8) {
          if (operation.cancelled) throw new Error("Archive cancelled.");
          const batch = keys.slice(offset, offset + 8);
          let files;
          try {
            const result = await invoke(tabId, "resolveAttachments", [{ jobId, keys: batch }]);
            files = Array.isArray(result?.files) ? result.files : [];
          } catch {
            files = [];
          }
          files = batch.map(key => files.find(item => item?.key === key) || { key, error: "The attachment could not be resolved in the active ChatGPT session." });
          if (operation.cancelled) throw new Error("Archive cancelled.");
          for (const file of files) {
            if (operation.cancelled) throw new Error("Archive cancelled.");
            const progress = await blobCommand("GCE_ARCHIVE_FILES", { token, files: [file] });
            await reportDownload(tabId, jobId, { phase: "saving", progressOnly: true, archive: { ...progress.archive, stage: "downloading" } });
          }
        }
      }
      if (operation.cancelled) throw new Error("Archive cancelled.");
      const { url, archive } = await blobCommand("GCE_BLOB_FINISH", { token });
      if (operation.cancelled) throw new Error("Archive cancelled.");
      await reportDownload(tabId, jobId, { phase: "saving", progressOnly: true, filename, ...(archive ? { archive: { ...archive, stage: "complete" } } : {}),
        message: format === "zip" ? "Выберите папку и подтвердите сохранение ZIP." : "Выберите папку и подтвердите сохранение MD." });
      if (operation.cancelled) throw new Error("Archive cancelled.");
      const downloadId = await chrome.downloads.download({ url, filename, saveAs: true, conflictAction: "uniquify" });
      operation.downloadId = downloadId;
      if (operation.cancelled) { try { await chrome.downloads.cancel(downloadId); } catch {} throw new Error("Archive cancelled."); }
      await blobCommand("GCE_BLOB_TRACK", { token, downloadId });
      const [download] = await chrome.downloads.search({ id: downloadId });
      if (download && ["complete", "interrupted"].includes(download.state)) await finishDownload(downloadId, download.state, download.error);
    } catch (error) {
      if (saveTokens.get(key) === operation) saveTokens.delete(key);
      if (operation.downloadId !== null) { try { await chrome.downloads.cancel(operation.downloadId); } catch {} }
      if (blobCreated) { try { await blobCommand("GCE_BLOB_RELEASE", { token }); } catch { /* The temporary document may already have closed. */ } }
      const detail = String(error?.message || "Не удалось сохранить файл.");
      const cancelled = /cancel|canceled|cancelled|отмен/iu.test(detail);
      await reportDownload(tabId, jobId, { phase: "error", message: cancelled ? "Сохранение отменено. Собранный чат можно сохранить повторно." : detail, error: detail });
    } finally {
      if (operation.downloadId === null && saveTokens.get(key) === operation) saveTokens.delete(key);
    }
  })().finally(() => { if (saves.get(key) === task) saves.delete(key); });
  saves.set(key, task);
  return task;
}

async function handle(message, sender) {
  if (message.type === "GCE_ARCHIVE_RESOLVE") {
    if (sender.url !== OFFSCREEN_URL || sender.tab) throw new Error("Unknown attachment refresh source.");
    const operation = saveTokens.get(`${message.tabId}:${message.jobId}`);
    if (!operation || operation.token !== message.token || operation.cancelled) throw new Error("Archive cancelled.");
    const file = await invoke(message.tabId, "resolveAttachment", [{ jobId: message.jobId, key: message.key }]);
    return { ok: true, file };
  }
  if (message.type === "GCE_ARCHIVE_PROGRESS") {
    if (sender.url !== OFFSCREEN_URL || sender.tab) throw new Error("Unknown archive progress source.");
    const operation = saveTokens.get(`${message.tabId}:${message.jobId}`);
    if (operation?.token === message.token && !operation.cancelled) {
      const state = await invoke(message.tabId, "getState");
      if (state.jobId === message.jobId && state.phase === "saving" && !operation.cancelled && saveTokens.get(`${message.tabId}:${message.jobId}`) === operation) await reportDownload(message.tabId, message.jobId, { phase: "saving", progressOnly: true, archive: message.archive });
    }
    return { ok: true };
  }
  if (message.type === "GCE_SAVE_DIALOG_HEARTBEAT") {
    if (sender.url !== OFFSCREEN_URL || sender.tab) throw new Error("Неизвестный источник состояния сохранения.");
    return { ok: true };
  }
  if (message.type === "GCE_READY") {
    if (!sender.tab || !isChatUrl(sender.url || sender.tab.url)) throw new Error("Неизвестный источник экспорта.");
    const tabId = sender.tab.id;
    await requireChatTab(tabId);
    void saveExport(tabId, message.jobId).catch(() => {});
    return { ok: true };
  }
  let trustedUi = false;
  try {
    const url = new URL(sender.url);
    const popup = new URL(POPUP_URL);
    trustedUi = url.protocol === popup.protocol && url.host === popup.host && url.pathname === popup.pathname;
  } catch { /* Only the packaged UI may issue export commands. */ }
  if (!trustedUi) throw new Error("Команда доступна только из окна расширения.");
  if (!["GCE_STATUS", "GCE_START", "GCE_CANCEL", "GCE_DOWNLOAD"].includes(message.type)) throw new Error("Неизвестная команда.");
  const tabId = message.tabId;
  await ensureExporter(tabId);
  if (message.type === "GCE_START") {
    const state = await invoke(tabId, "start", [{ includeLinks: message.options?.includeLinks !== false, autoDownload: true, maxDurationMs: 480000,
      format: message.options?.format === "md" ? "md" : "zip", language: message.options?.language === "ru" ? "ru" : "en" }]);
    return { ok: true, state };
  }
  if (message.type === "GCE_CANCEL") {
    const state = await invoke(tabId, "getState");
    const operation = saveTokens.get(`${tabId}:${state.jobId}`);
    if (operation) {
      operation.cancelled = true;
      if (operation.downloadId !== null) { try { await chrome.downloads.cancel(operation.downloadId); } catch {} }
      if (await hasOffscreen()) { try { await blobCommand("GCE_ARCHIVE_CANCEL", { token: operation.token }); } catch {} }
    } else if (state.phase === "saving") {
      // A browser worker restart can lose the in-flight command while the page retains its transcript.
      if (await hasOffscreen()) {
        try {
          const recovered = await blobCommand("GCE_BLOB_CANCEL_JOB", { tabId, jobId: state.jobId });
          if (Number.isInteger(recovered.downloadId)) { try { await chrome.downloads.cancel(recovered.downloadId); } catch {} }
        } catch {}
      }
      await reportDownload(tabId, state.jobId, { phase: "error", error: "Сохранение отменено. Полученные данные можно сохранить повторно." });
    }
    return { ok: true, state: await invoke(tabId, "cancel") };
  }
  if (message.type === "GCE_DOWNLOAD") {
    const state = await invoke(tabId, "getState");
    if (state.phase === "collecting") throw new Error("Сначала остановите сбор истории.");
    if (state.phase === "saving") return { ok: true, state };
    if (!state.count && !state.archiveAvailable) throw new Error("Нет сообщений для сохранения.");
    const format = message.options?.format === "md" ? "md" : "zip";
    void saveExport(tabId, state.jobId, { format, language: message.options?.language }).catch(error => reportDownload(tabId, state.jobId, { phase: "error", message: String(error?.message || error), error: "Сохранение не началось." }));
    return { ok: true, state: { ...state, phase: "saving", format, message: format === "zip" ? "Подготовка ZIP с чатом и вложениями…" : "Подготовка MD-файла…" } };
  }
  return { ok: true, state: await invoke(tabId, "getState") };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "background" || sender.id !== chrome.runtime.id) return false;
  handle(message, sender).then(respond, error => respond({ ok: false, error: String(error?.message || "Не удалось выполнить действие.") }));
  return true;
});

chrome.downloads.onChanged.addListener(change => {
  if (!change.state || !["complete", "interrupted"].includes(change.state.current)) return;
  void finishDownload(change.id, change.state.current, change.error?.current).catch(() => {});
});
