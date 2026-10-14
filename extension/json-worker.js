"use strict";
importScripts("i18n.js", "conversation-data.js", "archive-data.js", "zip-store.js", "archive-builder.js");

let file = null;
let entries = [];
let generation = 0;

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

async function exportArchive(conversation, data, ticket) {
  const language = data.language === "ru" ? "ru" : "en";
  const transcript = GoodogConversationData.exportConversation(conversation, { includeLinks: data.includeLinks !== false, allowEmpty: true, language });
  const descriptor = GoodogArchiveData.prepare(conversation, { includeLinks: data.includeLinks !== false, coverage: transcript.coverage, language, warnings: transcript.warnings });
  const builder = GoodogArchiveBuilder.create(descriptor, { text: transcript.text, language });
  const files = localFiles(data.files);
  for (const attachment of descriptor.attachments) {
    if (ticket !== generation) throw new Error("Чтение заменено другим файлом.");
    const selected = matchFile(attachment, files);
    await builder.addAttachment(attachment.key, selected ? { blob: selected.file, name: attachment.name, mime: selected.file.type || attachment.mime }
      : { error: language === "en" ? "The file was not found unambiguously in the selected export folder. Select the extracted export folder, including attachments." : "Файл не найден однозначно в выбранной папке. Выберите распакованную папку экспорта вместе с вложениями." });
    const status = builder.status();
    postMessage({ type: "PROGRESS", requestId: data.requestId, archive: status,
      message: language === "en" ? `Packing attachments: ${status.downloaded + status.missing} / ${status.total}.` : `Упаковка вложений: ${status.downloaded + status.missing} / ${status.total}.` });
  }
  const result = await builder.finish();
  const warnings = [...descriptor.warnings];
  if (result.archive.missing) warnings.push(language === "en" ? "Some attachments are missing. See manifest.json in the ZIP." : "Часть вложений отсутствует. Подробности — в manifest.json внутри ZIP.");
  return { format: "zip", blob: result.blob, filename: transcript.filename.replace(/\.txt$/iu, ".zip"), count: transcript.count,
    warnings, coverage: descriptor.coverage, stats: transcript.stats, archive: result.archive };
}

async function parseSlice(source, start, end) {
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
          throw new Error("Выберите JSON из распакованного экспорта. ZIP, HTML и TXT здесь не поддерживаются.");
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
          for (const item of descriptions) result.push({ ...item, index: result.length, start, end: position + 1, innerIndex: item.index });
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
  try {
    if (data?.type === "LOAD") {
      const ticket = ++generation;
      file = null; entries = [];
      if (!(data.file instanceof Blob) || !data.file.size) throw new Error("Выберите непустой JSON-файл.");
      const source = data.file;
      const indexed = await indexFile(source, requestId, ticket);
      if (ticket !== generation) return;
      file = source; entries = indexed;
      postMessage({ type: "LOADED", requestId, conversations: indexed.map(({ index, id, title, messageCount }) => ({ index, id, title, messageCount })), warnings: [] });
      return;
    }
    if (data?.type === "EXPORT") {
      if (!file || !Number.isInteger(data.index) || !entries[data.index]) throw new Error("Сначала выберите файл и разговор.");
      const entry = entries[data.index], source = file, ticket = generation;
      const parsed = await parseSlice(source, entry.start, entry.end);
      if (ticket !== generation) return;
      const conversation = GoodogConversationData.getConversations(parsed)[entry.innerIndex];
      const result = data.format === "zip" ? await exportArchive(conversation, data, ticket)
        : { ...GoodogConversationData.exportConversation(conversation, { includeLinks: data.includeLinks !== false, language: data.language }), format: "txt" };
      if (ticket !== generation) return;
      postMessage({ type: "EXPORTED", requestId, ...result });
      return;
    }
    throw new Error("Неизвестная команда обработки JSON.");
  } catch (error) { postMessage({ type: "ERROR", requestId, error: String(error?.message || "Не удалось обработать JSON.") }); }
};
