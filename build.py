#!/usr/bin/env python3
"""Build a Windows unpacked-extension package using only the standard library."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent
NAME = "GoodogChatExport-Windows"
FILES = [
    "manifest.json", "background.js", "offscreen.html", "offscreen.js",
    "i18n.js", "exporter.js", "conversation-data.js", "archive-data.js",
    "archive-builder.js", "zip-store.js", "json-worker.js", "popup.html",
    "popup.css", "popup.js", "markdown-renderer.js", "vendor/marked.umd.js",
    "vendor/marked-LICENSE.txt", "icons/icon16.png", "icons/icon32.png",
    "icons/icon48.png", "icons/icon128.png",
]
HELPERS = ["Install-Chrome.bat", "Install-Edge.bat", "Установить-Chrome.bat", "Установить-Edge.bat"]
DOCS = ["README.md", "README.ru.md"]


def windows_text(text, *, bom=False):
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    return (("\ufeff" if bom else "") + text.replace("\n", "\r\n")).encode("utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist", help="Output directory (default: dist/ next to build.py)")
    args = parser.parse_args()
    required = [ROOT / "extension" / name for name in FILES]
    required += [ROOT / name for name in DOCS + HELPERS + ["LICENSE"]]
    for path in required:
        if not path.is_file():
            parser.error(f"Missing build input: {path.relative_to(ROOT)}")

    manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    version = manifest.get("version", "")
    if not isinstance(version, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", version):
        parser.error("The extension manifest must contain a valid numeric version")
    if manifest.get("manifest_version") != 3:
        parser.error("Expected a Manifest V3 extension")

    output = args.output.expanduser().resolve()
    package_name = f"{NAME}-{version}"
    folder = output / package_name
    archive = output / f"{package_name}.zip"
    checksum = output / f"{package_name}.zip.sha256"
    if any(path.exists() for path in [folder, archive, checksum]):
        parser.error("Package output already exists; choose another output directory or remove it explicitly")
    output.mkdir(parents=True, exist_ok=True)
    (folder / "extension").mkdir(parents=True)
    for name in FILES:
        destination = folder / "extension" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / "extension" / name, destination)
    shutil.copyfile(ROOT / "LICENSE", folder / "LICENSE")
    english = (ROOT / "README.md").read_text(encoding="utf-8-sig")
    russian = (ROOT / "README.ru.md").read_text(encoding="utf-8-sig")
    for name, text in [("README.txt", english), ("README-EN.txt", english), ("README-RU.txt", russian)]:
        (folder / name).write_bytes(windows_text(text, bom=True))
    for name in HELPERS:
        text = (ROOT / name).read_text(encoding="utf-8-sig")
        (folder / name).write_bytes(windows_text(text))

    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zipped:
        for source in sorted(folder.rglob("*")):
            if source.is_file():
                zipped.write(source, Path(package_name) / source.relative_to(folder))
    digest = hashlib.sha256()
    with archive.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    checksum.write_text(f"{digest.hexdigest()}  {archive.name}\n", encoding="ascii")
    print(f"Created {archive.name} and {checksum.name}")


if __name__ == "__main__":
    main()
