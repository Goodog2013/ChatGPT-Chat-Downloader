# ChatGPT Chat Downloader · Goodog Chat Export

[Русский](README.ru.md) · [Download for Windows](https://github.com/Goodog2013/ChatGPT-Chat-Downloader/releases/download/v3.0.0/GoodogChatExport-Windows-3.0.0.zip)

A local Chrome/Edge extension that saves your current ChatGPT conversation branch as a ZIP with available original attachments, or as a text-only TXT file. English is the default; Russian is available in the language selector. Your messages are never translated.

## Install or update

1. [Download GoodogChatExport-Windows-3.0.0.zip](https://github.com/Goodog2013/ChatGPT-Chat-Downloader/releases/download/v3.0.0/GoodogChatExport-Windows-3.0.0.zip) and extract it to a permanent folder.
2. Run `Install-Chrome.bat` or `Install-Edge.bat` to open the extension folder and browser extensions page. Alternatively, open `chrome://extensions/` or `edge://extensions/` manually.
3. Enable **Developer mode**, choose **Load unpacked**, and select the **extension** folder containing `manifest.json`.
4. Keep that folder in place after installation. To update, replace its extension files, click **Reload** on the browser extensions page, and refresh your ChatGPT tab.

Requires Chrome/Edge based on Chromium 116 or later. Python, Node.js and an OpenAI API key are not required to use the extension. Installation uses the browser's normal unpacked-extension workflow; the BAT helpers do not change browser security settings.

## Export an open conversation

1. Sign in to ChatGPT in the same browser and open a saved conversation at `/c/…`. Project/GPT paths such as `/g/…/c/…` are supported too.
2. Open the extension. For large exports, choose **Open in a wide window** and keep the original ChatGPT tab open.
3. Choose **ZIP · chat and files** or **TXT · text only**, then start loading. No scrolling is needed: the extension requests conversation JSON pages.
4. For ZIP, the browser may request optional access to `oaiusercontent.com` and `blob.core.windows.net` to retrieve original attachments. Denying it does not block history loading; unavailable files are reported.
5. Wait for loading and attachment processing, then choose where to save the file in the browser's save dialog.

You can stop loading and save the available part. History coverage and attachment coverage are shown separately. An incomplete history or missing file is not reported as a complete export.

## ZIP contents

| File | Contents |
| --- | --- |
| `chat.html` | Offline conversation viewer with local image, audio and video previews, and file links. |
| `chat.txt` | Current-branch text, including code, Markdown, links and interrupted answers. |
| `conversation.json` | Visible messages, relationships and attachment metadata. |
| `attachments/` | Original bytes of available files. |
| `manifest.json` | Each detected file's local path, size and SHA-256, or its missing-file reason. |
| `README.txt` | Archive contents and limitations in the selected language. |

Extract the complete ZIP and open `chat.html`. The viewer runs no scripts and loads no remote resources. SVG and HTML attachments remain downloadable files and are not executed inside the chat viewer. Ordinary source links remain links; their websites are not downloaded.

Supported attachment sources include file metadata, image/audio/video pointers, available tool images, and `/mnt/data` sandbox links in message text outside code blocks, when ChatGPT still permits access to the original file. Deleted, expired, revoked, unsupported or oversized files are recorded in `manifest.json`; a filename is never substituted for an original file.

## What “the whole chat” means

The main transcript is the currently selected branch, loaded to confirmed pagination boundaries. Alternative answers are not mixed into `chat.txt` or `chat.html`. If the returned mapping already contains alternative visible nodes, they and their available attachments are retained separately in `conversation.json`; `availableAlternatesCount` records their number.

A flat API may not supply every alternative branch. The extension does not open other conversations, guess hidden branch endpoints or recover deleted data. The official account export can provide a more complete conversation tree. Hidden system instructions, profile data, memory and internal reasoning are excluded.

Historical interrupted answers retain their available text without making fully loaded history partial. If the latest answer is still being generated, the export is a snapshot of the text currently available; export again after it finishes.

## TXT mode

TXT includes all available visible text in the current branch, code, links and text captions. Images, binary attachments and file placeholders are omitted. Files use UTF-8 with a BOM for Windows. TXT does not require optional file-storage permissions.

You can save another format from already loaded conversation data. To change the language of service labels in an already collected transcript, reload the conversation in the selected language. Message content is unchanged.

## Import an official ChatGPT export

1. Request and download your account's built-in ChatGPT data export.
2. Extract its ZIP using your normal archive tool.
3. In the extension's wide window, open `conversations.json`. A single conversation JSON containing `mapping` or `messages` is also supported.
4. For ZIP output, optionally select the extracted export folder containing attachments. Only files matching the selected conversation by ID or unambiguous filename are included.
5. Select a conversation and export format, then save. Without an attachment folder, the ZIP is still created and missing originals are reported.

Local files are processed in browser memory and are never uploaded. Local archive building does not make network requests for attachments and does not require an active ChatGPT session. Large top-level conversation arrays are indexed incrementally in a Worker; the selected conversation is loaded for conversion. Keep the extension tab open while processing.

## Limits

- Up to 256 MiB per attachment and 1.5 GiB per ZIP. Archives are built from Blobs in browser memory, not streamed as ZIP64 directly to disk. Oversized files are reported; insufficient browser memory can still cause an error.
- Direct history loading is bounded to 1,000 pages, 250,000 message objects, 256 MiB of incoming JSON and eight minutes. Reaching a limit produces partial history with a warning.
- ZIP uses STORE without additional compression. Images, video and existing archives are usually compressed already.
- ChatGPT's read-only HTTP routes are undocumented and may change. Use the official local export if direct loading is unavailable. Access checks are not bypassed.

## Privacy and permissions

The extension has no export server, telemetry or remote code. `activeTab` and `scripting` access the selected conversation after your explicit action; `downloads` saves a local file; `offscreen` builds temporary TXT/ZIP data. There are no permanent `host_permissions`. Optional file-host access is requested only when you choose a direct ZIP action.

A temporary authorization value from your own active ChatGPT session is used only inside the source tab for scoped read-only conversation/file requests. It is never sent to the background worker, file CDN or any other server, and is never included in an archive or log. File hosts receive only an allowed download URL, without authorization headers or cookies. Private download-source URLs are excluded from public archive metadata. Chat content is not stored in `localStorage` or `chrome.storage`; only the UI language preference is remembered.

Read-only contract references: [chatgpt-exporter](https://github.com/pionxzh/chatgpt-exporter/blob/master/src/api.ts), [chatgpt-chat-exporter](https://github.com/rashidazarang/chatgpt-chat-exporter/blob/master/src/extraction-engine.js). This package contains neither extension's code and does not require them.

## Build from source

Use Python 3.9 or later; only the standard library is required:

```sh
python build.py
python build.py --output ./release
```

The builder reads the explicit extension allowlist, both READMEs, `LICENSE` and the four BAT helpers from this repository. It creates a versioned Windows package folder, ZIP and `.sha256` file in `dist/` by default. Existing output is refused. It does not access ChatGPT or execute the extension.

Release preparation covers source syntax and package metadata/integrity. End-to-end Chrome/Edge and Windows execution have not been performed; availability of each attachment type in a real account is not verified.

## License

[MIT](LICENSE).
