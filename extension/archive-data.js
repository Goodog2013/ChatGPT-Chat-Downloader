/* Whitelisted current-branch archive conversion. No DOM, credentials, network or storage. */
(() => {
  "use strict";
  const VERSION = "3.2.0";
  if (globalThis.GoodogArchiveData?.version === VERSION) return;
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  const array = value => Array.isArray(value) ? value : [];
  const string = value => typeof value === "string" ? value : "";
  const labels = {
    ru: { title: "Разговор ChatGPT", user: "Пользователь", assistant: "ChatGPT", tool: "Инструмент", file: "Файл", image: "Изображение", audio: "Аудио", video: "Видео", unavailable: "Файл недоступен", exported: "Экспорт", scope: "Текущая ветка разговора", complete: "Полная полученная ветка JSON", partial: "Частичная ветка: см. предупреждения", attachments: "Вложения", missing: "Не удалось скачать вложение", unsupported: "Обнаружено вложение без поддерживаемого адреса. В архиве сохранены доступные сведения.", invalidPointer: "Некоторые медиассылки не распознаны. Они не скачивались.", dependency: "Модуль преобразования разговора не загружен.", noConversation: "Не найден JSON разговора.", pages: "JSON содержит только часть страниц разговора; архив может быть неполным.", flat: "Не подтверждены обе границы плоского списка сообщений; полнота архива не установлена.", streaming: "Последний ответ ещё формируется. Сохранён доступный сейчас текст.", noMessages: "В текущей ветке не найдены доступные сообщения.", omitted: "Скрытые инструкции, рассуждения и профиль в архив не включены.", media: "Медиа открывается из локальной папки attachments после распаковки ZIP." },
    en: { title: "ChatGPT conversation", user: "User", assistant: "ChatGPT", tool: "Tool", file: "File", image: "Image", audio: "Audio", video: "Video", unavailable: "File unavailable", exported: "Exported", scope: "Current conversation branch", complete: "Complete received JSON branch", partial: "Partial branch: see warnings", attachments: "Attachments", missing: "Attachment download failed", unsupported: "An attachment has no supported source. Available information was retained in the archive.", invalidPointer: "Some media pointers were not recognized and were not downloaded.", dependency: "Conversation conversion module is not loaded.", noConversation: "Conversation JSON was not found.", pages: "The JSON contains only some conversation pages; the archive may be incomplete.", flat: "Both boundaries of the flat message list were not confirmed; archive completeness is unknown.", streaming: "The final answer is still being generated. The currently available text was saved.", noMessages: "No available messages were found in the current branch.", omitted: "Hidden instructions, reasoning and profile data are excluded.", media: "After extracting the ZIP, media opens from the local attachments folder." }
  };
  const coverageLabels = {
    ru: { history: "Полнота истории", attachments: "Полнота вложений", complete: "полная", partial: "частичная", unknown: "не определена", saved: "сохранено", total: "всего", missing: "недоступно" },
    en: { history: "History coverage", attachments: "Attachment coverage", complete: "complete", partial: "partial", unknown: "unknown", saved: "saved", total: "total", missing: "missing" }
  };
  const languageOf = value => value === "ru" ? "ru" : "en";
  function translate(value, language) {
    for (const key of Object.keys(labels.ru)) if (value === labels.ru[key] || value === labels.en[key]) return labels[languageOf(language)][key];
    const translator = globalThis.GoodogI18n?.translate;
    return typeof translator === "function" ? translator(value, language) : value;
  }
  function safeId(value) { return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,255}$/iu.test(value) ? value : ""; }
  function safeMime(value) { const mime = string(value).split(";", 1)[0].trim().toLowerCase(); return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime) ? mime : ""; }
  function safeRemote(value) {
    if (typeof value !== "string" || value.length > 16384) return "";
    try {
      const url = new URL(value), host = url.hostname.toLowerCase();
      const allowed = ["chatgpt.com", "chat.openai.com", "cdn.oaistatic.com"].includes(host) || host === "oaiusercontent.com" || host.endsWith(".oaiusercontent.com") || host.endsWith(".blob.core.windows.net");
      return url.protocol === "https:" && !url.username && !url.password && !url.port && allowed ? url.href : "";
    } catch { return ""; }
  }
  function conversationUrl(value, id) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && ["chatgpt.com", "chat.openai.com"].includes(url.hostname) && !url.username && !url.password && !url.port && /^(?:\/g\/[^/]+)?\/c\/[a-z0-9-]+\/?$/iu.test(url.pathname)) return `${url.origin}${url.pathname}`;
    } catch { /* Derive a safe URL when the conversation id is available. */ }
    return id ? `https://chatgpt.com/c/${encodeURIComponent(id)}` : "";
  }
  function safeName(value, fallback) {
    let name = string(value).split(/[\\/]/u).at(-1).replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, "_").replace(/^[. ]+|[. ]+$/gu, "");
    name = [...name].slice(0, 160).join("");
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) name = `_${name}`;
    return name || fallback;
  }
  function kindOf(type, mime) {
    for (const kind of ["image", "audio", "video"]) if (mime.startsWith(`${kind}/`) || string(type).toLowerCase().includes(kind)) return kind;
    return "file";
  }
  function timestamp(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const milliseconds = Math.abs(value) < 1e12 ? value * 1000 : value;
    try { return new Date(milliseconds).toISOString(); } catch { return null; }
  }
  function sourceFor(value, conversationId) {
    const raw = string(value), pointer = raw.match(/^(?:file-service|sediment):\/\/([a-z0-9][a-z0-9_-]{0,255})$/iu);
    const id = pointer ? pointer[1] : safeId(raw);
    if (id) return { id, source: { type: "file", value: id, ...(conversationId ? { conversationId } : {}) } };
    const url = safeRemote(raw);
    return url ? { id: "", source: { type: "url", value: url } } : null;
  }
  function proseWithoutCode(value) {
    const lines = value.split("\n"), result = [];
    let fence = "", fenceLength = 0, inlineLength = 0;
    for (const line of lines) {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
      if (fence) {
        if (marker && marker[1][0] === fence && marker[1].length >= fenceLength && !marker[2].trim()) { fence = ""; fenceLength = 0; }
        result.push(""); continue;
      }
      if (marker && !inlineLength) { fence = marker[1][0]; fenceLength = marker[1].length; result.push(""); continue; }
      let prose = "";
      for (let index = 0; index < line.length;) {
        if (line[index] === "`") {
          let end = index + 1; while (line[end] === "`") end++;
          const length = end - index;
          if (!inlineLength) inlineLength = length;
          else if (inlineLength === length) inlineLength = 0;
          prose += " "; index = end;
        } else { if (!inlineLength) prose += line[index]; index++; }
      }
      result.push(prose);
    }
    return result.join("\n");
  }
  function publicText(value, language, sourceUrls) {
    const omitted = language === "en" ? "[temporary attachment URL omitted]" : "[временная ссылка вложения удалена]";
    if (!sourceUrls.size) return string(value);
    return string(value).replace(/https?:\/\/[^\s<>"']+/gu, candidate => {
      // Only attachment sources we already identified are private download URLs.
      // Ordinary user-authored URLs, query strings and source citations remain exact.
      let end = candidate.length;
      while (end > 0) {
        if (sourceUrls.has(candidate.slice(0, end))) return omitted + candidate.slice(end);
        if (!".,;:!?)]}".includes(candidate[end - 1])) break;
        end--;
      }
      return candidate;
    });
  }
  function prepare(raw, meta = {}) {
    const language = languageOf(meta.language), text = labels[language], data = globalThis.GoodogConversationData;
    if (!data?.getConversations || !data.branchMessages || !data.visible || !data.messageText) throw new Error(text.dependency);
    const conversation = data.getConversations(raw)[0];
    if (!conversation) throw new Error(text.noConversation);
    const warnings = new Set(array(meta.warnings).filter(value => typeof value === "string")), structure = new Set();
    const branch = data.branchMessages(conversation, structure);
    for (const warning of structure) warnings.add(translate(warning, language));
    const id = safeId(conversation.conversation_id || conversation.id || meta.id), attachments = [], messages = [], alternatives = [], dedup = new Map();
    const mapping = object(conversation.mapping) ? conversation.mapping : null, nodeByMessage = new Map(), nodeRecords = new Map();
    if (mapping) for (const [nodeId, node] of Object.entries(mapping)) if (object(node?.message)) nodeByMessage.set(node.message, nodeId);
    const branchObjects = new Set(branch), branchIds = new Set(branch.map(message => safeId(message.id)).filter(Boolean));
    const entries = branch.map(message => ({ message, nodeId: nodeByMessage.get(message), current: true }));
    if (mapping) for (const [nodeId, node] of Object.entries(mapping)) if (object(node?.message) && !branchObjects.has(node.message) && !(safeId(node.message.id) && branchIds.has(node.message.id))) entries.push({ message: node.message, nodeId, current: false });
    let coverage = meta.coverage === "partial" || structure.size ? "partial" : "complete";
    const page = conversation.page_info;
    if (page?.has_previous_page === true || page?.has_next_page === true) { coverage = "partial"; warnings.add(text.pages); }
    else if (!object(conversation.mapping) && meta.coverage !== "complete" && (page?.has_previous_page !== false || page?.has_next_page !== false)) { coverage = "partial"; warnings.add(text.flat); }
    function attach(record, details) {
      const mime = safeMime(details.mime), kind = kindOf(details.kind, mime), parsed = details.source || sourceFor(details.value, id);
      if (!parsed) warnings.add(text.unsupported);
      const source = parsed?.source || null, sourceKey = source ? `${source.type}:${source.value}${source.messageId ? `:${source.messageId}` : ""}` : `unsupported:${record.id}:${record.attachments.length}`;
      let attachment = dedup.get(sourceKey);
      if (!attachment) {
        const key = `a${String(attachments.length + 1).padStart(6, "0")}`;
        attachment = { key, id: parsed?.id || "", kind, name: safeName(details.name, `${kind}-${parsed?.id || key}`), mime, source, messageIds: [] };
        attachments.push(attachment); dedup.set(sourceKey, attachment);
      } else {
        if (!attachment.mime && mime) attachment.mime = mime;
        if (attachment.kind === "file" && kind !== "file") attachment.kind = kind;
        if (details.name && attachment.name === `${attachment.kind}-${attachment.id || attachment.key}`) attachment.name = safeName(details.name, attachment.name);
      }
      if (!attachment.messageIds.includes(record.id)) attachment.messageIds.push(record.id);
      if (!record.attachments.includes(attachment.key)) record.attachments.push(attachment.key);
    }
    function media(record, part) {
      if (!object(part)) return;
      const type = string(part.content_type || part.type), mime = safeMime(part.mime_type || part.metadata?.mime_type);
      if (["image_asset_pointer", "audio_asset_pointer", "video_asset_pointer", "file_asset_pointer"].includes(type)) {
        const pointer = string(part.asset_pointer) || string(part.audio_asset_pointer) || string(part.video_asset_pointer) || string(part.file_id);
        if (pointer) attach(record, { value: pointer, kind: type, mime, name: part.name || part.filename || part.metadata?.name });
        else { warnings.add(text.invalidPointer); attach(record, { value: "", kind: type, mime, name: part.name || part.filename }); }
      } else if (type === "real_time_user_audio_video_asset_pointer") {
        if (object(part.audio_asset_pointer)) media(record, part.audio_asset_pointer);
        else if (typeof part.audio_asset_pointer === "string") attach(record, { value: part.audio_asset_pointer, kind: "audio", mime });
        const video = part.video_container_asset_pointer;
        if (typeof video === "string") attach(record, { value: video, kind: "video" });
        else if (object(video) && typeof video.asset_pointer === "string") attach(record, { value: video.asset_pointer, kind: "video", mime: video.mime_type, name: video.name });
        for (const frame of array(part.frames_asset_pointers)) {
          if (typeof frame === "string") attach(record, { value: frame, kind: "image" });
          else if (object(frame) && typeof frame.asset_pointer === "string") attach(record, { value: frame.asset_pointer, kind: "image", mime: frame.mime_type });
        }
      }
    }
    let parentId = null, lastVisible = null;
    const usedMessageIds = new Set();
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index], message = entry.message;
      if (!data.visible(message)) continue;
      const role = message.author?.role || message.role;
      const messageId = safeId(message.id) || safeId(entry.nodeId) || `message-${index + 1}`;
      if (usedMessageIds.has(messageId)) continue;
      const record = { id: messageId, parentId: entry.current ? parentId : null, role, author: role === "tool" ? `${text.tool}${message.author?.name ? `: ${safeName(message.author.name, text.tool)}` : ""}` : text[role] || text.assistant,
        text: data.messageText(message, { includeLinks: meta.includeLinks !== false }, warnings), createdAt: timestamp(message.create_time), attachments: [] };
      for (const attachment of array(message.metadata?.attachments)) {
        if (!object(attachment)) continue;
        attach(record, { value: attachment.id || attachment.file_id || attachment.download_url || attachment.url, name: attachment.name || attachment.filename, mime: attachment.mime_type || attachment.content_type });
      }
      media(record, message.content);
      for (const part of array(message.content?.parts)) media(record, part);
      for (const output of array(message.metadata?.aggregate_result?.messages)) if (output?.message_type === "image") attach(record, { value: output.image_url, kind: "image", mime: output.mime_type, name: output.name });
      // Only Markdown links outside code carry a generated sandbox-file source.
      const prose = proseWithoutCode(record.text);
      for (const match of prose.matchAll(/\[([^\]\n]*)\]\(<?sandbox:(\/mnt\/data\/[^\s<>\u0000-\u001f)]+)>?\)/gu)) {
        let path;
        try { path = decodeURIComponent(match[2]); } catch { path = match[2]; }
        if (!id || !safeId(message.id) || /[\u0000-\u001f\u007f\\]/u.test(path) || /%(?:2e|2f|5c)/iu.test(path) || path.split("/").some(part => part === ".." || part === ".")) { attach(record, { value: "", name: match[1] || path.split("/").at(-1), kind: "file" }); continue; }
        attach(record, { source: { id: "", source: { type: "file", value: `sandbox:${path}`, conversationId: id, messageId: message.id } }, name: match[1] || path.split("/").at(-1), kind: "file" });
      }
      if (!record.text.trim() && !record.attachments.length) continue;
      usedMessageIds.add(record.id);
      if (entry.nodeId) nodeRecords.set(entry.nodeId, record);
      if (entry.current) { messages.push(record); parentId = record.id; lastVisible = message; }
      else alternatives.push({ record, nodeId: entry.nodeId });
    }
    // Keep only exported visible relationships; never include hidden nodes or their metadata.
    for (const alternative of alternatives) {
      const visited = new Set([alternative.nodeId]);
      let parent = mapping[alternative.nodeId]?.parent;
      while (parent) {
        if (visited.has(parent)) { warnings.add(language === "en" ? "Some available alternative-branch relationships contain a cycle and were omitted." : "В связях доступных альтернативных веток обнаружен цикл; часть связей пропущена."); break; }
        visited.add(parent);
        const record = nodeRecords.get(parent);
        if (record) { alternative.record.parentId = record.id; break; }
        const node = mapping[parent];
        if (!node) break;
        parent = node.parent;
      }
    }
    if (!messages.length) throw new Error(text.noMessages);
    if ((lastVisible?.author?.role || lastVisible?.role) === "assistant" && ["in_progress", "streaming", "pending", "queued"].includes(lastVisible.status)) warnings.add(text.streaming);
    return { schemaVersion: 1, language, title: string(conversation.title) || text.title, id, url: conversationUrl(meta.url, id), exportedAt: typeof meta.exportedAt === "string" ? meta.exportedAt : new Date().toISOString(), coverage,
      warnings: [...warnings].map(value => translate(value, language)), scope: "current_branch", branchScope: alternatives.length ? "current_branch_with_available_alternates" : "current_branch", availableAlternatesCount: alternatives.length,
      messages, ...(alternatives.length ? { availableBranches: { nodes: alternatives.map(item => item.record) } } : {}), attachments };
  }
  function publicConversation(descriptor) {
    // Construct explicitly: raw payload metadata and signed source URLs never enter the public JSON.
    const language = languageOf(descriptor.language), sourceUrls = new Set(array(descriptor.attachments).filter(attachment => attachment.source?.type === "url").map(attachment => attachment.source.value));
    const publicMessage = message => ({ id: string(message.id), parentId: typeof message.parentId === "string" ? message.parentId : null, role: ["user", "assistant", "tool"].includes(message.role) ? message.role : "assistant", author: publicText(message.author, language, sourceUrls), text: publicText(message.text, language, sourceUrls), createdAt: typeof message.createdAt === "string" ? message.createdAt : null, attachments: array(message.attachments).filter(value => typeof value === "string") });
    const alternatives = array(descriptor.availableBranches?.nodes);
    return { schemaVersion: 1, language, title: publicText(descriptor.title, language, sourceUrls), id: string(descriptor.id), url: conversationUrl(descriptor.url, safeId(descriptor.id)), exportedAt: string(descriptor.exportedAt), coverage: descriptor.coverage === "complete" ? "complete" : "partial", scope: "current_branch", branchScope: alternatives.length ? "current_branch_with_available_alternates" : "current_branch", availableAlternatesCount: alternatives.length,
      warnings: array(descriptor.warnings).filter(value => typeof value === "string").map(value => publicText(translate(value, language), language, sourceUrls)),
      messages: array(descriptor.messages).map(publicMessage), ...(alternatives.length ? { availableBranches: { nodes: alternatives.map(publicMessage) } } : {}),
      attachments: array(descriptor.attachments).map(attachment => ({ key: string(attachment.key), id: string(attachment.id), kind: ["image", "audio", "video"].includes(attachment.kind) ? attachment.kind : "file", name: string(attachment.name), mime: safeMime(attachment.mime), messageIds: array(attachment.messageIds).filter(value => typeof value === "string") })) };
  }
  const escape = value => String(value ?? "").replace(/[&<>"']/gu, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  function localPath(value, prefix = "attachments/") {
    if (typeof value !== "string" || !value.startsWith(prefix) || /[\\\u0000-\u001f\u007f]/u.test(value)) return "";
    const parts = value.split("/");
    if (parts.some(part => !part || part === "." || part === ".." || /[<>:"|?*]/u.test(part))) return "";
    return parts.map(part => encodeURIComponent(part)).join("/");
  }
  function renderHtml(descriptor, manifest = {}, options = {}) {
    options = object(options) ? options : {};
    const originalAttachments = array(descriptor.attachments);
    descriptor = publicConversation(descriptor);
    const language = languageOf(descriptor.language), text = labels[language], files = new Map();
    const ui = language === "ru" ? {
      conversation: "Сохранённый диалог", local: "Локальный архив", downloads: "Скачать", markdown: "Markdown", json: "Данные JSON", details: "Сведения об архиве", warnings: "Предупреждения", original: "Оригинал файла", openMarkdown: "Открыть Markdown", toStart: "К началу диалога", messages: "сообщений", navigation: "Навигация по архиву"
    } : {
      conversation: "Saved conversation", local: "Local archive", downloads: "Download", markdown: "Markdown", json: "JSON data", details: "Archive details", warnings: "Warnings", original: "Original file", openMarkdown: "Open Markdown", toStart: "Conversation start", messages: "messages", navigation: "Archive navigation"
    };
    const embedded = options.embedded === true;
    function artifactHref(value, fallback) {
      const candidate = value === undefined ? fallback : value;
      if (typeof candidate !== "string" || candidate.length > 4096 || /[%?#]/u.test(candidate)) return "";
      return localPath(candidate.replace(/^\.\//u, ""), "");
    }
    const markdownHref = artifactHref(options.markdownHref, "chat.md"), jsonHref = artifactHref(options.jsonHref, "conversation.json");
    function downloadLinks(className = "archive-links") {
      const links = [markdownHref ? `<a href="${escape(markdownHref)}" download><span aria-hidden="true">↓</span>${escape(ui.markdown)}<small>.md</small></a>` : "", jsonHref ? `<a href="${escape(jsonHref)}" download><span aria-hidden="true">↓</span>${escape(ui.json)}<small>.json</small></a>` : ""].filter(Boolean).join("");
      return links ? `<nav class="${className}" aria-label="${escape(ui.downloads)}">${links}</nav>` : "";
    }
    function displayDate(value) {
      try {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? string(value) : new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en", { dateStyle: "medium", timeStyle: "short" }).format(date);
      } catch { return string(value); }
    }
    function fileSize(value) {
      if (!Number.isSafeInteger(value) || value < 0) return "";
      const units = language === "ru" ? ["Б", "КиБ", "МиБ", "ГиБ"] : ["B", "KiB", "MiB", "GiB"];
      let size = value, unit = 0;
      while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
      return `${new Intl.NumberFormat(language === "ru" ? "ru-RU" : "en", { maximumFractionDigits: unit ? 1 : 0 }).format(size)} ${units[unit]}`;
    }
    const entries = Array.isArray(manifest) ? manifest : array(manifest.files || manifest.attachments);
    for (const file of entries) if (file && typeof file.key === "string") files.set(file.key, file);
    const attachments = new Map(array(descriptor.attachments).map(attachment => [attachment.key, attachment]));
    const markdownSources = new Map(), markdownNames = new Map();
    for (const attachment of originalAttachments) {
      const file = files.get(attachment.key), path = localPath(file?.path);
      if (file?.status !== "saved" || !path) continue;
      const value = { href: path, image: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"].includes(safeMime(file.mime || attachment.mime)) };
      if (attachment.source?.value) markdownSources.set(attachment.source.value, value);
      for (const name of new Set([attachment.name, file.name].filter(Boolean))) {
        if (markdownNames.has(name)) markdownNames.set(name, null);
        else markdownNames.set(name, value);
      }
    }
    const markdown = GoodogMarkdown.createRenderer({ resolveLocal(href) {
      if (markdownSources.has(href)) return markdownSources.get(href);
      let decoded;
      try { decoded = decodeURIComponent(href); } catch { return null; }
      if (markdownSources.has(decoded)) return markdownSources.get(decoded);
      if (/^[a-z][a-z0-9+.-]*:/iu.test(decoded) || decoded.startsWith("//")) return null;
      return markdownNames.get(decoded.replace(/^\.\//u, "")) || null;
    } });
    const coverageText = coverageLabels[language], summary = object(manifest.summary) ? manifest.summary : {};
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const total = count(summary.total) ?? Math.max(attachments.size, files.size);
    const saved = Math.min(total, count(summary.downloaded) ?? count(summary.saved) ?? [...files.values()].filter(file => file.status === "saved" && localPath(file.path)).length);
    const missing = Math.min(total, count(summary.missing) ?? Math.max(0, total - saved));
    const declaredCoverage = manifest.attachmentCoverage || summary.coverage;
    const attachmentCoverage = ["complete", "partial", "unknown"].includes(declaredCoverage) ? declaredCoverage : saved === total ? "complete" : "partial";
    const coverageHeader = `<dl class="coverage-grid"><div><dt>${escape(coverageText.history)}</dt><dd>${escape(descriptor.coverage === "complete" ? text.complete : text.partial)}</dd></div><div><dt>${escape(coverageText.attachments)}</dt><dd><span class="coverage-status ${attachmentCoverage === "complete" ? "is-complete" : "is-partial"}">${escape(coverageText[attachmentCoverage])}</span> · ${escape(coverageText.saved)}: ${saved} / ${total}${missing ? ` · ${escape(coverageText.missing)}: ${missing}` : ""}</dd></div></dl>`;
    function authorLabel(message) {
      if (message.role === "user") return text.user;
      if (message.role === "assistant") return text.assistant;
      if (message.role === "tool") return string(message.author).replace(/^(?:Инструмент|Tool)(?=:|$)/u, text.tool) || text.tool;
      return string(message.author);
    }
    function attachmentHtml(key) {
      const attachment = attachments.get(key); if (!attachment) return "";
      const file = files.get(key), path = localPath(file?.path), failed = file && ["failed", "error", "skipped", "unavailable", "missing"].includes(file.status);
      const name = escape(attachment.name || text.file);
      if (!path || failed) return `<li class="attachment-card is-unavailable"><div class="attachment-heading"><span class="file-mark" aria-hidden="true">↗</span><span class="attachment-name">${name}</span></div><p class="attachment-error">${escape(text.unavailable)}${file?.error ? ` · ${escape(translate(file.error, language))}` : ""}</p></li>`;
      let preview = "";
      const mime = safeMime(file.mime || attachment.mime), kind = kindOf(attachment.kind, mime);
      if (kind === "image" && ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"].includes(mime)) preview = `<div class="media-preview"><img src="${escape(path)}" alt="${name}" loading="lazy" decoding="async"></div>`;
      else if (kind === "audio") preview = `<div class="media-preview"><audio controls preload="none" src="${escape(path)}"></audio></div>`;
      else if (kind === "video") preview = `<div class="media-preview"><video controls preload="none" src="${escape(path)}"></video></div>`;
      const markdownPreview = localPath(file.previewPath, "previews/");
      const openMarkdown = markdownPreview ? `<a class="attachment-preview-link" href="${escape(markdownPreview)}">${escape(ui.openMarkdown)} <span aria-hidden="true">↗</span></a>` : file.previewError ? `<small class="attachment-error">${escape(translate(file.previewError, language))}</small>` : "";
      const size = fileSize(file.bytes);
      return `<li class="attachment-card"><div class="attachment-heading"><span class="file-mark" aria-hidden="true">↓</span><a class="attachment-name" href="${escape(path)}" download>${name}</a>${size ? `<small class="file-size">${escape(size)}</small>` : ""}</div><div class="attachment-caption"><span>${escape(ui.original)}</span>${openMarkdown}</div>${preview}</li>`;
    }
    const warnings = [...array(descriptor.warnings), ...array(manifest.warnings)].filter(value => typeof value === "string").map(warning => translate(warning, language));
    const notes = `<details class="archive-notes${warnings.length ? " has-warnings" : ""}"><summary><span class="note-dot" aria-hidden="true"></span>${escape(warnings.length ? `${ui.warnings} · ${warnings.length}` : ui.details)}<span class="details-chevron" aria-hidden="true">⌄</span></summary><div class="notes-content">${coverageHeader}${warnings.length ? `<ul class="warning-list">${warnings.map(warning => `<li>${escape(warning)}</li>`).join("")}</ul>` : ""}<p class="archive-explanation">${escape(text.omitted)} ${escape(text.media)}</p></div></details>`;
    const body = array(descriptor.messages).map((message, index) => {
      const id = `message-${String(index + 1).padStart(6, "0")}`, role = ["user", "assistant", "tool"].includes(message.role) ? message.role : "assistant";
      return `<article class="chat-message role-${role}" id="${id}" aria-labelledby="author-${id}"><div class="message-shell"><header class="message-header"><span class="role-mark" aria-hidden="true">${role === "assistant" ? "✳" : role === "tool" ? "◇" : ""}</span><span class="author-name" id="author-${id}">${escape(authorLabel(message))}</span><a class="message-number" href="#${id}" aria-label="${escape(authorLabel(message))} ${index + 1}">#${index + 1}</a>${message.createdAt ? `<time datetime="${escape(message.createdAt)}">${escape(displayDate(message.createdAt))}</time>` : ""}</header><div class="message-content">${message.text ? `<div class="message markdown">${markdown(message.text)}</div>` : ""}${message.attachments?.length ? `<ul class="attachments" aria-label="${escape(text.attachments)}">${message.attachments.map(attachmentHtml).join("")}</ul>` : ""}</div></div></article>`;
    }).join("\n");
    const sidebar = embedded ? "" : `<aside class="archive-sidebar" aria-label="${escape(ui.navigation)}"><a class="archive-brand" href="#conversation"><span class="brand-mark" aria-hidden="true">✳</span><span>ChatGPT archive<small>Offline copy · Goodog</small></span></a><div class="sidebar-section-label">${escape(ui.local)}</div><a class="conversation-entry" href="#conversation" title="${escape(descriptor.title)}"><span class="conversation-mark" aria-hidden="true">▤</span><span>${escape(descriptor.title)}</span></a><div class="sidebar-downloads"><div class="sidebar-section-label">${escape(ui.downloads)}</div>${downloadLinks()}</div><p class="sidebar-footnote">${escape(ui.local)}<span>${array(descriptor.messages).length} ${escape(ui.messages)}</span></p></aside>`;
    const heading = embedded ? "" : `<header class="conversation-header"><div class="mobile-brand">ChatGPT archive <span>Offline copy · Goodog</span></div><p class="eyebrow">${escape(ui.conversation)}</p><h1>${escape(descriptor.title)}</h1><p class="conversation-meta">${escape(text.exported)} ${escape(displayDate(descriptor.exportedAt))}<span aria-hidden="true">·</span>${escape(text.scope)}</p>${downloadLinks("mobile-downloads")}${notes}</header>`;
    const embeddedNotes = embedded && (warnings.length || descriptor.coverage !== "complete" || attachmentCoverage !== "complete") ? notes : "";
    const styles = `
:root{color-scheme:light dark;--page:#fff;--sidebar:#f7f7f8;--surface:#f7f7f8;--user:#f1f1f1;--text:#242424;--muted:#727272;--faint:#929292;--border:#e6e6e6;--code:#f7f7f8;--inline:#ececec;--link:#245f9b;--accent:#19806b;--warning:#9a641f;--warning-bg:#fff9ed;--focus:#287cb7}
@media(prefers-color-scheme:dark){:root{--page:#212121;--sidebar:#171717;--surface:#292929;--user:#303030;--text:#ececec;--muted:#a5a5a5;--faint:#838383;--border:#3b3b3b;--code:#171717;--inline:#363636;--link:#9bc2ec;--accent:#86c8b5;--warning:#e2bc7e;--warning-bg:#30291e;--focus:#83b9e6}}
*{box-sizing:border-box}html{scroll-behavior:auto;scroll-padding-top:24px}body{margin:0;background:var(--page);color:var(--text);font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}a{color:var(--link);text-underline-offset:3px}a:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:5px;border-radius:4px}button,input,textarea{font:inherit}.archive-layout{min-height:100vh;margin-left:244px}.archive-main{width:min(100%,900px);margin:0 auto;padding:48px 46px 72px;min-width:0}.archive-sidebar{position:fixed;inset:0 auto 0 0;width:244px;padding:26px 16px;background:var(--sidebar);display:flex;flex-direction:column;border-right:1px solid var(--border);overflow-y:auto}.archive-brand{display:flex;align-items:center;gap:11px;padding:0 7px;color:var(--text);text-decoration:none;font-size:15px;font-weight:650;line-height:1.4}.brand-mark{display:grid;place-items:center;width:32px;height:32px;border:1px solid var(--border);border-radius:10px;font-size:25px;background:var(--page);font-weight:400}.archive-brand small{display:block;font-size:10px;letter-spacing:.015em;color:var(--muted);font-weight:400;margin-top:3px}.sidebar-section-label{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:32px 11px 10px}.conversation-entry{display:flex;align-items:center;gap:10px;padding:10px 11px;border-radius:9px;background:var(--page);border:1px solid var(--border);color:var(--text);text-decoration:none;font-size:13px;line-height:1.5}.conversation-entry>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.conversation-mark{color:var(--muted);font-size:17px}.archive-links{display:grid;gap:3px}.archive-links a,.mobile-downloads a{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--text);font-size:13px;padding:8px 11px;border-radius:8px}.archive-links a:hover,.mobile-downloads a:hover{background:var(--surface)}.archive-links a>span{font-size:17px;color:var(--muted)}.archive-links small,.mobile-downloads small{margin-left:auto;font-size:10px;color:var(--muted)}.sidebar-footnote{margin:auto 11px 0;padding-top:38px;font-size:11px;color:var(--muted);line-height:1.7}.sidebar-footnote span{display:block;color:var(--faint)}.conversation-header{padding:0 0 36px}.eyebrow{margin:0 0 10px;color:var(--muted);font-size:11px;letter-spacing:.09em;text-transform:uppercase;font-weight:600}.conversation-header h1{font-size:clamp(25px,3vw,34px);line-height:1.25;letter-spacing:-.035em;font-weight:650;margin:0 0 16px;overflow-wrap:anywhere}.conversation-meta{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin:0;color:var(--muted);font-size:12px}.mobile-brand,.mobile-downloads{display:none}.archive-notes{margin:22px 0 0;border:1px solid var(--border);border-radius:11px;background:var(--page);font-size:12px;color:var(--muted)}.archive-notes>summary{display:flex;align-items:center;gap:9px;cursor:pointer;list-style:none;padding:11px 14px;font-weight:500}.archive-notes>summary::-webkit-details-marker{display:none}.note-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);flex:none}.has-warnings .note-dot{background:var(--warning)}.has-warnings{border-color:color-mix(in srgb,var(--warning) 27%,var(--border))}.details-chevron{margin-left:auto;font-size:15px;transition:transform .15s}.archive-notes[open] .details-chevron{transform:rotate(180deg)}.notes-content{padding:0 14px 14px;border-top:1px solid var(--border)}.coverage-grid{display:grid;gap:12px;margin:14px 0}.coverage-grid>div{display:grid;grid-template-columns:132px minmax(0,1fr);gap:8px}.coverage-grid dt{color:var(--muted)}.coverage-grid dd{margin:0;color:var(--text)}.coverage-status.is-complete{color:var(--accent)}.coverage-status.is-partial{color:var(--warning)}.warning-list{margin:14px 0;padding:12px 14px 12px 29px;background:var(--warning-bg);border-radius:7px;color:var(--warning)}.warning-list li+li{margin-top:6px}.archive-explanation{margin:12px 0 0;font-size:11px;line-height:1.6;color:var(--muted)}.conversation-thread{display:flex;flex-direction:column;gap:34px}.chat-message{min-width:0;scroll-margin-top:24px;content-visibility:auto;contain-intrinsic-size:auto 230px}.message-shell{min-width:0}.message-header{display:flex;align-items:center;gap:8px;min-height:28px;margin-bottom:10px;color:var(--muted);font-size:11px;line-height:1.5}.author-name{color:var(--text);font-weight:600;font-size:12px}.role-mark{display:grid;place-items:center;flex:none;width:23px;height:23px;border:1px solid var(--border);border-radius:50%;font-size:21px;line-height:1;color:var(--text)}.message-number{color:var(--faint);font-size:10px;text-decoration:none;margin-left:2px}.message-number:hover{text-decoration:underline}.message-header time{margin-left:auto;font-size:10px;color:var(--faint)}.role-user .message-shell{width:fit-content;max-width:85%;margin-left:auto}.role-user .message-header{justify-content:flex-end;gap:7px;margin-bottom:7px}.role-user .role-mark{display:none}.role-user .message-header time{margin-left:5px}.role-user .message-content{background:var(--user);border-radius:23px;padding:15px 21px}.role-user .message-header .author-name{color:var(--muted);font-weight:500;font-size:11px}.role-assistant .message-content{padding:0 0 0 31px}.role-tool .message-content{padding:12px 17px;border-left:2px solid var(--border);background:var(--surface);border-radius:0 10px 10px 0;font-size:14px}.role-tool .role-mark{font-size:16px}.message{min-width:0}.markdown{line-height:1.78;font-size:15px;overflow-wrap:anywhere}.markdown p,.markdown ul,.markdown ol{margin:.9em 0}.markdown h1,.markdown h2,.markdown h3,.markdown h4{letter-spacing:-.02em;color:var(--text);line-height:1.4}.markdown h1{font-size:1.7em}.markdown h2{font-size:1.4em}.markdown h3{font-size:1.16em}.markdown h4{font-size:1.05em}.markdown a{color:var(--link)}.markdown blockquote{margin:1.2em 0;padding:.1em 0 .1em 16px;border-left:3px solid var(--border);background:transparent;color:var(--muted)}.markdown pre{margin:18px 0;padding:18px 20px;border:1px solid var(--border);border-radius:12px;background:var(--code);color:var(--text);font-size:13px;line-height:1.65;max-width:100%;overflow-x:auto;tab-size:4;white-space:pre}.markdown code{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:.88em}.markdown pre code{font-size:1em;background:transparent;padding:0}.markdown :not(pre)>code{background:var(--inline);padding:.15em .38em;border-radius:5px;box-decoration-break:clone}.markdown pre.literal{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;background:transparent;border:0;padding:0}.markdown table{display:block;max-width:100%;overflow-x:auto;border:1px solid var(--border);border-radius:10px;border-collapse:separate;border-spacing:0;margin:20px 0;font-size:13px;line-height:1.55}.markdown th,.markdown td{border:0;border-bottom:1px solid var(--border);padding:10px 14px;text-align:left;vertical-align:top;min-width:105px}.markdown th{background:var(--surface);font-weight:600}.markdown tr:last-child td{border-bottom:0}.markdown hr{border:0;border-top:1px solid var(--border);margin:28px 0}.markdown img{display:block;width:auto;height:auto;max-width:100%;max-height:760px;object-fit:contain;border-radius:12px;margin:18px 0}.markdown input[type=checkbox]{accent-color:var(--accent)}.attachments{list-style:none;display:grid;gap:12px;margin:16px 0 0;padding:0}.attachment-card{min-width:0;border:1px solid var(--border);border-radius:12px;padding:13px 15px;background:var(--page)}.attachment-heading{display:flex;align-items:center;gap:10px;min-width:0}.file-mark{width:27px;height:31px;display:grid;place-items:center;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:16px;color:var(--muted);flex:none}.attachment-name{font-size:13px;font-weight:550;line-height:1.5;text-decoration:none;overflow-wrap:anywhere;color:var(--text)}a.attachment-name:hover{text-decoration:underline}.file-size{font-size:10px;color:var(--muted);margin-left:auto;white-space:nowrap}.attachment-caption{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px 12px;margin:5px 0 0 37px;font-size:10px;color:var(--muted)}.attachment-preview-link{font-size:11px;text-decoration:none}.attachment-preview-link:hover{text-decoration:underline}.attachment-error{font-size:11px;color:var(--warning);line-height:1.6;margin:7px 0 0 37px}.attachment-caption .attachment-error{margin:0}.is-unavailable{background:var(--warning-bg);border-color:color-mix(in srgb,var(--warning) 25%,var(--border))}.media-preview{margin-top:13px}.media-preview img,.media-preview video{display:block;width:auto;max-width:100%;max-height:760px;object-fit:contain;border-radius:9px}.media-preview audio{display:block;width:100%;max-width:480px;height:40px}.archive-end{width:32px;height:3px;border-radius:10px;background:var(--border);margin:52px auto 0}.is-embedded .archive-layout{margin-left:0;min-height:0}.is-embedded .archive-main{padding:24px 34px 44px}.is-embedded .archive-notes{margin:0 0 28px}.is-embedded .conversation-thread{gap:30px}
@media(min-width:1500px){.archive-main{width:960px;padding-left:60px;padding-right:60px}}@media(max-width:1000px){.archive-layout{margin-left:210px}.archive-sidebar{width:210px;padding:24px 12px}.archive-main{padding:38px 28px 60px}.archive-brand{font-size:13px;gap:8px}.archive-brand small{font-size:9px}.role-user .message-shell{max-width:90%}}
@media(max-width:760px){.archive-sidebar{display:none}.archive-layout{margin-left:0}.archive-main{padding:24px 22px 50px}.conversation-header{padding-bottom:30px}.mobile-brand{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:12px;font-weight:650;margin:0 0 33px}.mobile-brand span{font-size:10px;color:var(--muted);font-weight:400}.conversation-header h1{font-size:27px}.eyebrow{font-size:10px}.conversation-meta{font-size:11px}.mobile-downloads{display:flex;gap:6px;margin:15px 0 0}.mobile-downloads a{border:1px solid var(--border);font-size:11px;padding:6px 10px;gap:7px}.mobile-downloads small{font-size:9px}.conversation-thread{gap:29px}.role-user .message-shell{max-width:92%}.role-user .message-content{padding:13px 17px;border-radius:21px}.role-assistant .message-content{padding-left:0}.message-header{margin-bottom:9px}.markdown{font-size:14px;line-height:1.8}.markdown pre{font-size:12px;padding:14px 15px;border-radius:10px}.markdown th,.markdown td{font-size:12px;padding:8px 11px}.message-header time{font-size:9px}.role-user .message-header time{display:none}.is-embedded .archive-main{padding:18px 21px 36px}.coverage-grid>div{grid-template-columns:1fr;gap:2px}.attachment-card{padding:11px 12px}.attachment-caption{margin-left:0;margin-top:8px}.attachment-error{margin-left:0}.file-size{font-size:9px}}
@media(max-width:420px){.archive-main{padding-left:16px;padding-right:16px}.mobile-brand{font-size:11px}.mobile-brand span{font-size:9px}.conversation-header h1{font-size:24px}.role-user .message-shell{max-width:96%}.is-embedded .archive-main{padding-left:15px;padding-right:15px}.attachment-heading{flex-wrap:wrap}.file-size{margin-left:37px;width:calc(100% - 37px)}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}@media print{:root{color-scheme:light;--page:#fff;--text:#111;--muted:#555;--border:#ddd;--user:#f4f4f4;--code:#f6f6f6;--surface:#f6f6f6;--inline:#eee;--link:#111}.archive-sidebar,.mobile-brand,.mobile-downloads,.archive-end{display:none}.archive-layout{margin:0}.archive-main,.is-embedded .archive-main{width:100%;max-width:none;padding:0}.chat-message{content-visibility:visible;contain-intrinsic-size:none}.conversation-header{padding-bottom:22px}.conversation-thread{gap:22px}.markdown pre{white-space:pre-wrap;overflow-wrap:anywhere}.message-header time{color:#555}}
`;
    return `<!doctype html>\n<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; media-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark"><title>${escape(descriptor.title)} · ChatGPT archive</title><style>${GoodogMarkdown.styles}${styles}</style></head><body class="${embedded ? "is-embedded" : "is-standalone"}">${sidebar}<div class="archive-layout"><main class="archive-main" id="conversation">${heading}${embeddedNotes}<section class="conversation-thread" aria-label="${escape(ui.conversation)}">${body}</section><div class="archive-end" aria-hidden="true"></div></main></div></body></html>\n`;
  }
  globalThis.GoodogArchiveData = Object.freeze({ version: VERSION, prepare, publicConversation, renderHtml });
})();
