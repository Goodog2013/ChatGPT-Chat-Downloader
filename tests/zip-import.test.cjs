const assert = require("node:assert/strict");
const test = require("node:test");
const { createRuntime } = require("./helpers/runtime.cjs");
const { makeZip, conversation, multipartEntries, expectedMessages } = require("./helpers/fixtures.cjs");

const messageFields = ({ id, parentId, role, text, createdAt }) => ({ id, parentId, role, text, createdAt });

test("multipart ZIP import retains counts and messages and uses numeric part order", async t => {
  const runtime = createRuntime(), fixture = multipartEntries();
  const expected = [1, 2, 10, 11].flatMap(part => fixture.find(([name]) => name === `conversations-${part}.json`)[1]);
  const loaded = await runtime.request({ type: "LOAD", file: new Blob([makeZip(fixture)]) });
  assert.equal(loaded.type, "LOADED", loaded.error);
  assert.equal(loaded.sourceKind, "zip");
  assert.equal(loaded.conversationCount, 8);
  assert.equal(loaded.conversations.length, 8);
  assert.equal(loaded.conversations.reduce((sum, chat) => sum + chat.messageCount, 0), 32);
  assert.deepEqual(new Set(loaded.conversations.map(chat => chat.id)), new Set(expected.map(chat => chat.id)));

  // Check every indexed selection even on the broken baseline, before checking
  // order: a sorting failure must not be misreported as message loss.
  for (const entry of loaded.conversations) {
    const original = expected.find(chat => chat.id === entry.id);
    const exported = await runtime.request({ type: "EXPORT", index: entry.index, format: "zip", language: "en" });
    assert.equal(exported.type, "EXPORTED", exported.error);
    assert.equal(exported.count, 4);
    assert.equal(exported.coverage, "complete");
    const files = await runtime.readZip(exported.blob), saved = JSON.parse(files.get("conversation.json"));
    assert.equal(saved.id, original.id);
    assert.equal(saved.title, original.title);
    assert.deepEqual(saved.messages.map(messageFields), expectedMessages(original));
    assert.deepEqual(saved.availableBranches.nodes.map(messageFields), [{
      id: `${original.id}-alternate`, parentId: `${original.id}-m0`, role: "assistant",
      text: `Synthetic alternate ${original.id}: also retained.`, createdAt: expectedMessages(original)[1].createdAt,
    }]);
    const markdown = files.get("chat.md");
    let position = -1;
    for (const message of expectedMessages(original)) {
      const next = markdown.indexOf(message.text);
      assert.ok(next > position, `Markdown message order for ${original.id}`); position = next;
    }
  }
  t.diagnostic(`Imported ${loaded.conversationCount} chats; 32 current-branch messages and 8 alternate messages are intact.`);
  t.diagnostic(`Actual order: ${loaded.conversations.map(chat => chat.id).join(", ")}`);
  assert.deepEqual(loaded.conversations.map(chat => chat.id), expected.map(chat => chat.id));
  assert.deepEqual(loaded.conversations.map(chat => chat.index), expected.map((_, index) => index));
});

async function loadPaths(paths, options) {
  const runtime = createRuntime();
  const reply = await runtime.request({ type: "LOAD", file: new Blob([makeZip(
    paths.map((name, index) => [name, [conversation(`chat-${index}`, name)]]), options)]) });
  assert.equal(reply.type, "LOADED", reply.error);
  assert.equal(reply.conversationCount, paths.length);
  return reply.conversations.map(chat => chat.title);
}

test("STORE ZIP: basename indices sort across nested paths, separators and case", async () => {
  const paths = ["export-1/conversations-11.json", "export-100\\deep\\Conversations-2.JSON",
    "conversations-10.json", "export-200/conversations-1.json"];
  assert.deepEqual(await loadPaths(paths, { compressed: false }), [paths[3], paths[1], paths[2], paths[0]]);
});

test("equal numeric indices retain every file with a deterministic normalized full-path tie-break", async () => {
  const paths = ["z/conversations-1.json", "conversations-0001.json", "b\\conversations-1.json", "a/conversations-01.json"];
  const expected = [paths[3], paths[2], paths[1], paths[0]];
  assert.deepEqual(await loadPaths(paths), expected);
  assert.deepEqual(await loadPaths([...paths].reverse()), expected);
});

test("indices above Number.MAX_SAFE_INTEGER do not lose precision", async () => {
  const paths = ["a/conversations-9007199254740993.json", "z/conversations-9007199254740992.json",
    "conversations-100000000000000000000.json", "conversations-0.json"];
  assert.deepEqual(await loadPaths(paths), [paths[3], paths[1], paths[0], paths[2]]);
});

test("only exact numbered basenames are imported", async () => {
  const names = ["conversations-1.json.bak", "my-conversations-2.json", "conversations-2x.json",
    "conversations--2.json", "conversations-1.5.json", "conversations-２.json"];
  const runtime = createRuntime(), valid = conversation("valid");
  const reply = await runtime.request({ type: "LOAD", file: new Blob([makeZip([
    ...names.map(name => [name, "this is deliberately not JSON"]), ["conversations-2.json", [valid]],
  ])]) });
  assert.equal(reply.type, "LOADED", reply.error);
  assert.equal(reply.conversationCount, 1);
  assert.equal(reply.conversations[0].id, "valid");
});

