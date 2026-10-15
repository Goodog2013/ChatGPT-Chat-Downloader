/* Shared local ZIP assembly; no network, credentials or persistent storage. */
(() => {
  "use strict";
  const MAX_ARCHIVE_BYTES = 1536 * 1024 * 1024;
  const MAX_FILE_BYTES = 256 * 1024 * 1024;
  const RESERVED_BYTES = 32 * 1024 * 1024;
  const MAX_MARKDOWN_PREVIEW_BYTES = 2 * 1024 * 1024;
  const MAX_PREVIEW_TOTAL_BYTES = 8 * 1024 * 1024;
  const MIME_EXTENSIONS = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif", "image/svg+xml": ".svg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/wav": ".wav", "audio/ogg": ".ogg", "video/mp4": ".mp4", "video/webm": ".webm", "application/pdf": ".pdf", "text/plain": ".txt", "text/markdown": ".md", "text/x-markdown": ".md", "application/zip": ".zip" };
  const safeName = value => {
    let name = String(value || "attachment").normalize("NFC").split(/[\\/]/u).pop()
      .replace(/[<>:"|?*\u0000-\u001f\u007f]/gu, "_")
      .replace(/[\u202a-\u202e\u2066-\u2069\ud800-\udfff]/gu, "").trim().replace(/[. ]+$/gu, "");
    name = [...name].slice(0, 140).join("").replace(/[. ]+$/gu, "") || "attachment";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) name = `file_${name}`;
    return name;
  };
  function create(descriptor, options = {}) {
    if (!descriptor || !Array.isArray(descriptor.messages) || !Array.isArray(descriptor.attachments)) throw new Error("Invalid archive conversation data.");
    if (descriptor.attachments.length > 20000) throw new Error("Too many attachments for one archive.");
    const writer = globalThis.GoodogZip.createWriter({ maxBytes: MAX_ARCHIVE_BYTES });
    const language = options.language === "ru" ? "ru" : "en";
    const manifest = { schemaVersion: 1, generator: "Goodog Chat Export 3.1.0", exportedAt: descriptor.exportedAt,
      scope: descriptor.availableAlternatesCount > 0 ? "current_branch_and_available_alternates" : "current_conversation_branch",
      availableAlternatesCount: descriptor.availableAlternatesCount || 0, historyCoverage: descriptor.coverage || "partial", attachmentCoverage: "unknown",
      limits: { maxArchiveBytes: MAX_ARCHIVE_BYTES, maxFileBytes: MAX_FILE_BYTES }, files: [] };
    const sources = new Map(descriptor.attachments.map(item => [item.key, item]));
    const completed = new Set();
    let bytes = 0, previewBytes = 0, finished = false;
    const status = () => {
      const missing = manifest.files.filter(item => item.status !== "saved").length;
      return { total: sources.size, downloaded: manifest.files.length - missing, missing, bytes,
        coverage: missing ? "partial" : completed.size === sources.size ? "complete" : "unknown" };
    };

    async function addAttachment(key, result = {}) {
      if (finished) throw new Error("Archive has already been finalized.");
      const source = sources.get(key);
      if (!source || completed.has(key)) return status();
      const entry = { key, id: source.id || null, name: safeName(result.name || source.name || source.id || key),
        kind: source.kind || "file", mime: String(result.mime || result.blob?.type || source.mime || "application/octet-stream").split(";")[0],
        messageIds: Array.isArray(source.messageIds) ? source.messageIds : [], status: "missing", path: null, bytes: 0, sha256: null };
      const blob = result.blob;
      if (!(blob instanceof Blob)) entry.error = String(result.error || "File is unavailable.").slice(0, 500);
      else if (blob.size > MAX_FILE_BYTES) entry.error = "File exceeds the 256 MiB per-file browser memory limit.";
      else if (bytes + blob.size > MAX_ARCHIVE_BYTES - RESERVED_BYTES) entry.error = "Archive exceeds the 1.5 GiB browser memory limit.";
      else {
        const ext = /\.[a-z0-9]{1,10}$/iu.test(entry.name) ? "" : MIME_EXTENSIONS[entry.mime] || "";
        entry.path = `attachments/${String(manifest.files.length + 1).padStart(5, "0")}-${entry.name}${ext}`;
        try {
          const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
          entry.sha256 = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("");
          await writer.add(entry.path, blob);
          entry.bytes = blob.size; entry.status = "saved"; bytes += blob.size;
        } catch {
          entry.path = null; entry.sha256 = null;
          entry.error = "The file could not be added to the archive.";
        }
      }
      if (entry.status === "saved" && (/\.(?:md|markdown|mdown)$/iu.test(entry.path) || ["text/markdown", "text/x-markdown"].includes(entry.mime))) {
        try {
          if (blob.size > MAX_MARKDOWN_PREVIEW_BYTES) throw new Error("preview limit");
          const markdown = new TextDecoder("utf-8", { fatal: true }).decode(await blob.arrayBuffer());
          const originalPath = "../" + entry.path.split("/").map(part => encodeURIComponent(part)).join("/");
          const preview = new Blob([GoodogMarkdown.document(markdown, { title: entry.name, language, downloadHref: originalPath })], { type: "text/html;charset=utf-8" });
          if (previewBytes + preview.size > MAX_PREVIEW_TOTAL_BYTES) throw new Error("preview limit");
          const path = `previews/${String(manifest.files.length + 1).padStart(5, "0")}-${entry.name}.html`;
          await writer.add(path, preview);
          entry.previewPath = path; entry.previewBytes = preview.size; previewBytes += preview.size;
        } catch {
          entry.previewError = language === "ru" ? "HTML-просмотр недоступен. Оригинал Markdown сохранён; предел просмотра — 2 МиБ на UTF-8-файл и 8 МиБ HTML на архив." : "HTML preview unavailable. The original Markdown is saved; preview limits are 2 MiB per UTF-8 file and 8 MiB of HTML per archive.";
        }
      }
      if (entry.error) entry.error = globalThis.GoodogI18n?.translate(entry.error, language) || entry.error;
      completed.add(key); manifest.files.push(entry);
      return status();
    }

    async function finish() {
      if (finished) throw new Error("Archive has already been finalized.");
      for (const key of sources.keys()) if (!completed.has(key)) await addAttachment(key, { error: "No file data was provided." });
      finished = true;
      manifest.attachmentCoverage = status().coverage;
      manifest.summary = status();
      const publicData = globalThis.GoodogArchiveData.publicConversation(descriptor);
      await writer.add("chat.md", new Blob(["\uFEFF", options.text || ""], { type: "text/markdown;charset=utf-8" }));
      await writer.add("conversation.json", JSON.stringify(publicData, null, 2));
      await writer.add("manifest.json", JSON.stringify(manifest, null, 2));
      await writer.add("chat.html", globalThis.GoodogArchiveData.renderHtml(descriptor, manifest));
      const readme = language === "en" ? [
        "Goodog Chat Export 3.1.0", "", "Open chat.html to read this conversation offline with Markdown formatting. chat.md contains the Markdown transcript.",
        "Markdown attachments have an Open Markdown link in chat.html. HTML previews live in previews/; originals stay in attachments/.",
        "Preview limits: UTF-8 Markdown up to 2 MiB per file, 8 MiB of preview HTML total. The original file is retained when a preview is unavailable.",
        "conversation.json contains visible messages and file references. attachments/ contains original available files.",
        "manifest.json lists every detected attachment, its local path, size and SHA-256, or a reason why it is missing.",
        "History coverage and attachment coverage are separate. Unavailable, expired and oversized files are reported; they are never replaced with fake file placeholders.",
        "This archive contains the selected current branch. Other conversations and hidden instructions/reasoning are excluded.",
        "When the API supplies a mapping, available alternative visible nodes may also appear in conversation.json; no alternative branch is fetched by guessing endpoints.",
        "Source links remain web links. Their remote pages are not downloaded. Text is not translated.",
        "Browser memory limits: 256 MiB per attachment, 1.5 GiB total ZIP. Larger content is explicitly reported as missing.",
      ] : [
        "Goodog Chat Export 3.1.0", "", "Откройте chat.html для чтения чата офлайн с оформлением Markdown. chat.md содержит переписку в Markdown.",
        "У Markdown-вложений есть ссылка «Открыть Markdown» в chat.html. HTML-просмотр находится в previews/, оригиналы — в attachments/.",
        "Предел просмотра: UTF-8 Markdown до 2 МиБ на файл и суммарно 8 МиБ HTML. При недоступном просмотре оригинал файла сохраняется.",
        "conversation.json содержит видимые сообщения и ссылки на файлы. В attachments/ находятся доступные оригиналы вложений.",
        "manifest.json перечисляет все обнаруженные вложения: путь в ZIP, размер, SHA-256 либо причину отсутствия.",
        "Полнота истории и полнота вложений указаны отдельно. Недоступные, удалённые и слишком большие файлы отмечаются в отчёте.",
        "Сохраняется выбранная текущая ветка. Другие чаты и скрытые инструкции/рассуждения исключены.",
        "Если API предоставил mapping, доступные альтернативные видимые узлы могут присутствовать в conversation.json; дополнительные ветки не запрашиваются через угаданные маршруты.",
        "Ссылки на источники остаются ссылками. Сами внешние сайты не скачиваются. Текст сообщений не переводится.",
        "Пределы памяти браузера: 256 МиБ на вложение, 1,5 ГиБ на ZIP. Более крупные файлы явно указаны в отчёте как отсутствующие.",
      ];
      await writer.add("README.txt", new Blob(["\uFEFF", readme.join("\r\n") + "\r\n"], { type: "text/plain;charset=utf-8" }));
      return { blob: await writer.finish(), archive: status(), manifest };
    }
    return { addAttachment, finish, status, descriptor, manifest };
  }
  globalThis.GoodogArchiveBuilder = Object.freeze({ create, safeName, MAX_FILE_BYTES, MAX_ARCHIVE_BYTES });
})();
