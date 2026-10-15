# ChatGPT Chat Downloader · Goodog Chat Export 3.2

[Русский](README.ru.md) · [Download for Windows](https://github.com/Goodog2013/ChatGPT-Chat-Downloader/releases/download/v3.2.0/GoodogChatExport-Windows-3.2.0.zip)

A local Windows Chrome/Edge extension for ChatGPT conversation ZIP/Markdown export, ZIP/JSON import and a browsable offline HTML archive. English is the default language; Russian is available in the selector. Message content is never translated.

## Install or update

Extract GoodogChatExport-Windows-3.2.0.zip to a permanent folder. Open chrome://extensions/ or edge://extensions/, enable Developer mode, and load the extension folder. To update, replace the extension files, click Reload, and refresh your ChatGPT tab. BAT helpers only open the folder and extensions page; they do not change browser security settings. Requires Chromium 116 or newer. Python, Node.js and an OpenAI API key are not required.

## Import a ZIP and create an HTML site

1. Open the extension; use Open in a wide window for large archives.
2. Select the official ChatGPT account-export ZIP, a single-chat ZIP from this extension, or conversations.json in the local import section. No prior ZIP extraction is needed.
3. For one conversation, select it and save MD/ZIP. The redesigned chat.html inside the ZIP has right-aligned user bubbles, flowing assistant responses, formatted code/tables, local media/files and automatic light/dark styling.
4. For all conversations, choose Save offline HTML site (all chats). Extract the result and open index.html. The sidebar offers conversation titles and title search. Only the selected chat loads. A menu button opens the sidebar on small screens.
5. The chats folder holds each conversation's HTML, Markdown, JSON and available original attachments. Root manifest.json reports coverage/errors; per-chat reports list file SHA-256 hashes. Missing files are explicitly reported.

ZIP import recognizes conversations.json, conversations-N.json and conversation.json. HTML-site ZIPs created by this version can be imported again. HTML/MD-only archives do not contain enough structured data to restore conversations. An optional extracted attachment folder can supplement older exports. Only unambiguous matches are included. Local import never retrieves missing files from the network.

## Export directly from ChatGPT

Open a saved conversation at /c/... or /g/.../c/..., choose ZIP or MD, then load the history without scrolling. Keep the original ChatGPT tab open for large exports. ZIP may request optional access to oaiusercontent.com and blob.core.windows.net for original attachments. Denied access does not block text export; unavailable attachments appear in the report. Loading can be stopped and the available portion saved.

A normal ZIP contains chat.html, chat.md, conversation.json, manifest.json, attachments/ and optional previews/. Markdown attachments have a safe HTML preview for UTF-8 files up to 2 MiB each and 8 MiB of generated HTML per archive. Messages longer than 2,097,152 characters are displayed literally.

## Coverage, privacy and limits

Local import stays in the extension tab's memory and is never uploaded. After extraction, the HTML site works without a server or internet connection. It is a read-only archive, not a live ChatGPT client. Source links remain links; remote images do not load automatically. Message HTML is escaped.

Each conversation shows its current branch. Available alternative visible nodes remain in JSON; hidden instructions, profiles and internal reasoning are excluded. History coverage and attachment coverage are separate. Conversion failures are represented by a conversation error page and a report entry, never silently omitted.

Import limits: ZIP up to 8 GiB, 50,000 entries, 512 MiB of combined conversation JSON, 64 MiB per conversation JSON and 20,000 conversations. Encrypted ZIPs are unsupported. Import checks paths, decompressed sizes and CRC-32. Export limits: 256 MiB per attachment and 1.5 GiB per ZIP; HTML sites allow a 1 GiB attachment budget, reserving the rest for text/reports. Files exceeding the budget are marked unavailable. Text/ZIP limit failures stop the operation instead of presenting a truncated archive as complete. Extra browser memory is needed; use a separate extension tab for large archives.

Marked 18.1.1 (MIT) and zip.js 2.23.0 (BSD-3-Clause) are bundled locally with licenses. ChatGPT's undocumented JSON routes may change; the official account export is the fallback source.

At the user's request, validation covers syntax and installer-package integrity only. Test suites, browser/real-account probes and execution on Windows have not been performed.
