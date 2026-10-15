/* Local conversation-data conversion. No DOM, credentials, network or storage. */
(() => {
  "use strict";
  const VERSION = "3.2.0";
  if (globalThis.GoodogConversationData?.version === VERSION) return;
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  const array = value => Array.isArray(value) ? value : [];
  const isConversation = value => object(value) && (object(value.mapping) || Array.isArray(value.messages));
  function getConversations(value) {
    if (isConversation(value)) return [value];
    if (Array.isArray(value)) return value.filter(isConversation);
    for (const key of ["conversations", "conversation", "data"]) {
      if (Array.isArray(value?.[key])) return value[key].filter(isConversation);
      if (isConversation(value?.[key])) return [value[key]];
    }
    return [];
  }

  function branchMessages(conversation, warnings) {
    if (!object(conversation.mapping)) {
      const seen = new Map(), ordered = [];
      for (const entry of conversation.messages || []) {
        const message = entry?.message && !entry.author ? entry.message : entry;
        if (!object(message)) continue;
        if (message.id && seen.has(message.id)) { ordered[seen.get(message.id)] = message; continue; }
        if (message.id) seen.set(message.id, ordered.length);
        ordered.push(message);
      }
      return ordered;
    }
    const nodes = new Map(Object.entries(conversation.mapping));
    if (!nodes.size) return [];
    let tip = conversation.current_node || conversation.currentNode;
    if (tip && !nodes.has(tip)) throw new Error("JSON не содержит текущий узел разговора. Нужна полная выгрузка этого чата.");
    if (!tip) {
      const leaves = [...nodes.entries()].filter(([, node]) => !Array.isArray(node?.children) || node.children.length === 0);
      leaves.sort((a, b) => Number(b[1]?.message?.create_time || b[1]?.message?.update_time || 0) - Number(a[1]?.message?.create_time || a[1]?.message?.update_time || 0));
      tip = leaves[0]?.[0];
      if (!tip) throw new Error("В JSON не найдена конечная точка ветки.");
      if (leaves.length > 1) warnings.add("В JSON не указан current_node. Выбрана самая поздняя конечная ветка; выбор ветки нужно проверить.");
    }
    const visited = new Set(), reversed = [];
    while (tip) {
      if (visited.has(tip)) { warnings.add("Связи родительских сообщений содержат цикл. Ветка восстановлена частично."); break; }
      visited.add(tip);
      const node = nodes.get(tip);
      if (!node) { warnings.add("В JSON отсутствует родитель одного из сообщений. Начало ветки может быть неполным."); break; }
      if (object(node.message)) reversed.push(node.message);
      if (!Object.hasOwn(node, "parent")) { warnings.add("У узла JSON отсутствует поле parent. Полнота начала ветки не подтверждена."); break; }
      tip = node.parent;
    }
    return reversed.reverse();
  }

  const HIDDEN_TYPES = new Set(["thoughts", "reasoning_recap", "user_editable_context", "model_editable_context", "system_editable_context"]);
  function visible(message) {
    const role = message?.author?.role || message?.role;
    const type = message?.content?.content_type || message?.content?.type;
    return ["user", "assistant", "tool"].includes(role) && message?.metadata?.is_visually_hidden_from_conversation !== true &&
      !["analysis", "justify", "confidence", "notification"].includes(message.channel || message.metadata?.channel) && !HIDDEN_TYPES.has(type);
  }

  function listConversations(data) {
    return getConversations(data).map((conversation, index) => {
      const warnings = new Set();
      let messageCount = 0;
      try { messageCount = branchMessages(conversation, warnings).filter(visible).length; } catch { /* The export action will report the detailed error. */ }
      return { index, id: String(conversation.conversation_id || conversation.id || ""), title: String(conversation.title || `Чат ${index + 1}`), messageCount };
    });
  }

  function safeUrl(value) {
    if (typeof value !== "string") return "";
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : ""; }
    catch { return ""; }
  }

  function stringText(value) {
    if (typeof value === "string") return value;
    if (object(value) && typeof value.value === "string") return value.value;
    return "";
  }

  function partText(part, depth = 0) {
    if (typeof part === "string") return part;
    if (!object(part) || depth > 12) return "";
    const type = String(part.content_type || part.type || "");
    if (HIDDEN_TYPES.has(type)) return "";
    const text = stringText(part.text) || stringText(part.transcription) || stringText(part.transcript) || stringText(part.caption);
    if (text) return text;
    if (Array.isArray(part.parts)) return part.parts.map(item => partText(item, depth + 1)).filter(Boolean).join("\n");
    if (["text", "input_text", "output_text"].includes(type)) return stringText(part.content);
    // This is a text export. Media pointers, file names and binary placeholders are expected omissions.
    return "";
  }

  function messageText(message, options, warnings) {
    const content = message.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content?.parts)) text = content.parts.map(part => partText(part)).filter(Boolean).join("\n");
    else if (object(content)) text = stringText(content.text) || stringText(content.content) || stringText(content.summary) || stringText(content.result);
    if (!text && Array.isArray(message.parts)) text = message.parts.map(part => partText(part)).filter(Boolean).join("\n");
    text = text.replace(/\r\n?/gu, "\n");
    if (content?.content_type === "code" && text) {
      let ticks = 3;
      for (const match of text.matchAll(/`+/gu)) ticks = Math.max(ticks, match[0].length + 1);
      const fence = "`".repeat(ticks);
      const language = /^[a-z0-9_+#.-]{1,40}$/iu.test(content.language || "") ? content.language : "";
      text = `${fence}${language}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
    }
    for (const reference of array(message.metadata?.content_references)) {
      const matched = reference?.matched_text;
      // Never replace ordinary text/whitespace: only renderer-specific citation tokens.
      if (typeof matched !== "string" || !/[\ue000-\uf8ff]/u.test(matched) || !text.includes(matched)) continue;
      let replacement = stringText(reference.alt);
      if (replacement && !options.includeLinks) replacement = replacement.replace(/\[([^\]]*)\]\(https?:\/\/[^)]+\)/gu, "$1");
      if (!replacement) {
        const href = safeUrl(reference.url || reference.href);
        const label = String(reference.title || "Источник");
        replacement = options.includeLinks && href ? `${label} (${href})` : `[${label}]`;
      }
      text = text.split(matched).join(replacement);
    }
    if (/[\ue200-\ue203]/u.test(text)) {
      warnings.add("Для части служебных ссылок ChatGPT не предоставлены текстовые адреса источников.");
      text = text.replace(/\ue200[^\ue201]*\ue201/gu, "[ссылка ChatGPT без доступного адреса]");
    }
    return text;
  }

  function exportConversation(raw, options = {}) {
    const conversation = getConversations(raw)[0];
    if (!conversation) throw new Error("Файл не содержит conversation mapping или messages. Выберите conversations.json из экспорта ChatGPT.");
    const warnings = new Set((options.warnings || []).filter(item => typeof item === "string"));
    const structuralWarnings = new Set();
    const messages = branchMessages(conversation, structuralWarnings);
    for (const warning of structuralWarnings) warnings.add(warning);
    let coverage = options.coverage === "partial" || structuralWarnings.size ? "partial" : "complete";
    const page = conversation.page_info;
    if (page?.has_previous_page === true || page?.has_next_page === true) {
      coverage = "partial"; warnings.add("JSON содержит только часть страниц разговора. Полная история ещё не загружена.");
    } else if (!object(conversation.mapping) && options.coverage !== "complete" && (page?.has_previous_page !== false || page?.has_next_page !== false)) {
      coverage = "partial"; warnings.add("У плоского списка сообщений не подтверждены обе границы пагинации; полнота не установлена.");
    }
    const records = [];
    const stats = { visibleMessages: 0, textMessages: 0, nonTextMessages: 0, unfinishedMessages: 0 };
    let lastVisibleMessage = null;
    for (const message of messages) {
      if (!visible(message)) continue;
      stats.visibleMessages++;
      lastVisibleMessage = message;
      const text = messageText(message, { includeLinks: options.includeLinks !== false }, warnings);
      if (!text.trim()) { stats.nonTextMessages++; continue; }
      const role = message.author?.role || message.role;
      const author = role === "user" ? "Пользователь" : role === "assistant" ? "ChatGPT" : `Инструмент${message.author?.name ? `: ${message.author.name}` : ""}`;
      records.push({ author, role, text });
      if (role === "assistant" && message.status && !["finished_successfully", "complete", "completed"].includes(message.status)) stats.unfinishedMessages++;
    }
    stats.textMessages = records.length;
    // A stopped historical answer still has its complete available text. Its status is not a missing history page.
    if ((lastVisibleMessage?.author?.role || lastVisibleMessage?.role) === "assistant" &&
        ["in_progress", "streaming", "pending", "queued"].includes(lastVisibleMessage.status)) {
      warnings.add("Последний ответ ещё формируется. Сохранён доступный сейчас текст; после окончания ответа можно повторить экспорт.");
    }
    if (!records.length && !options.allowEmpty) throw new Error("В JSON не найдены текстовые сообщения текущей ветки.");
    const title = String(conversation.title || "Разговор ChatGPT");
    const id = String(conversation.conversation_id || conversation.id || "");
    const date = options.exportedAt || new Date().toISOString();
    const url = safeUrl(options.url) || (/^[a-zA-Z0-9-]+$/u.test(id) ? `https://chatgpt.com/c/${id}` : "");
    const translate = value => globalThis.GoodogI18n?.translate(value, options.language) || value;
    const metadataText = value => String(value).replace(/\r?\n/gu, " ").replace(/[\\`*_{}\[\]()#+.!<>|~-]/gu, "\\$&");
    const lines = [`# ${metadataText(title)}`, "", `> Goodog Chat Export ${VERSION} · Markdown`, "",
      ...(url ? [`- URL: <${url}>`] : []), `- ${translate("Экспорт:")} ${metadataText(date)}`, `- ${translate("Текстовых сообщений:")} ${records.length}`,
      `- ${translate("Источник:")} ${metadataText(translate(object(conversation.mapping) ? "JSON разговора · текущая ветка по parent/current_node" : "JSON разговора · последовательность messages"))}`,
      `- ${translate("Охват:")} ${metadataText(translate(coverage === "complete" ? "полная полученная ветка JSON" : "частичный — см. предупреждения"))}`, "",
      translate("Сохранён весь доступный текст сообщений, включая прерванные ответы. Код, Markdown и текстовые подписи сохранены."),
      `${translate("Сообщений без доступного текста пропущено:")} ${stats.nonTextMessages}. ${translate("Изображения и вложения не скачиваются; заглушки файлов не добавляются.")}`,
      translate("Другие ветки и скрытые инструкции/рассуждения в MD не включаются."),
      ...[...warnings].map(warning => `> **${translate("Предупреждение:")}** ${metadataText(translate(warning))}`), "", "---", ""];
    function messageMarkdown(text) {
      // A stopped answer can end inside a code fence. Close that fence so the
      // following message heading is not swallowed; the message bytes stay intact.
      let open = null;
      for (const match of text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/gm)) {
        const fence = match[1], tail = match[2];
        if (!open) {
          if (fence[0] === "`" && tail.includes("`")) continue;
          open = fence;
        } else if (fence[0] === open[0] && fence.length >= open.length && !tail.trim()) open = null;
      }
      return open ? `${text}\n${open}` : text;
    }
    const body = records.map((record, index) => `## ${index + 1}. ${metadataText(record.role === "user" ? translate("Пользователь") : record.role === "assistant" ? "ChatGPT" : record.author.replace(/^Инструмент/u, translate("Инструмент")))}\n\n${messageMarkdown(record.text)}`).join("\n\n---\n\n");
    const safeTitle = [...title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, "_")].slice(0, 100).join("").replace(/[. ]+$/gu, "") || "Conversation";
    return { filename: `ChatGPT-${safeTitle}-${date.replace(/[:.]/gu, "-")}.md`, text: lines.join("\n") + body + "\n", count: records.length, warnings: [...warnings], coverage, stats };
  }

  globalThis.GoodogConversationData = Object.freeze({ version: VERSION, getConversations, listConversations, exportConversation, branchMessages, visible, messageText, safeUrl });
})();
