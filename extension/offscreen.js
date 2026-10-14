"use strict";

const jobs = new Map();
const MAX_AGE_MS = 30 * 60 * 1000;
const MAX_CHARS = 134217728;
const MAX_BYTES = 256 * 1024 * 1024;

function release(token) {
  const job = jobs.get(token);
  if (job?.url) URL.revokeObjectURL(job.url);
  if (job) { job.cancelled = true; for (const controller of job.controllers) controller.abort(); }
  jobs.delete(token);
}

function emitProgress(job, stage) {
  job.touchedAt = Date.now();
  const archive = { ...(job.builder?.status() || { total: 0, downloaded: 0, missing: 0, bytes: 0, coverage: "unknown" }), stage };
  void chrome.runtime.sendMessage({ target: "background", type: "GCE_ARCHIVE_PROGRESS", token: job.token,
    tabId: job.tabId, jobId: job.jobId, archive }).catch(() => {});
  return archive;
}

function appendText(job, text) {
  if (typeof text !== "string" || text.length > 262144) throw new Error("Invalid text chunk.");
  if (job.textChars + text.length > MAX_CHARS) throw new Error("The transcript exceeds the browser memory limit.");
  job.textChars += text.length;
  text = job.pendingHighSurrogate + text;
  job.pendingHighSurrogate = "";
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) { job.pendingHighSurrogate = text.slice(-1); text = text.slice(0, -1); }
  if (text) job.parts.push(text);
}

function textBlob(job) {
  if (job.pendingHighSurrogate) job.parts.push(job.pendingHighSurrogate);
  job.pendingHighSurrogate = "";
  return new Blob(job.parts, { type: "text/plain;charset=utf-8" });
}

function assetUrl(value, origin) {
  if (typeof value !== "string" || value.length > 16384) throw new Error("Unsupported attachment URL.");
  let url;
  try { url = new URL(value); } catch { throw new Error("Unsupported attachment URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443") throw new Error("Unsupported attachment URL.");
  const remote = url.hostname.endsWith(".oaiusercontent.com") || url.hostname === "oaiusercontent.com" ||
    url.hostname.endsWith(".blob.core.windows.net");
  const local = url.origin === origin && url.pathname === "/backend-api/estuary/content";
  if (!remote && !local) throw new Error("The attachment host is not supported.");
  return { url: url.href, local };
}

async function fetchFile(job, item, refreshed = false) {
  if (job.cancelled) throw new Error("Archive cancelled.");
  const target = assetUrl(item.url, job.origin);
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), refreshed ? 90000 : 180000);
  job.controllers.add(controller);
  let reader;
  try {
    const response = await fetch(target.url, { method: "GET", credentials: target.local ? "include" : "omit",
      redirect: "error", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal });
    if (!response.ok) {
      if (!refreshed && [401, 403].includes(response.status) && Date.now() - startedAt < 10000) {
        try { await response.body?.cancel(); } catch {}
        const fresh = await chrome.runtime.sendMessage({ target: "background", type: "GCE_ARCHIVE_RESOLVE", token: job.token,
          tabId: job.tabId, jobId: job.jobId, key: item.key });
        if (fresh?.ok && fresh.file?.url && fresh.file.url !== item.url && !job.cancelled) return await fetchFile(job, { ...item, ...fresh.file }, true);
      }
      throw new Error(`Attachment download returned HTTP ${response.status}.`);
    }
    const length = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(length) && length > MAX_BYTES) throw new Error("File exceeds the 256 MiB per-file browser memory limit.");
    if (!response.body) throw new Error("The attachment response has no file data.");
    reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (job.cancelled) throw new Error("Archive cancelled.");
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_BYTES) throw new Error("File exceeds the 256 MiB per-file browser memory limit.");
      if (job.builder.status().bytes + total > GoodogArchiveBuilder.MAX_ARCHIVE_BYTES - 32 * 1024 * 1024) throw new Error("Archive exceeds the 1.5 GiB browser memory limit.");
      chunks.push(part.value);
    }
    const mime = response.headers.get("Content-Type")?.split(";")[0] || item.mime || "application/octet-stream";
    return new Blob(chunks, { type: mime });
  } catch (error) {
    if (job.cancelled) throw new Error("Archive cancelled.");
    // Browser network errors can contain signed URLs. Only return controlled, URL-free diagnostics.
    if (/^(?:Attachment download returned HTTP \d+\.|File exceeds |Archive exceeds |The attachment response has no file data\.)/u.test(error?.message || "")) throw error;
    throw new Error("The attachment could not be downloaded. Check file permissions, access and connection.");
  } finally {
    if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
    clearTimeout(timer); job.controllers.delete(controller);
  }
}