test("conversations.json retains precedence over numbered and single-chat files", async () => {
  const runtime = createRuntime();
  const reply = await runtime.request({ type: "LOAD", file: new Blob([makeZip([
    ["conversations-1.json", "not JSON"], ["conversation.json", "not JSON"],
    ["export/Conversations.JSON", [conversation("official")]],
  ])]) });
  assert.equal(reply.type, "LOADED", reply.error);
  assert.deepEqual(reply.conversations.map(chat => chat.id), ["official"]);
});

test("single-chat ZIP and standalone JSON import still work", async () => {
  const runtime = createRuntime(), chat = conversation("single");
  for (const file of [new Blob([makeZip([["conversation.json", chat]])]), new Blob([JSON.stringify([chat])])]) {
    const reply = await runtime.request({ type: "LOAD", file });
    assert.equal(reply.type, "LOADED", reply.error);
    assert.deepEqual(reply.conversations.map(entry => entry.id), ["single"]);
  }
});

test("unsafe ZIP paths are still rejected before importing any parts", async t => {
  for (const name of ["../conversations-1.json", "/conversations-1.json", "C:\\conversations-1.json",
    "export/../conversations-1.json", "export/./conversations-1.json", "export//conversations-1.json", "bad\u0001/conversations-1.json"]) {
    await t.test(JSON.stringify(name), async () => {
      const runtime = createRuntime();
      const reply = await runtime.request({ type: "LOAD", file: new Blob([makeZip([
        ["conversations-2.json", [conversation("valid")]], [name, [conversation("unsafe")]],
      ])]) });
      assert.equal(reply.type, "ERROR");
      assert.match(reply.error, /unsafe file/iu);
      assert.equal((await runtime.request({ type: "EXPORT", index: 0 })).type, "ERROR");
    });
  }
});

test("ambiguous ZIP names and multiple official exports remain rejected", async t => {
  const cases = [
    ["conversations-1.json", "conversations-1.json"],
    ["conversations-1.json", "CONVERSATIONS-1.JSON"],
    ["folder/conversations-1.json", "folder\\conversations-1.json"],
    ["caf\u00e9/conversations-1.json", "cafe\u0301/conversations-1.json"],
    ["one/conversations.json", "two/conversations.json"],
    ["one/conversation.json", "two/conversation.json"],
  ];
  for (const names of cases) await t.test(names.join(" + "), async () => {
    const runtime = createRuntime();
    const reply = await runtime.request({ type: "LOAD", file: new Blob([makeZip(names.map(name => [name, [conversation("duplicate")]]))]) });
    assert.equal(reply.type, "ERROR");
    assert.match(reply.error, /ambiguous|More than one conversations\.json/iu);
  });
});

test("HTML archive preserves all messages and uses numeric order for equal dates", async () => {
  const runtime = createRuntime(), fixture = multipartEntries("nested/export/");
  const expected = [1, 2, 10, 11].flatMap(part => fixture.find(([name]) => name.endsWith(`/conversations-${part}.json`))[1]);
  assert.equal((await runtime.request({ type: "LOAD", file: new Blob([makeZip(fixture)]) })).type, "LOADED");
  const result = await runtime.request({ type: "EXPORT_SITE", language: "en" });
  assert.equal(result.type, "EXPORTED", result.error);
  assert.equal(result.conversationCount, 8);
  assert.equal(result.count, 32);
  assert.equal(result.coverage, "complete");
  assert.deepEqual(result.warnings, []);
  const files = await runtime.readZip(result.blob), report = JSON.parse(files.get("manifest.json"));
  assert.equal(report.conversations.length, 8);
  for (const row of report.conversations) {
    const saved = JSON.parse(files.get(row.path.replace("chat.html", "conversation.json")));
    const original = expected.find(chat => chat.id === saved.id);
    assert.ok(original, `Unexpected conversation: ${saved.id}`);
    assert.deepEqual(saved.messages.map(messageFields), expectedMessages(original));
  }
  const index = files.get("index.html");
  const sidebar = JSON.parse(index.match(/<script type="application\/json" id="archive-data">([^]*?)<\/script>/u)[1]);
  assert.deepEqual(sidebar.rows.map(row => row.title), expected.map(chat => chat.title));
  // Reimport the generated archive through the existing chats/N/conversation.json fallback.
  const reimported = await runtime.request({ type: "LOAD", file: result.blob });
  assert.equal(reimported.type, "LOADED", reimported.error);
  assert.deepEqual(reimported.conversations.map(chat => chat.id), expected.map(chat => chat.id));
});

test("HTML archive still displays different dates newest first", async () => {
  const runtime = createRuntime();
  const fixture = [1, 2, 10, 11].map(part => [`conversations-${part}.json`, [conversation(`part-${part}`, `Part ${part}`, 1700000000 + part)]]);
  assert.equal((await runtime.request({ type: "LOAD", file: new Blob([makeZip(fixture)]) })).type, "LOADED");
  const result = await runtime.request({ type: "EXPORT_SITE", language: "en" });
  assert.equal(result.type, "EXPORTED", result.error);
  const files = await runtime.readZip(result.blob);
  const sidebar = JSON.parse(files.get("index.html").match(/<script type="application\/json" id="archive-data">([^]*?)<\/script>/u)[1]);
  assert.deepEqual(sidebar.rows.map(row => row.title), ["Part 11", "Part 10", "Part 2", "Part 1"]);
});
