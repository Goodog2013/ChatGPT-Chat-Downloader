"use strict";
importScripts("i18n.js", "vendor/marked.umd.js", "markdown-renderer.js", "conversation-data.js", "archive-data.js", "zip-store.js", "archive-builder.js", "vendor/zip-legacy.min.js", "zip-reader.js", "archive-site.js");

let sources = [];
let entries = [];
let generation = 0;
let archiveSource = null;
let importController = null;
const MAX_CONVERSATION_BYTES = 64 * 1024 * 1024;
const MAX_CONVERSATIONS = 20000;
const manifestCache = new Map();

function localFiles(values) {
  return (Array.isArray(values) ? values : []).flatMap(value => {
    const file = value instanceof Blob ? value : value?.file;
    if (!(file instanceof Blob)) return [];
    const path = typeof value?.path === "string" ? value.path : file.webkitRelativePath || file.name || "";
    return [{ file, path: path.replace(/\\/gu, "/"), name: path.replace(/\\/gu, "/").split("/").pop() }];
  });
}

function matchFile(attachment, files) {
  const pick = predicate => {
    const matches = files.filter(predicate);
    return matches.length === 1 ? matches[0] : null;
  };
  if (attachment.id) {
    const id = String(attachment.id).toLowerCase();
    const exact = pick(item => item.name.toLowerCase() === id);
    if (exact) return exact;
    const withId = pick(item => {
      const name = item.name.toLowerCase(), at = name.indexOf(id);
      return at >= 0 && (at === 0 || !/[a-z0-9]/u.test(name[at - 1])) &&
        (at + id.length === name.length || !/[a-z0-9]/u.test(name[at + id.length]));
    });
    if (withId) return withId;
  }
  const names = new Set([attachment.name].filter(value => typeof value === "string" && value).map(value => value.toLowerCase()));
  if (attachment.source?.value?.startsWith("sandbox:/mnt/data/")) names.add(attachment.source.value.split("/").pop().toLowerCase());
  return pick(item => names.has(item.name.toLowerCase()));
}

function prepareExport(conversation, data) {
  const language = data.language === "ru" ? "ru" : "en";
  const isPublic = conversation?.schemaVersion === 1 && Array.isArray(conversation.messages) && Array.isArray(conversation.attachments);
  let descriptor, transcript;
  if (isPublic) {
    descriptor = GoodogArchiveData.publicConversation(conversation);
    descriptor.language = language;
    const keys = descriptor.attachments.map(item => item.key);
    if (new Set(keys).size !== keys.length || keys.some(key => !/^[a-z0-9_-]{1,128}$/iu.test(key))) throw new Error("Invalid attachment identifiers in conversation.json.");
    const adapted = { title: descriptor.title, id: descriptor.id, page_info: { has_previous_page: false, has_next_page: false },
      messages: descriptor.messages.map(message => ({ id: message.id, author: { role: message.role, name: message.author },
        content: { content_type: "text", parts: [message.text] } })) };
    transcript = GoodogConversationData.exportConversation(adapted, { includeLinks: data.includeLinks !== false, allowEmpty: true, language, coverage: descriptor.coverage, warnings: descriptor.warnings });
  } else {
    transcript = GoodogConversationData.exportConversation(conversation, { includeLinks: data.includeLinks !== false, allowEmpty: true, language });
    try {
      descriptor = GoodogArchiveData.prepare(conversation, { includeLinks: data.includeLinks !== false, coverage: transcript.coverage, language, warnings: transcript.warnings });
    } catch (error) {
      if (transcript.stats.visibleMessages !== 0) throw error;
      descriptor = { schemaVersion: 1, language, title: String(conversation.title || "ChatGPT"), id: String(conversation.id || conversation.conversation_id || ""), url: "", exportedAt: new Date().toISOString(), coverage: transcript.coverage, warnings: transcript.warnings, messages: [], attachments: [] };
    }
  }
  return { descriptor, transcript, language };
}