async function handle(message) {
  const token = message.token;
  if (message.type === "GCE_BLOB_CANCEL_JOB") {
    const job = [...jobs.values()].find(item => item.tabId === message.tabId && item.jobId === message.jobId);
    const downloadId = job?.downloadId;
    if (job) release(job.token);
    return { ok: true, downloadId: Number.isInteger(downloadId) ? downloadId : null };
  }
  if (message.type === "GCE_BLOB_FIND_DOWNLOAD") {
    const job = [...jobs.values()].find(item => item.downloadId === message.downloadId);
    return { ok: true, job: job ? { token: job.token, tabId: job.tabId, jobId: job.jobId, filename: job.filename, format: job.format,
      archive: job.builder?.status() || null } : null };
  }
  if (typeof token !== "string" || !/^[a-f0-9-]{36}$/u.test(token)) throw new Error("Неверный идентификатор локального файла.");
  if (message.type === "GCE_BLOB_RELEASE") { release(token); return { ok: true }; }
  if (["GCE_BLOB_BEGIN", "GCE_ARCHIVE_BEGIN"].includes(message.type)) {
    if (jobs.size >= 8) throw new Error("Завершите сохранение предыдущих файлов и повторите попытку.");
    if (jobs.has(token)) throw new Error("Этот файл уже готовится.");
    const zip = message.type === "GCE_ARCHIVE_BEGIN";
    const origin = new URL(message.origin || "https://chatgpt.com").origin;
    if (!["https://chatgpt.com", "https://chat.openai.com"].includes(origin)) throw new Error("Unsupported conversation origin.");
    jobs.set(token, { token, tabId: message.tabId, jobId: message.jobId, filename: message.filename,
      format: zip ? "zip" : "txt", language: message.language === "ru" ? "ru" : "en", origin,
      parts: zip ? [] : ["\uFEFF"], textChars: 0, archiveParts: [], archiveChars: 0,
      pendingHighSurrogate: "", builder: null, url: null, touchedAt: Date.now(), downloadId: null,
      controllers: new Set(), cancelled: false, busy: false });
    return { ok: true };
  }
  const job = jobs.get(token);
  if (!job) throw new Error("Временный файл уже освобождён. Сохраните собранный чат повторно.");
  job.touchedAt = Date.now();
  if (message.type === "GCE_ARCHIVE_CANCEL") {
    job.cancelled = true;
    for (const controller of job.controllers) controller.abort();
    return { ok: true };
  }
  if (job.cancelled) throw new Error("Archive cancelled.");
  if (message.type === "GCE_BLOB_APPEND") {
    if (job.url) throw new Error("The file is already finalized.");
    appendText(job, message.text);
    return { ok: true };
  }
  if (message.type === "GCE_ARCHIVE_APPEND") {
    if (job.builder || typeof message.text !== "string" || message.text.length > 262144) throw new Error("Invalid archive data chunk.");
    job.archiveChars += message.text.length;
    if (job.archiveChars > MAX_CHARS) throw new Error("The conversation JSON exceeds the browser memory limit.");
    job.archiveParts.push(message.text);
    return { ok: true };
  }
  if (message.type === "GCE_ARCHIVE_PARSE") {
    if (job.format !== "zip" || job.builder) throw new Error("Invalid archive state.");
    const descriptor = JSON.parse(job.archiveParts.join(""));
    job.archiveParts = [];
    descriptor.language = job.language;
    job.builder = GoodogArchiveBuilder.create(descriptor, { text: await textBlob(job).text(), language: job.language });
    job.parts = [];
    const archive = emitProgress(job, "resolving");
    return { ok: true, keys: descriptor.attachments.map(item => item.key), archive };
  }
  if (message.type === "GCE_ARCHIVE_FILES") {
    if (!job.builder || job.busy || !Array.isArray(message.files) || message.files.length > 8) throw new Error("Invalid attachment batch.");
    job.busy = true;
    try {
      for (const file of message.files) {
        if (job.cancelled) throw new Error("Archive cancelled.");
        if (!job.builder.descriptor.attachments.some(item => item.key === file.key)) throw new Error("Unknown attachment key.");
        let result = { error: String(file.error || "File is unavailable.") };
        if (file.url && !file.error) {
          emitProgress(job, "downloading");
          try { result = { blob: await fetchFile(job, file), name: file.name, mime: file.mime }; }
          catch (error) { if (job.cancelled) throw error; result = { error: error.message }; }
        }
        await job.builder.addAttachment(file.key, result);
        emitProgress(job, "downloading");
      }
      return { ok: true, archive: job.builder.status() };
    } finally { job.busy = false; }
  }
  if (message.type === "GCE_BLOB_FINISH") {
    if (!job.url) {
      if (job.format === "zip") {
        if (!job.builder || job.busy) throw new Error("Archive is not ready.");
        job.busy = true;
        try {
          emitProgress(job, "packing");
          const result = await job.builder.finish();
          if (job.cancelled) throw new Error("Archive cancelled.");
          job.url = URL.createObjectURL(result.blob);
          emitProgress(job, "complete");
        } finally { job.busy = false; }
      } else {
        job.url = URL.createObjectURL(textBlob(job)); job.parts = [];
      }
    }
    return { ok: true, url: job.url, ...(job.builder ? { archive: job.builder.status() } : {}) };
  }
  if (message.type === "GCE_BLOB_TRACK") {
    if (!Number.isInteger(message.downloadId)) throw new Error("Скачивание не началось.");
    job.downloadId = message.downloadId;
    return { ok: true };
  }
  throw new Error("Неизвестная операция с локальным файлом.");
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "offscreen" || sender.id !== chrome.runtime.id || sender.tab) return false;
  handle(message).then(respond, error => respond({ ok: false, error: String(error?.message || "Не удалось создать файл.") }));
  return true;
});

setInterval(() => {
  if ([...jobs.values()].some(job => (job.url || job.busy) && job.downloadId === null)) {
    void chrome.runtime.sendMessage({ target: "background", type: "GCE_SAVE_DIALOG_HEARTBEAT" }).catch(() => {});
  }
}, 15000);

setInterval(() => {
  const oldest = Date.now() - MAX_AGE_MS;
  for (const job of jobs.values()) if (!job.busy && job.touchedAt < oldest) release(job.token);
}, 60000);
