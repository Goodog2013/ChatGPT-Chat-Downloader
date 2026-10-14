/* Dependency-free ZIP32 STORE writer. No network, storage or executable archive content. */
(() => {
  "use strict";
  const VERSION = "3.0.0";
  if (globalThis.GoodogZip?.version === VERSION) return;
  const MAX_BYTES = 1536 * 1024 * 1024, MAX_FILE_BYTES = 256 * 1024 * 1024, MAX_FILES = 65535;
  const encoder = new TextEncoder();
  const crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    crcTable[index] = value >>> 0;
  }
  function normalizePath(value) {
    if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("Invalid ZIP path.");
    const path = value.replace(/\\/gu, "/").normalize("NFC");
    if (path.startsWith("/") || /^[a-z]:/iu.test(path) || path.endsWith("/")) throw new Error("ZIP entries must use relative file paths.");
    const parts = path.split("/").filter(part => part !== "" && part !== ".");
    if (!parts.length || parts.some(part => part === ".." || /[<>:"|?*]/u.test(part) || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw new Error("Unsafe ZIP path.");
    const name = parts.join("/"), bytes = encoder.encode(name);
    if (bytes.length > 65535) throw new Error("ZIP path is too long.");
    return { name, bytes };
  }
  function dosDate() {
    const now = new Date(), year = Math.max(1980, Math.min(2107, now.getFullYear()));
    return { time: (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >>> 1), date: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate() };
  }
  async function crc32(blob) {
    let value = 0xffffffff;
    const update = chunk => { for (let index = 0; index < chunk.length; index++) value = crcTable[(value ^ chunk[index]) & 255] ^ (value >>> 8); };
    if (typeof blob.stream === "function") {
      const reader = blob.stream().getReader();
      try { while (true) { const chunk = await reader.read(); if (chunk.done) break; update(chunk.value); } }
      finally { reader.releaseLock(); }
    } else {
      // Bound each temporary buffer even on older Chromium implementations.
      for (let offset = 0; offset < blob.size; offset += 1024 * 1024) update(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()));
    }
    return (value ^ 0xffffffff) >>> 0;
  }
  function createWriter(options = {}) {
    const requested = options.maxBytes === undefined ? MAX_BYTES : Number(options.maxBytes);
    if (!Number.isSafeInteger(requested) || requested < 22) throw new Error("Invalid ZIP size limit.");
    const maxBytes = Math.min(MAX_BYTES, requested), parts = [], entries = [], names = new Set();
    let offset = 0, centralSize = 0, busy = false, finished = null;
    async function add(name, input) {
      if (finished) throw new Error("ZIP has already been finalized.");
      if (busy) throw new Error("Wait for the previous ZIP entry before adding another.");
      if (entries.length >= MAX_FILES) throw new Error("ZIP32 supports at most 65535 files.");
      const path = normalizePath(name), collisionKey = path.name.toLowerCase();
      if (names.has(collisionKey)) throw new Error("Duplicate ZIP path.");
      let blob;
      if (input instanceof Blob) blob = input;
      else if (input instanceof Uint8Array) blob = new Blob([input.slice()]);
      else if (typeof input === "string") blob = new Blob([input]);
      else throw new TypeError("ZIP entry must be a Blob, Uint8Array or string.");
      if (blob.size > MAX_FILE_BYTES) throw new Error("A ZIP entry exceeds the 256 MiB file limit.");
      const localSize = 30 + path.bytes.length + blob.size, recordSize = 46 + path.bytes.length;
      if (offset + localSize + centralSize + recordSize + 22 > maxBytes) throw new Error("ZIP size limit exceeded.");
      busy = true;
      try {
        const crc = await crc32(blob), stamp = dosDate(), header = new Uint8Array(30), view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x0800, true);
        view.setUint16(8, 0, true); view.setUint16(10, stamp.time, true); view.setUint16(12, stamp.date, true);
        view.setUint32(14, crc, true); view.setUint32(18, blob.size, true); view.setUint32(22, blob.size, true); view.setUint16(26, path.bytes.length, true);
        entries.push({ path, crc, size: blob.size, offset, stamp }); names.add(collisionKey);
        parts.push(header, path.bytes, blob); offset += localSize; centralSize += recordSize;
        return { name: path.name, size: blob.size, crc32: crc };
      } finally { busy = false; }
    }
    function finish() {
      if (finished) return finished;
      if (busy) throw new Error("Wait for the pending ZIP entry before finalizing.");
      const central = [];
      for (const entry of entries) {
        const header = new Uint8Array(46), view = new DataView(header.buffer);
        view.setUint32(0, 0x02014b50, true); view.setUint16(4, 20, true); view.setUint16(6, 20, true); view.setUint16(8, 0x0800, true);
        view.setUint16(10, 0, true); view.setUint16(12, entry.stamp.time, true); view.setUint16(14, entry.stamp.date, true);
        view.setUint32(16, entry.crc, true); view.setUint32(20, entry.size, true); view.setUint32(24, entry.size, true);
        view.setUint16(28, entry.path.bytes.length, true); view.setUint32(42, entry.offset, true);
        central.push(header, entry.path.bytes);
      }
      const end = new Uint8Array(22), view = new DataView(end.buffer);
      view.setUint32(0, 0x06054b50, true); view.setUint16(8, entries.length, true); view.setUint16(10, entries.length, true);
      view.setUint32(12, centralSize, true); view.setUint32(16, offset, true);
      finished = new Blob([...parts, ...central, end], { type: "application/zip" });
      parts.length = 0; entries.length = 0; names.clear();
      return finished;
    }
    return Object.freeze({ add, finish });
  }
  globalThis.GoodogZip = Object.freeze({ version: VERSION, createWriter });
})();