async function getManifest(entry) {
  if (!archiveSource) return null;
  if (manifestCache.has(entry.sourceIndex)) return manifestCache.get(entry.sourceIndex);
  const base = entry.jsonPath ? entry.jsonPath.slice(0, entry.jsonPath.lastIndexOf("/") + 1) : "";
  const item = archiveSource.find(base + "manifest.json");
  let manifest = null;
  if (item) {
    const parsed = JSON.parse(await (await archiveSource.read(item, 8 * 1024 * 1024)).text());
    if (Array.isArray(parsed?.files)) {
      const files = new Map();
      for (const item of parsed.files) if (typeof item?.key === "string") {
        if (files.has(item.key)) throw new Error("Ambiguous attachment keys in manifest.json.");
        files.set(item.key, item);
      }
      manifest = { base, files };
    }
  }
  manifestCache.set(entry.sourceIndex, manifest);
  return manifest;
}

async function attachmentData(attachment, entry, files, remaining = Infinity) {
  const selected = matchFile(attachment, files);
  if (selected) return { blob: selected.file, name: attachment.name, mime: selected.file.type || attachment.mime };
  if (!archiveSource) return { error: "The file was not found unambiguously in the selected export folder." };
  let manifest;
  try { manifest = await getManifest(entry); } catch (error) { return { error: String(error?.message || "The attachment manifest could not be read.") }; }
  const manifestFile = manifest?.files.get(attachment.key);
  let item;
  if (manifestFile) {
    const path = GoodogZipReader.safePath(manifestFile.path);
    if (manifestFile.status !== "saved" || !path) return { error: manifestFile.error || "The source archive reports this attachment as missing." };
    item = archiveSource.find(manifest.base + path);
  } else item = matchFile(attachment, archiveSource.entries);
  if (!item) return { error: "No unambiguous matching file was found inside the ZIP." };
  if (item.entry.uncompressedSize > remaining) return { error: "The HTML-site attachment budget was reached. Text is retained." };
  try {
    const blob = await archiveSource.read(item);
    const mime = blob.type !== "application/octet-stream" ? blob.type : attachment.mime;
    return { blob, name: attachment.name, mime };
  } catch (error) { return { error: String(error?.message || "The attachment could not be read from the ZIP.") }; }
}

async function exportArchive(conversation, entry, data, ticket) {
  const { descriptor, transcript, language } = prepareExport(conversation, data);
  const builder = GoodogArchiveBuilder.create(descriptor, { text: transcript.text, language });
  const files = localFiles(data.files);
  for (const attachment of descriptor.attachments) {
    if (ticket !== generation) throw new Error("Чтение заменено другим файлом.");
    await builder.addAttachment(attachment.key, await attachmentData(attachment, entry, files));
    const status = builder.status();
    postMessage({ type: "PROGRESS", requestId: data.requestId, archive: status,
      message: language === "en" ? `Packing attachments: ${status.downloaded + status.missing} / ${status.total}.` : `Упаковка вложений: ${status.downloaded + status.missing} / ${status.total}.` });
  }
  const result = await builder.finish();
  const warnings = [...descriptor.warnings];
  if (result.archive.missing) warnings.push(language === "en" ? "Some attachments are missing. See manifest.json in the ZIP." : "Часть вложений отсутствует. Подробности — в manifest.json внутри ZIP.");
  return { format: "zip", blob: result.blob, filename: transcript.filename.replace(/\.md$/iu, ".zip"), count: transcript.count,
    warnings, coverage: descriptor.coverage, stats: transcript.stats, archive: result.archive };
}

async function readConversation(entry, ticket) {
  const source = sources[entry.sourceIndex];
  const parsed = await parseSlice(source, entry.start, entry.end);
  if (ticket !== generation) throw new Error("Чтение заменено другим файлом.");
  const conversation = GoodogConversationData.getConversations(parsed)[entry.innerIndex];
  if (!conversation) throw new Error("Conversation data was not found.");
  return conversation;
}

