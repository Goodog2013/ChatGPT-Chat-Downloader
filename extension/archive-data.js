/* Whitelisted current-branch archive conversion. No DOM, credentials, network or storage. */
(() => {
  "use strict";
  const VERSION = "3.0.0";
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
  function localPath(value) {
    if (typeof value !== "string" || !value.startsWith("attachments/") || /[\\\u0000-\u001f\u007f]/u.test(value)) return "";
    const parts = value.split("/");
    if (parts.some(part => !part || part === "." || part === ".." || /[<>:"|?*]/u.test(part))) return "";
    return parts.map(part => encodeURIComponent(part)).join("/");
  }
  function renderHtml(descriptor, manifest = {}) {
    descriptor = publicConversation(descriptor);
    const language = languageOf(descriptor.language), text = labels[language], files = new Map();
    const entries = Array.isArray(manifest) ? manifest : array(manifest.files || manifest.attachments);
    for (const file of entries) if (file && typeof file.key === "string") files.set(file.key, file);
    const attachments = new Map(array(descriptor.attachments).map(attachment => [attachment.key, attachment]));
    const coverageText = coverageLabels[language], summary = object(manifest.summary) ? manifest.summary : {};
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const total = count(summary.total) ?? Math.max(attachments.size, files.size);
    const saved = Math.min(total, count(summary.downloaded) ?? count(summary.saved) ?? [...files.values()].filter(file => file.status === "saved" && localPath(file.path)).length);
    const missing = Math.min(total, count(summary.missing) ?? Math.max(0, total - saved));
    const declaredCoverage = manifest.attachmentCoverage || summary.coverage;
    const attachmentCoverage = ["complete", "partial", "unknown"].includes(declaredCoverage) ? declaredCoverage : saved === total ? "complete" : "partial";
    const coverageHeader = `<p class="meta">${escape(coverageText.history)}: ${escape(descriptor.coverage === "complete" ? text.complete : text.partial)}<br>${escape(coverageText.attachments)}: ${escape(coverageText[attachmentCoverage])} · ${escape(coverageText.saved)}: ${saved} · ${escape(coverageText.total)}: ${total} · ${escape(coverageText.missing)}: ${missing}</p>`;
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
      if (!path || failed) return `<li class="unavailable">${name} — ${escape(text.unavailable)}${file?.error ? `: ${escape(translate(file.error, language))}` : ""}</li>`;
      let preview = "";
      const mime = safeMime(file.mime || attachment.mime), kind = kindOf(attachment.kind, mime);
      if (kind === "image" && ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"].includes(mime)) preview = `<img src="${escape(path)}" alt="${name}" loading="lazy">`;
      else if (kind === "audio") preview = `<audio controls preload="none" src="${escape(path)}"></audio>`;
      else if (kind === "video") preview = `<video controls preload="none" src="${escape(path)}"></video>`;
      return `<li><a href="${escape(path)}" download>${name}</a>${preview}</li>`;
    }
    const warnings = [...array(descriptor.warnings), ...array(manifest.warnings)].filter(value => typeof value === "string").map(warning => translate(warning, language));
    const body = array(descriptor.messages).map((message, index) => `<article><header><b>${index + 1}. ${escape(authorLabel(message))}</b>${message.createdAt ? `<time>${escape(message.createdAt)}</time>` : ""}</header>${message.text ? `<pre class="message">${escape(message.text)}</pre>` : ""}${message.attachments?.length ? `<ul class="attachments">${message.attachments.map(attachmentHtml).join("")}</ul>` : ""}</article>`).join("\n");
    return `<!doctype html>\n<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; media-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>${escape(descriptor.title)}</title><style>body{max-width:1000px;margin:40px auto;padding:0 20px;background:#fafafa;color:#20242b;font:16px/1.55 system-ui,sans-serif}h1{overflow-wrap:anywhere}article{background:white;border:1px solid #dce0e6;border-radius:12px;margin:22px 0;padding:20px}header{display:flex;gap:12px;justify-content:space-between;flex-wrap:wrap}time,.meta{color:#5d6570;font-size:13px}.message{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:18px 0 0}.attachments{padding-left:20px}.attachments li{margin:14px 0;overflow-wrap:anywhere}img,video{display:block;max-width:100%;max-height:700px;margin-top:12px}audio{display:block;max-width:100%;margin-top:12px}.warning,.unavailable{color:#8a4300}a{color:#1858a8}</style></head><body><h1>${escape(descriptor.title)}</h1><p class="meta">${escape(text.exported)}: ${escape(descriptor.exportedAt)} · ${escape(text.scope)}</p>${coverageHeader}<p class="meta">${escape(text.omitted)} ${escape(text.media)}</p>${warnings.length ? `<ul class="warning">${warnings.map(warning => `<li>${escape(warning)}</li>`).join("")}</ul>` : ""}${body}</body></html>\n`;
  }
  globalThis.GoodogArchiveData = Object.freeze({ version: VERSION, prepare, publicConversation, renderHtml });
})();
