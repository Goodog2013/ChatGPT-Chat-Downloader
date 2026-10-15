/* Local, seekable ZIP import. No extraction to disk, network or executable HTML. */
(() => {
  "use strict";
  const MAX_ENTRIES = 50000, MAX_ZIP_BYTES = 8 * 1024 ** 3;
  const MAX_JSON_BYTES = 512 * 1024 ** 2, MAX_FILE_BYTES = 256 * 1024 ** 2;
  function safePath(value) {
    if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) return "";
    const path = value.replace(/\\/gu, "/").normalize("NFC");
    if (path.startsWith("/") || /^[a-z]:/iu.test(path) || path.split("/").some(part => part === ".." || part === "." || !part)) return "";
    return path;
  }
  function mimeOf(name) {
    const extension = name.toLowerCase().split(".").pop();
    return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf", md: "text/markdown", markdown: "text/markdown", txt: "text/plain", json: "application/json" })[extension] || "application/octet-stream";
  }
  async function isZip(blob) {
    const prefix = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    return prefix[0] === 80 && prefix[1] === 75 && [3, 5, 7].includes(prefix[2]);
  }
  async function open(blob, { signal, onProgress } = {}) {
    if (!(blob instanceof Blob) || blob.size > MAX_ZIP_BYTES) throw new Error("ZIP exceeds the 8 GiB input limit.");
    zip.configure({ useWebWorkers: false, useCompressionStream: true, maxWorkers: 1 });
    const reader = new zip.ZipReader(new zip.BlobReader(blob), { useWebWorkers: false, strictness: "strict" });
    const entries = [], names = new Map();
    try {
      let count = 0;
      for await (const entry of reader.getEntriesGenerator({ signal })) {
        if (++count > MAX_ENTRIES) throw new Error("ZIP contains more than 50,000 entries.");
        if (entry.directory) continue;
        const path = safePath(entry.filename);
        if (!path) throw new Error("ZIP contains an unsafe file path.");
        const lower = path.toLowerCase();
        if (names.has(lower)) throw new Error("ZIP contains ambiguous duplicate file names.");
        const item = { path, name: path.split("/").pop(), entry };
        names.set(lower, item); entries.push(item);
      }
      async function read(item, limit = MAX_FILE_BYTES) {
        if (!item?.entry || item.entry.encrypted) throw new Error("Encrypted ZIP entries are not supported.");
        if (!Number.isSafeInteger(item.entry.uncompressedSize) || item.entry.uncompressedSize > limit) throw new Error(`ZIP entry exceeds the ${Math.round(limit / 1024 ** 2)} MiB limit.`);
        const parts = [];
        let size = 0;
        try {
          await item.entry.getData(new WritableStream({ write(chunk) {
            size += chunk.byteLength;
            if (size > limit) throw new Error("Decompressed ZIP entry exceeds the size limit.");
            parts.push(new Blob([chunk]));
          } }), { signal, useWebWorkers: false, useCompressionStream: true, checkCrc32: true, strictness: "strict",
            onprogress: (loaded, total) => onProgress?.({ path: item.path, loaded, total }) });
          if (size !== item.entry.uncompressedSize) throw new Error("ZIP entry size does not match its directory record.");
          return new Blob(parts, { type: mimeOf(item.path) });
        } finally { parts.length = 0; }
      }
      const find = path => names.get(safePath(path).toLowerCase()) || null;
      const official = entries.filter(item => item.name.toLowerCase() === "conversations.json");
      if (official.length > 1) throw new Error("More than one conversations.json was found. Select one ChatGPT export ZIP.");
      let jsonEntries = official;
      if (!jsonEntries.length) jsonEntries = entries.filter(item => /^conversations-\d+\.json$/iu.test(item.name)).sort((a, b) => a.path.localeCompare(b.path));
      if (!jsonEntries.length) {
        jsonEntries = entries.filter(item => item.name.toLowerCase() === "conversation.json");
        if (jsonEntries.length > 1 && !jsonEntries.every(item => /(?:^|\/)chats\/\d+\/conversation\.json$/iu.test(item.path))) throw new Error("Multiple conversation.json files are ambiguous. Select one export ZIP.");
      }
      if (!jsonEntries.length) throw new Error("No conversations.json or conversation.json was found in the ZIP. HTML-only archives cannot restore the conversation data.");
      if (jsonEntries.reduce((sum, item) => sum + item.entry.uncompressedSize, 0) > MAX_JSON_BYTES) throw new Error("Conversation JSON exceeds the combined 512 MiB import limit.");
      return { entries, jsonEntries, find, read, close: () => reader.close() };
    } catch (error) { await reader.close(); throw error; }
  }
  globalThis.GoodogZipReader = Object.freeze({ open, isZip, safePath, mimeOf, MAX_JSON_BYTES, MAX_FILE_BYTES });
})();