async function exportSite(data, ticket) {
  const language = data.language === "ru" ? "ru" : "en", files = localFiles(data.files);
  const writer = GoodogZip.createWriter();
  const rows = [], report = { schemaVersion: 1, generator: "Goodog Chat Export 3.2.0 HTML site", createdAt: new Date().toISOString(), conversations: [], limits: { maxArchiveBytes: GoodogArchiveBuilder.MAX_ARCHIVE_BYTES, attachmentBudgetBytes: 1024 ** 3 } };
  const archive = { total: 0, downloaded: 0, missing: 0, bytes: 0, coverage: "complete" };
  let count = 0, coverage = "complete", reservedAttachments = 0;
  const reserveAttachment = bytes => {
    if (reservedAttachments + bytes > 1024 ** 3) return false;
    reservedAttachments += bytes; return true;
  };
  for (const [index, entry] of entries.entries()) {
    if (ticket !== generation) throw new Error("Чтение заменено другим файлом.");
    const prefix = `chats/${String(index + 1).padStart(6, "0")}/`;
    let row;
    try {
      const conversation = await readConversation(entry, ticket);
      const { descriptor, transcript } = prepareExport(conversation, data);
      const builder = GoodogArchiveBuilder.create(descriptor, { text: transcript.text, language, writer, prefix, embedded: true, reserveAttachment });
      for (const attachment of descriptor.attachments) {
        if (ticket !== generation) throw new Error("Чтение заменено другим файлом.");
        await builder.addAttachment(attachment.key, await attachmentData(attachment, entry, files, 1024 ** 3 - reservedAttachments));
        postMessage({ type: "PROGRESS", requestId: data.requestId, archive: { ...archive, total: archive.total + descriptor.attachments.length, downloaded: archive.downloaded + builder.status().downloaded, missing: archive.missing + builder.status().missing, bytes: archive.bytes + builder.status().bytes }, message: language === "ru" ? `HTML-сайт: чат ${index + 1} из ${entries.length} · вложения ${builder.status().downloaded + builder.status().missing} / ${descriptor.attachments.length}.` : `HTML site: chat ${index + 1} of ${entries.length} · attachments ${builder.status().downloaded + builder.status().missing} / ${descriptor.attachments.length}.` });
      }
      const result = await builder.finish();
      for (const key of ["total", "downloaded", "missing", "bytes"]) archive[key] += result.archive[key];
      count += descriptor.messages.length;
      if (descriptor.coverage !== "complete") coverage = "partial";
      row = { title: descriptor.title, path: prefix + "chat.html", messageCount: descriptor.messages.length, coverage: descriptor.coverage,
        updatedAt: descriptor.messages.at(-1)?.createdAt || null };
      report.conversations.push({ ...row, manifestPath: prefix + "manifest.json", attachmentCoverage: result.archive.coverage });
    } catch (error) {
      if (ticket !== generation || importController.signal.aborted) throw error;
      // Writer/size errors cannot be hidden behind a fake "complete" archive.
      const message = String(error?.message || "Conversation conversion failed.");
      if (/ZIP|archive.*limit|already.*final|Duplicate ZIP|pending ZIP/iu.test(message)) throw error;
      coverage = "partial"; archive.coverage = "partial";
      row = { title: entry.title, path: prefix + "chat.html", messageCount: 0, coverage: "partial", updatedAt: null };
      await writer.add(row.path, GoodogChatSite.errorHtml(entry.title, message, language));
      report.conversations.push({ ...row, error: message });
    }
    rows.push(row);
    postMessage({ type: "PROGRESS", requestId: data.requestId, archive, message: language === "ru" ? `HTML-сайт: готово ${index + 1} из ${entries.length} чатов.` : `HTML site: ${index + 1} of ${entries.length} conversations ready.` });
  }
  if (archive.missing) archive.coverage = "partial";
  report.historyCoverage = coverage; report.attachmentCoverage = archive.coverage; report.summary = archive;
  rows.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  await writer.add("index.html", await GoodogChatSite.indexHtml(rows, { language }));
  await writer.add("manifest.json", JSON.stringify(report, null, 2));
  await writer.add("README.txt", language === "ru" ? "Распакуйте весь ZIP и откройте index.html. Переписки открываются локально, по одной. В chats находятся HTML, Markdown, JSON и доступные вложения каждого чата. Читайте manifest.json для полноты истории и недоступных файлов. Это офлайн-архив, а не подключение к ChatGPT.\r\n" : "Extract the complete ZIP and open index.html. Conversations load locally, one at a time. The chats folder contains each conversation's HTML, Markdown, JSON and available attachments. See manifest.json for history coverage and unavailable files. This is an offline archive, not a connection to ChatGPT.\r\n");
  const warnings = [];
  if (coverage === "partial") warnings.push(language === "ru" ? "Некоторые переписки неполны или не преобразованы. Подробности — в manifest.json." : "Some conversations are partial or could not be converted. See manifest.json.");
  if (archive.coverage === "partial") warnings.push(language === "ru" ? "Некоторые вложения недоступны. Подробности — в отчётах каждого чата." : "Some attachments are unavailable. See each conversation's report.");
  return { format: "zip", blob: writer.finish(), filename: `ChatGPT-HTML-Archive-${report.createdAt.slice(0, 10)}.zip`, count, conversationCount: rows.length, warnings, coverage, archive };
}

