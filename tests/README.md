# Synthetic ZIP import regression tests

All conversations and ZIPs are generated in memory by `helpers/fixtures.cjs`.
No account, credentials, personal chats or downloaded ChatGPT exports are used.

## Run

Node.js 22.15+ (CI uses Node.js 24):

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

On a clean Linux runner, use `npx playwright install --with-deps chromium`.
An existing compatible Chromium executable can be selected with
`CHROMIUM_EXECUTABLE_PATH`. The browser test uses a temporary profile and deletes
its synthetic downloads after the test. Browser launch failures fail the test;
they are not silently skipped.

## Coverage

- Real ZIP bytes (DEFLATE and STORE) pass through the bundled zip.js,
  `zip-reader.js`, and `json-worker.js` LOAD/EXPORT/EXPORT_SITE handlers.
  Node tests adapt only Worker transport; the production scripts are unchanged.
- Parts 1, 2, 10 and 11 contain two conversations each, in deliberately
  non-alphabetical order. The ZIP directory is also deliberately shuffled.
  Assertions check eight unique conversations, 32 current-branch messages and
  eight alternative messages, including IDs, parent links, roles, timestamps,
  Unicode, escaped text, Markdown and message order after export.
- Numeric indices come from exact basenames, independent of directory names.
  Equal indices (including leading zeros and different directories) keep every
  file and use normalized full-path code-unit order as a deterministic tie-break.
  BigInt comparisons cover indices beyond Number.MAX_SAFE_INTEGER.
- Existing path and duplicate-name rejection, case-insensitive recognition,
  conversations.json priority, single-chat ZIP and standalone JSON are covered.
- The HTML archive retains all chats and messages and can be reimported. Its
  existing newest-first date order is preserved; equal dates retain import order.
- Playwright loads the actual unpacked extension in headless Chromium, selects
  the synthetic ZIP through the popup file input, checks the visible option
  order, downloads each selected chat and the full HTML site, then opens the
  extracted site to check sidebar order and all 32 rendered messages. HTTP(S)
  requests are blocked and asserted absent. No Chrome APIs or Workers are mocked.

## Baseline reproduction

With `extension/zip-reader.js` from commit
`477c925c1b9c7eabc601cc4730bd6832a3fd2208`, the multipart test reports:

```text
Imported 8 chats; 32 current-branch messages and 8 alternate messages are intact.
Actual order: part-1-B, part-1-A, part-10-B, part-10-A,
              part-11-B, part-11-A, part-2-B, part-2-A
```

The numeric-order assertions fail both for LOAD and the generated HTML sidebar
data. No message loss was observed in this synthetic reproduction.
