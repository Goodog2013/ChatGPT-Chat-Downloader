/* Offline library shell. Chat documents are local, independently loaded HTML. */
(() => {
  "use strict";
  const escape = value => String(value ?? "").replace(/[&<>"']/gu, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const json = value => JSON.stringify(value).replace(/</gu, "\\u003c").replace(/&/gu, "\\u0026").replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029");
  const labels = {
    en: { title: "ChatGPT · Your archive", archive: "Archive", heading: "Your conversations", search: "Search by title", empty: "No conversations found", more: "Show more", chats: "conversations", messages: "messages", readonly: "Offline · Read only", open: "Open conversation", menu: "Toggle conversations", partial: "Partial history", report: "Export report", intro: "Choose a conversation to read your saved messages.", unavailable: "This conversation could not be converted. See the export report.", noscript: "Enable JavaScript for search and conversation switching, or open the HTML files in the chats folder." },
    ru: { title: "ChatGPT · Ваш архив", archive: "Архив", heading: "Ваши переписки", search: "Поиск по названию", empty: "Переписки не найдены", more: "Показать ещё", chats: "переписок", messages: "сообщений", readonly: "Офлайн · Только чтение", open: "Открыть переписку", menu: "Показать переписки", partial: "История неполная", report: "Отчёт экспорта", intro: "Выберите переписку для чтения сохранённых сообщений.", unavailable: "Эту переписку не удалось преобразовать. Подробности — в отчёте экспорта.", noscript: "Включите JavaScript для поиска и переключения переписок либо откройте HTML-файлы в папке chats." },
  };
  function client() {
    "use strict";
    const data = JSON.parse(document.getElementById("archive-data").textContent);
    const rows = data.rows, text = data.labels, list = document.getElementById("conversations");
    const search = document.getElementById("search"), frame = document.getElementById("conversation");
    const more = document.getElementById("more"), heading = document.getElementById("chat-title");
    const meta = document.getElementById("chat-meta"), open = document.getElementById("open-chat");
    let selected = -1, limit = 100;
    function show(index, updateHash = true) {
      if (!Number.isInteger(index) || !rows[index] || !/^chats\/\d+\/chat\.html$/u.test(rows[index].path)) return;
      selected = index;
      const row = rows[index];
      frame.src = row.path; frame.title = row.title;
      heading.textContent = row.title;
      meta.textContent = `${row.messageCount.toLocaleString()} ${text.messages}${row.coverage === "partial" ? ` · ${text.partial}` : ""}`;
      open.href = row.path;
      if (updateHash) history.replaceState(null, "", `#chat-${index + 1}`);
      document.title = `${row.title} · ChatGPT archive`;
      document.body.classList.remove("mobile-sidebar");
      for (const button of list.querySelectorAll("button[data-index]")) button.setAttribute("aria-current", String(Number(button.dataset.index) === selected));
    }
    function render() {
      const query = search.value.trim().toLocaleLowerCase();
      const matches = rows.map((row, index) => ({ row, index })).filter(({ row }) => !query || row.title.toLocaleLowerCase().includes(query));
      const fragment = document.createDocumentFragment();
      for (const { row, index } of matches.slice(0, limit)) {
        const button = document.createElement("button"), title = document.createElement("span"), subtitle = document.createElement("small");
        button.type = "button"; button.dataset.index = String(index); button.className = "chat-link";
        button.setAttribute("aria-current", String(index === selected)); title.textContent = row.title;
        let date = "";
        if (row.updatedAt && Number.isFinite(Date.parse(row.updatedAt))) date = new Intl.DateTimeFormat(data.language, { dateStyle: "medium" }).format(new Date(row.updatedAt));
        subtitle.textContent = `${date ? `${date} · ` : ""}${row.messageCount.toLocaleString()} ${text.messages}${row.coverage === "partial" ? " · !" : ""}`;
        button.append(title, subtitle); button.addEventListener("click", () => show(index)); fragment.append(button);
      }
      if (!matches.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = text.empty; fragment.append(empty); }
      list.replaceChildren(fragment); more.hidden = matches.length <= limit;
      document.getElementById("found").textContent = `${matches.length.toLocaleString()} ${text.chats}`;
    }
    search.addEventListener("input", () => { limit = 100; render(); });
    more.addEventListener("click", () => { limit += 100; render(); });
    document.getElementById("menu").addEventListener("click", () => {
      if (matchMedia("(max-width: 760px)").matches) document.body.classList.toggle("mobile-sidebar");
      else document.body.classList.toggle("sidebar-hidden");
    });
    document.getElementById("veil").addEventListener("click", () => document.body.classList.remove("mobile-sidebar"));
    const fromHash = () => {
      const match = location.hash.match(/^#chat-(\d+)$/u), index = match ? Number(match[1]) - 1 : 0;
      show(index >= 0 && index < rows.length ? index : 0, false);
    };
    window.addEventListener("hashchange", fromHash);
    fromHash(); render();
  }
  async function indexHtml(rows, options = {}) {
    const language = options.language === "ru" ? "ru" : "en", text = labels[language];
    const script = `(${client.toString()})();`;
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script)));
    let binary = ""; for (const byte of hash) binary += String.fromCharCode(byte);
    const digest = btoa(binary);
    const first = rows[0];
    const css = `:root{color-scheme:light dark;--bg:#fff;--panel:#f9f9f9;--text:#171717;--muted:#737373;--line:#e9e9e9;--hover:#ececec;--selected:#e3e3e3}*{box-sizing:border-box}body{margin:0;color:var(--text);background:var(--bg);font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;grid-template-columns:278px minmax(0,1fr);height:100dvh;overflow:hidden}button,input{font:inherit}button,a{-webkit-tap-highlight-color:transparent}a{color:inherit}button{color:inherit;cursor:pointer}.sidebar{background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0;padding:22px 12px 12px}.logo{display:flex;align-items:center;gap:10px;padding:0 12px 24px;font-size:19px;font-weight:650;letter-spacing:-.5px}.logo svg{width:25px;height:25px}.logo small{font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-left:auto}.side-heading{padding:0 12px;color:var(--muted);font-size:12px;font-weight:600}.search-wrap{padding:9px 5px 12px}#search{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:11px;padding:11px 12px;color:var(--text);outline:none}#search:focus{border-color:var(--muted)}#found{margin:0;padding:0 12px 10px;color:var(--muted);font-size:11px}.chat-list{overflow:auto;min-height:0;flex:1;scrollbar-width:thin}.chat-link{display:block;width:100%;border:0;background:transparent;text-align:left;border-radius:10px;padding:11px 12px;margin:1px 0}.chat-link:hover{background:var(--hover)}.chat-link[aria-current=true]{background:var(--selected)}.chat-link span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}.chat-link small{display:block;color:var(--muted);font-size:11px;margin-top:3px}.side-foot{border-top:1px solid var(--line);padding:15px 12px 2px;margin-top:12px;color:var(--muted);font-size:11px;display:flex;gap:10px;justify-content:space-between}.side-foot a{text-decoration:none}.side-foot a:hover{text-decoration:underline}#more{border:1px solid var(--line);background:var(--bg);padding:9px;margin-top:8px;border-radius:8px}main{display:flex;min-width:0;flex-direction:column;min-height:0}.topbar{display:flex;align-items:center;gap:15px;min-height:78px;padding:16px 24px;border-bottom:1px solid var(--line)}#menu{border:0;background:transparent;width:34px;height:34px;border-radius:8px;font-size:22px}#menu:hover{background:var(--hover)}.title-wrap{min-width:0;flex:1}.title-wrap h1{font-size:17px;font-weight:600;margin:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.title-wrap p{margin:3px 0 0;color:var(--muted);font-size:11px}#open-chat{font-size:12px;color:var(--muted);text-decoration:none;white-space:nowrap;padding:8px 11px;border:1px solid var(--line);border-radius:9px}#open-chat:hover{color:var(--text);background:var(--hover)}iframe{display:block;border:0;background:var(--bg);width:100%;flex:1;min-height:0}.empty{padding:16px;color:var(--muted);font-size:12px}#veil{display:none}.sidebar-hidden{grid-template-columns:minmax(0,1fr)}.sidebar-hidden .sidebar{display:none}[hidden]{display:none!important}noscript{position:fixed;bottom:10px;left:20px;right:20px;padding:12px;border:1px solid var(--line);background:var(--panel)}@media(prefers-color-scheme:dark){:root{--bg:#212121;--panel:#171717;--text:#ececec;--muted:#a1a1a1;--line:#333;--hover:#252525;--selected:#303030}}@media(max-width:760px){body{grid-template-columns:minmax(0,1fr)}.sidebar{position:fixed;inset:0 auto 0 0;width:min(310px,86vw);z-index:3;display:none;box-shadow:20px 0 80px #0004}.mobile-sidebar .sidebar{display:flex}.mobile-sidebar #veil{display:block;position:fixed;inset:0;z-index:2;border:0;background:#0007}.topbar{min-height:72px;padding:12px}#open-chat{font-size:0;padding:7px}#open-chat:after{content:'↗';font-size:18px}}`;
    return `<!doctype html>\n<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${digest}'; style-src 'unsafe-inline'; frame-src 'self' file:; base-uri 'none'; form-action 'none'; object-src 'none'"><title>${escape(text.title)}</title><style>${css}</style></head><body><button id="veil" type="button" aria-label="${escape(text.menu)}"></button><aside class="sidebar"><div class="logo"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 4h10a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4H8l-5 3V8a4 4 0 0 1 4-4Z" stroke="currentColor" stroke-width="1.7"/><path d="M8 9h8M8 13h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>ChatGPT<small>${escape(text.archive)}</small></div><div class="side-heading">${escape(text.heading)}</div><div class="search-wrap"><input id="search" type="search" placeholder="${escape(text.search)}" aria-label="${escape(text.search)}" autocomplete="off"></div><p id="found">${rows.length} ${escape(text.chats)}</p><nav class="chat-list" id="conversations" aria-label="${escape(text.heading)}"></nav><button type="button" id="more" hidden>${escape(text.more)}</button><footer class="side-foot"><span>Goodog · ${escape(text.readonly)}</span><a href="manifest.json" download>${escape(text.report)}</a></footer></aside><main><header class="topbar"><button id="menu" type="button" aria-label="${escape(text.menu)}">☰</button><div class="title-wrap"><h1 id="chat-title">${escape(first?.title || text.heading)}</h1><p id="chat-meta">${escape(text.readonly)}</p></div><a id="open-chat" href="${escape(first?.path || "manifest.json")}" target="_blank" rel="noopener noreferrer">${escape(text.open)} ↗</a></header><iframe id="conversation" title="${escape(first?.title || text.heading)}" ${first ? `src="${escape(first.path)}"` : ""} sandbox="allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe></main><noscript>${escape(text.noscript)}</noscript><script type="application/json" id="archive-data">${json({ rows, labels: text, language })}</script><script>${script}</script></body></html>\n`;
  }
  function errorHtml(title, message, language) {
    const text = labels[language === "ru" ? "ru" : "en"];
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escape(title)}</title><style>:root{color-scheme:light dark}body{max-width:760px;margin:80px auto;padding:24px;font:16px/1.6 system-ui}p{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>${escape(title)}</h1><p>${escape(text.unavailable)}</p><p>${escape(message)}</p></body></html>`;
  }
  globalThis.GoodogChatSite = Object.freeze({ indexHtml, errorHtml });
})();