async function parseSlice(source, start, end) {
  if (end - start > MAX_CONVERSATION_BYTES) throw new Error("One conversation exceeds the 64 MiB JSON processing limit.");
  const text = await source.slice(start, end).text();
  try { return JSON.parse(text.replace(/^\uFEFF/u, "")); }
  catch { throw new Error("Не удалось разобрать JSON. Распакуйте архив ChatGPT и выберите именно conversations.json."); }
}

async function indexFile(source, requestId, ticket) {
  const reader = source.stream().getReader();
  const result = [];
  let position = 0, mode = "", depth = 0, quoted = false, escaped = false, start = -1, finished = false;
  let arrayState = "value", hadValue = false, lastProgress = 0;
  const whitespace = byte => [9, 10, 13, 32].includes(byte);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (generation !== ticket) throw new Error("Чтение заменено другим файлом.");
      for (let index = 0; index < value.length; index++, position++) {
        const byte = value[index];
        if (!mode) {
          if (position < 3 && [239, 187, 191].includes(byte) || whitespace(byte)) continue;
          if (byte === 91) { mode = "array"; continue; }
          if (byte === 123) { mode = "single"; start = position; depth = 1; continue; }
          throw new Error("Выберите ZIP или JSON экспорта ChatGPT. HTML и MD не содержат полной структуры переписки.");
        }
        if (finished) { if (!whitespace(byte)) throw new Error("После JSON найдены посторонние данные."); continue; }
        if (mode === "array" && depth === 0) {
          if (whitespace(byte)) continue;
          if (byte === 44 && arrayState === "separator") { arrayState = "value"; continue; }
          if (byte === 93 && (arrayState === "separator" || !hadValue)) { finished = true; continue; }
          if (byte !== 123 || arrayState !== "value") throw new Error("Ожидался JSON-массив разговоров ChatGPT.");
          start = position; depth = 1; quoted = false; escaped = false;
          continue;
        }
        if (quoted) {
          if (escaped) escaped = false;
          else if (byte === 92) escaped = true;
          else if (byte === 34) quoted = false;
          continue;
        }
        if (byte === 34) { quoted = true; continue; }
        if (byte === 123 || byte === 91) depth++;
        else if (byte === 125 || byte === 93) depth--;
        if (depth < 0) throw new Error("Неверная структура JSON.");
        if (depth === 0) {
          const parsed = await parseSlice(source, start, position + 1);
          if (generation !== ticket) throw new Error("Чтение заменено другим файлом.");
          const descriptions = GoodogConversationData.listConversations(parsed);
          for (const item of descriptions) {
            if (result.length >= MAX_CONVERSATIONS) throw new Error("The import exceeds 20,000 conversations.");
            result.push({ ...item, index: result.length, start, end: position + 1, innerIndex: item.index });
          }
          hadValue = true; arrayState = "separator";
          if (mode === "single") finished = true;
          if (performance.now() - lastProgress > 250) {
            postMessage({ type: "PROGRESS", requestId, count: result.length, message: `Проиндексировано разговоров: ${result.length}. Прочитано ${Math.round((position + 1) / source.size * 100)}%.` });
            lastProgress = performance.now();
          }
        }
      }
    }
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
  if (!finished || depth !== 0 || quoted) throw new Error("JSON оборван. Загрузите полный conversations.json из экспорта ChatGPT.");
  if (!result.length) throw new Error("В файле нет разговоров с mapping или messages.");
  return result;
}

