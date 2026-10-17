const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtemp, mkdir, readFile, writeFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const { createRuntime, extension } = require("../helpers/runtime.cjs");
const { makeZip, multipartEntries, expectedMessages } = require("../helpers/fixtures.cjs");

test("real extension popup and offline HTML display numerically imported chats", { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "goodog-synthetic-"));
  let context;
  t.after(async () => {
    await context?.close();
    await rm(directory, { recursive: true, force: true });
  });
  context = await chromium.launchPersistentContext(path.join(directory, "profile"), {
    channel: "chromium", headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    acceptDownloads: true,
  });
  const networkRequests = [], errors = [];
  await context.route(/^https?:/u, route => {
    networkRequests.push(route.request().url());
    return route.abort();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host, page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/popup.html?wide=1`);
  const fixture = multipartEntries("synthetic/export/");
  const expected = [1, 2, 10, 11].flatMap(part => fixture.find(([name]) => name.endsWith(`/conversations-${part}.json`))[1]);
  await page.locator("#local-file").setInputFiles({ name: "synthetic-multipart.zip", mimeType: "application/zip", buffer: makeZip(fixture) });
  await page.waitForFunction(() => !document.getElementById("local-download").disabled || !document.getElementById("local-error").hidden);
  assert.equal(await page.locator("#local-error").textContent(), "");
  const options = await page.locator("#local-conversation option").evaluateAll(nodes => nodes.map(node => ({ value: node.value, label: node.textContent })));
  assert.equal(options.length, 8);
  assert.match(await page.locator("#local-import-summary").textContent(), /8/u);
  t.diagnostic(`Popup order: ${options.map(option => option.label).join(", ")}`);
  assert.deepEqual(options, expected.map((chat, index) => ({ value: String(index), label: `${chat.title} · 4 messages` })));

  const runtime = createRuntime();
  async function download(button, filename) {
    const pending = page.waitForEvent("download");
    await page.locator(button).click();
    const result = await pending, target = path.join(directory, filename);
    await result.saveAs(target);
    assert.equal(await result.failure(), null);
    return runtime.readZip(new Blob([await readFile(target)]));
  }
  // Select each visible option and check the actual downloaded conversation.
  for (const [index, chat] of expected.entries()) {
    await page.locator("#local-conversation").selectOption(String(index));
    const files = await download("#local-download", `chat-${index}.zip`);
    const saved = JSON.parse(files.get("conversation.json"));
    assert.equal(saved.id, chat.id);
    assert.deepEqual(saved.messages.map(({ id, parentId, role, text, createdAt }) => ({ id, parentId, role, text, createdAt })), expectedMessages(chat));
    assert.equal(saved.availableBranches.nodes[0].text, `Synthetic alternate ${chat.id}: also retained.`);
  }

  const files = await download("#local-site-download", "site.zip");
  assert.equal(JSON.parse(files.get("manifest.json")).conversations.length, 8);
  const site = path.join(directory, "site");
  for (const [name, content] of files) {
    const target = path.resolve(site, name);
    assert.ok(target.startsWith(site + path.sep));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const archive = await context.newPage();
  archive.on("pageerror", error => errors.push(error.message));
  await archive.goto(pathToFileURL(path.join(site, "index.html")).href);
  const buttons = archive.locator("#conversations .chat-link");
  await buttons.nth(7).waitFor();
  assert.deepEqual(await buttons.locator("span").allTextContents(), expected.map(chat => chat.title));
  for (const [index, chat] of expected.entries()) {
    await buttons.nth(index).click();
    const messages = archive.frameLocator("#conversation").locator(".chat-message");
    await messages.first().locator(".message").filter({ hasText: `Synthetic user ${chat.id}:` }).waitFor();
    assert.equal(await messages.count(), 4);
    const displayed = await messages.locator(".message").allTextContents();
    assert.ok(displayed[0].includes(`Synthetic user ${chat.id}: Привет 🧪`));
    assert.ok(displayed[1].includes(`Synthetic assistant ${chat.id}:`));
    assert.ok(displayed[2].includes(`Synthetic follow-up ${chat.id}:`));
    assert.ok(displayed[3].includes(`Synthetic final ${chat.id}:`));
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(networkRequests, []);
  t.diagnostic("8 popup options, 8 downloaded conversations, 8 sidebar entries and 32 rendered messages checked without network requests.");
});
