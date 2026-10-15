/* Local Markdown rendering. Raw HTML is escaped; no scripts or remote images. */
(() => {
  "use strict";
  const VERSION = "3.2.0";
  if (globalThis.GoodogMarkdown?.version === VERSION) return;
  const MAX_RENDER_CHARS = 2 * 1024 * 1024;
  const escape = value => String(value ?? "").replace(/[&<>"']/gu, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const styles = `.markdown{overflow-wrap:anywhere;line-height:1.65}.markdown>:first-child{margin-top:0}.markdown>:last-child{margin-bottom:0}.markdown h1,.markdown h2,.markdown h3,.markdown h4{line-height:1.3;margin:1.4em 0 .65em}.markdown h1{font-size:1.8em}.markdown h2{font-size:1.45em}.markdown h3{font-size:1.2em}.markdown p,.markdown ul,.markdown ol{margin:.8em 0}.markdown li+li{margin-top:.3em}.markdown blockquote{margin:1em 0;padding:.25em 1em;border-left:4px solid #c5cdd9;color:#4d5968;background:#f6f8fb}.markdown pre{overflow-x:auto;padding:16px;border:1px solid #dce0e6;border-radius:8px;background:#f6f8fb;white-space:pre;line-height:1.5}.markdown code{font-family:Consolas,ui-monospace,monospace;font-size:.9em}.markdown :not(pre)>code{padding:.15em .35em;border-radius:4px;background:#eef1f6}.markdown table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;margin:1em 0}.markdown th,.markdown td{border:1px solid #dce0e6;padding:8px 12px;text-align:left}.markdown th{background:#f0f3f8}.markdown hr{border:0;border-top:1px solid #dce0e6;margin:1.5em 0}.markdown img{max-width:100%;height:auto}.markdown .literal{white-space:pre-wrap}.markdown a{color:#1858a8}.markdown input[type=checkbox]{margin-right:.5em}`;

  function createRenderer(options = {}) {
    if (typeof globalThis.marked?.Marked !== "function") throw new Error("The bundled Markdown parser is missing.");
    function target(value) {
      if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) return null;
      const local = options.resolveLocal?.(value);
      if (local?.href) return { href: local.href, local: true, image: local.image === true };
      if (value.startsWith("#")) return { href: value, local: true };
      try {
        const url = new URL(value);
        if (!["https:", "http:", "mailto:"].includes(url.protocol) || url.username || url.password) return null;
        return { href: url.href, local: false };
      } catch { return null; }
    }
    const parser = new globalThis.marked.Marked({ gfm: true, breaks: false, async: false });
    parser.use({ renderer: {
      html({ text }) { return escape(text); },
      link({ href, title, tokens }) {
        const body = this.parser.parseInline(tokens), link = target(href);
        if (!link) return body;
        return `<a href="${escape(link.href)}"${title ? ` title="${escape(title)}"` : ""}${link.local ? "" : ' target="_blank" rel="noopener noreferrer"'}>${body}</a>`;
      },
      image({ href, title, text }) {
        const link = target(href), label = escape(text || href || "Image");
        if (link?.local && link.image) return `<img src="${escape(link.href)}" alt="${label}"${title ? ` title="${escape(title)}"` : ""} loading="lazy">`;
        return link ? `<a href="${escape(link.href)}"${link.local ? "" : ' target="_blank" rel="noopener noreferrer"'}>${label}</a>` : label;
      },
    } });
    return text => {
      const source = String(text ?? "").replace(/^\uFEFF/u, "");
      // Very large or malformed messages retain every character as literal text.
      if (source.length > MAX_RENDER_CHARS) return `<pre class="literal">${escape(source)}</pre>`;
      try { return parser.parse(source); }
      catch { return `<pre class="literal">${escape(source)}</pre>`; }
    };
  }

  function document(text, options = {}) {
    const language = options.language === "ru" ? "ru" : "en";
    const render = createRenderer();
    return `<!doctype html>\n<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>${escape(options.title || "Markdown")}</title><style>body{max-width:1000px;margin:40px auto;padding:0 20px;background:#fafafa;color:#20242b;font:16px/1.6 system-ui,sans-serif}header{margin-bottom:28px}h1{overflow-wrap:anywhere}a{color:#1858a8}${styles}</style></head><body><header><h1>${escape(options.title || "Markdown")}</h1>${options.downloadHref ? `<a href="${escape(options.downloadHref)}" download>${language === "ru" ? "Скачать оригинал .md" : "Download original .md"}</a>` : ""}</header><main class="markdown">${render(text)}</main></body></html>\n`;
  }
  globalThis.GoodogMarkdown = Object.freeze({ version: VERSION, createRenderer, document, styles });
})();