self.onmessage = async ({ data }) => {
  const requestId = data?.requestId;
  let actionTicket = generation;
  try {
    if (data?.type === "LOAD") {
      const ticket = ++generation;
      actionTicket = ticket;
      importController?.abort();
      if (archiveSource) await archiveSource.close();
      if (ticket !== generation) return;
      importController = new AbortController();
      sources = []; entries = []; archiveSource = null; manifestCache.clear();
      if (!(data.file instanceof Blob) || !data.file.size) throw new Error("Выберите непустой ZIP или JSON-файл.");
      const zipped = await GoodogZipReader.isZip(data.file);
      let lastProgress = 0;
      if (zipped) {
        const opened = await GoodogZipReader.open(data.file, { signal: importController.signal, onProgress: ({ loaded, total }) => {
          if (performance.now() - lastProgress > 250) { lastProgress = performance.now(); postMessage({ type: "PROGRESS", requestId, message: `Reading ZIP: ${Math.round(loaded / Math.max(1, total) * 100)}%.` }); }
        } });
        if (ticket !== generation) { await opened.close(); return; }
        archiveSource = opened;
        for (const item of archiveSource.jsonEntries) {
          const source = await archiveSource.read(item, GoodogZipReader.MAX_JSON_BYTES);
          if (ticket !== generation) return;
          const sourceIndex = sources.length;
          sources.push(source);
          const indexed = await indexFile(source, requestId, ticket);
          for (const entry of indexed) {
            if (entries.length >= MAX_CONVERSATIONS) throw new Error("The import exceeds 20,000 conversations.");
            entries.push({ ...entry, index: entries.length, sourceIndex, jsonPath: item.path });
          }
        }
      } else {
        if (data.file.size > GoodogZipReader.MAX_JSON_BYTES) throw new Error("Conversation JSON exceeds the combined 512 MiB import limit.");
        sources.push(data.file);
        entries = (await indexFile(data.file, requestId, ticket)).map(entry => ({ ...entry, sourceIndex: 0, jsonPath: "" }));
      }
      if (ticket !== generation) return;
      postMessage({ type: "LOADED", requestId, sourceKind: zipped ? "zip" : "json", conversationCount: entries.length, conversations: entries.map(({ index, id, title, messageCount }) => ({ index, id, title, messageCount })), warnings: [] });
      return;
    }
    if (data?.type === "EXPORT") {
      if (!sources.length || !Number.isInteger(data.index) || !entries[data.index]) throw new Error("Сначала выберите файл и разговор.");
      const entry = entries[data.index], ticket = generation;
      const conversation = await readConversation(entry, ticket);
      const result = data.format === "zip" ? await exportArchive(conversation, entry, data, ticket)
        : { ...prepareExport(conversation, data).transcript, format: "md" };
      if (ticket !== generation) return;
      postMessage({ type: "EXPORTED", requestId, ...result });
      return;
    }
    if (data?.type === "EXPORT_SITE") {
      if (!sources.length || !entries.length) throw new Error("Сначала выберите файл и разговор.");
      const ticket = generation;
      const result = await exportSite(data, ticket);
      if (ticket !== generation) return;
      postMessage({ type: "EXPORTED", requestId, ...result });
      return;
    }
    throw new Error("Неизвестная команда обработки JSON.");
  } catch (error) {
    if (actionTicket !== generation) return;
    if (data?.type === "LOAD") {
      importController?.abort();
      if (archiveSource) await archiveSource.close();
      sources = []; entries = []; archiveSource = null; manifestCache.clear();
    }
    postMessage({ type: "ERROR", requestId, error: String(error?.message || "Не удалось обработать JSON.") });
  }
};
