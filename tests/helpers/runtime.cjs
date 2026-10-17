const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extension = path.resolve(__dirname, "../../extension");

// Only the Worker transport is adapted. All import/export scripts and zip.js
// run unchanged, using Node's native Blob, streams and Web Crypto APIs.
function createRuntime() {
  const replies = [];
  const context = vm.createContext({
    Blob, TextEncoder, TextDecoder, ReadableStream, WritableStream, TransformStream,
    CompressionStream, DecompressionStream, AbortController, DOMException,
    URL, Response, btoa, atob, crypto: globalThis.crypto, performance, setTimeout, clearTimeout, console,
    postMessage: message => replies.push(structuredClone(message)),
  });
  context.self = context;
  context.importScripts = (...names) => {
    for (const name of names) vm.runInContext(readFileSync(path.join(extension, name), "utf8"), context, { filename: name });
  };
  context.importScripts("json-worker.js");
  let requestId = 0;
  return {
    context,
    async request(data) {
      replies.length = 0;
      await context.onmessage({ data: { ...data, requestId: ++requestId } });
      const reply = replies.find(message => message.requestId === requestId && message.type !== "PROGRESS");
      if (!reply) throw new Error("Worker did not send a terminal reply.");
      return reply;
    },
    async readZip(blob) {
      const reader = new context.zip.ZipReader(new context.zip.BlobReader(blob), { useWebWorkers: false });
      try {
        const files = new Map();
        for (const entry of await reader.getEntries()) {
          files.set(entry.filename, await entry.getData(new context.zip.TextWriter(), { useWebWorkers: false }));
        }
        return files;
      } finally { await reader.close(); }
    },
  };
}

module.exports = { createRuntime, extension };
