import json
import mimetypes
import os
import re
import signal
import subprocess
import sys
import time
import uuid
from email.parser import BytesParser
from email.policy import default
from html import escape
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = BASE_DIR / "uploads"
DATA_FILE = DATA_DIR / "images.json"
WATCHED_SUFFIXES = {".py", ".html", ".css", ".js", ".json"}


def ensure_storage():
    DATA_DIR.mkdir(exist_ok=True)
    UPLOAD_DIR.mkdir(exist_ok=True)

    if DATA_FILE.exists():
        return

    sample_items = [
        {
            "id": str(uuid.uuid4()),
            "title": "Untitled I",
            "description": "Placeholder description for this drawing.",
            "tags": [],
            "image_path": "/uploads/sample-1.svg"
        },
        {
            "id": str(uuid.uuid4()),
            "title": "Untitled II",
            "description": "Placeholder description for this drawing.",
            "tags": [],
            "image_path": "/uploads/sample-2.svg"
        },
        {
            "id": str(uuid.uuid4()),
            "title": "Untitled III",
            "description": "Placeholder description for this drawing.",
            "tags": [],
            "image_path": "/uploads/sample-3.svg"
        },
        {
            "id": str(uuid.uuid4()),
            "title": "Untitled IV",
            "description": "Placeholder description for this drawing.",
            "tags": [],
            "image_path": "/uploads/sample-4.svg"
        }
    ]

    for index, item in enumerate(sample_items, start=1):
        sample_path = UPLOAD_DIR / f"sample-{index}.svg"
        sample_path.write_text(build_sample_svg(index), encoding="utf-8")

    # Write directly to avoid recursion with save_images
    with DATA_FILE.open("w", encoding="utf-8") as handle:
        json.dump(sample_items, handle, indent=4)


def build_sample_svg(index):
    number = escape(str(index))
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 900">
    <rect width="900" height="900" fill="white"/>
    <rect x="90" y="90" width="720" height="720" fill="none" stroke="black" stroke-width="8"/>
    <text x="450" y="470" text-anchor="middle" font-family="EB Garamond, serif" font-size="96" fill="black">Drawing {number}</text>
</svg>
"""


def load_images():
    ensure_storage()
    with DATA_FILE.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def save_images(images):
    # No ensure_storage() call here — calling it would cause infinite recursion
    with DATA_FILE.open("w", encoding="utf-8") as handle:
        json.dump(images, handle, indent=4)


def image_payload(item):
    image_urls = item.get("image_paths")

    if not isinstance(image_urls, list):
        image_urls = [item["image_path"]]

    return {
        "id": item["id"],
        "title": item["title"],
        "description": item.get("description", ""),
        "tags": item.get("tags", []),
        "image_url": image_urls[0],
        "image_urls": image_urls
    }


def sanitize_filename(filename):
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", filename or "image")
    cleaned = cleaned.strip(".-") or "image"
    return cleaned


def parse_json_body(handler):
    length = int(handler.headers.get("Content-Length", "0") or "0")
    body = handler.rfile.read(length) if length else b"{}"
    return json.loads(body.decode("utf-8"))


def normalize_tags(value):
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            parsed = value.split(",")
    else:
        parsed = value

    if not isinstance(parsed, list):
        return []

    tags = []
    seen = set()

    for item in parsed:
        tag = re.sub(r"\s+", " ", str(item).strip())

        if not tag:
            continue

        key = tag.lower()

        if key in seen:
            continue

        seen.add(key)
        tags.append(tag)

    return tags


def parse_multipart_form(handler):
    length = int(handler.headers.get("Content-Length", "0") or "0")
    body = handler.rfile.read(length) if length else b""
    content_type = handler.headers.get("Content-Type", "")
    raw_message = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + body
    message = BytesParser(policy=default).parsebytes(raw_message)
    fields = {}

    for part in message.iter_parts():
        disposition = part.get("Content-Disposition", "")
        if "form-data" not in disposition:
            continue

        name = part.get_param("name", header="Content-Disposition")
        filename = part.get_filename()
        payload = part.get_payload(decode=True) or b""

        if filename:
            value = {
                "filename": filename,
                "content": payload
            }
        else:
            value = payload.decode("utf-8").strip()

        if name in fields:
            if isinstance(fields[name], list):
                fields[name].append(value)
            else:
                fields[name] = [fields[name], value]
        else:
            fields[name] = value

    return fields


def iter_watched_files():
    for path in BASE_DIR.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() not in WATCHED_SUFFIXES:
            continue
        if path.parent == UPLOAD_DIR:
            continue
        yield path


def snapshot_files():
    snapshot = {}

    for path in iter_watched_files():
        try:
            snapshot[str(path)] = path.stat().st_mtime_ns
        except FileNotFoundError:
            continue

    return snapshot


class AppHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/" or path == "/index.html":
            return self.serve_file(BASE_DIR / "index.html")
        if path == "/dashboard" or path == "/dashboard.html":
            return self.serve_file(BASE_DIR / "dashboard.html")
        if path == "/api/images":
            return self.send_json([image_payload(item) for item in load_images()])
        if path.startswith("/css/") or path.startswith("/js/") or path.startswith("/uploads/") or path.startswith("/data/"):
            return self.serve_file(BASE_DIR / path.lstrip("/"))

        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/images":
            return self.create_image()
        if path == "/api/images/reorder":
            return self.reorder_images()
        if path.endswith("/move"):
            image_id = path.split("/")[-2]
            return self.move_image(image_id)

        self.send_error(HTTPStatus.NOT_FOUND)

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/images/"):
            image_id = path.rsplit("/", 1)[-1]
            return self.update_image(image_id)

        self.send_error(HTTPStatus.NOT_FOUND)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/images/"):
            image_id = path.rsplit("/", 1)[-1]
            return self.delete_image(image_id)

        self.send_error(HTTPStatus.NOT_FOUND)

    def create_image(self):
        form = parse_multipart_form(self)
        uploads = form.get("image")

        if isinstance(uploads, dict):
            uploads = [uploads]

        if not isinstance(uploads, list) or not uploads:
            return self.send_json({"error": "Image is required."}, status=HTTPStatus.BAD_REQUEST)

        if not all(isinstance(upload, dict) and upload.get("filename") for upload in uploads):
            return self.send_json({"error": "Image is required."}, status=HTTPStatus.BAD_REQUEST)

        title = str(form.get("title", "")).strip()
        description = str(form.get("description", "")).strip()
        tags = normalize_tags(form.get("tags", "[]"))

        if not title:
            return self.send_json({"error": "Title is required."}, status=HTTPStatus.BAD_REQUEST)

        image_paths = []

        for upload in uploads:
            extension = Path(upload["filename"]).suffix.lower() or ".bin"
            filename = f"{uuid.uuid4().hex}-{sanitize_filename(Path(upload['filename']).stem)}{extension}"
            target = UPLOAD_DIR / filename

            with target.open("wb") as handle:
                handle.write(upload["content"])

            image_paths.append(f"/uploads/{filename}")

        images = load_images()
        item = {
            "id": str(uuid.uuid4()),
            "title": title,
            "description": description,
            "tags": tags,
            "image_path": image_paths[0]
        }

        if len(image_paths) > 1:
            item["image_paths"] = image_paths

        images.append(item)
        save_images(images)
        self.send_json(image_payload(item), status=HTTPStatus.CREATED)

    def update_image(self, image_id):
        payload = parse_json_body(self)
        title = str(payload.get("title", "")).strip()
        description = str(payload.get("description", "")).strip()
        tags = normalize_tags(payload.get("tags", []))
        image_urls = payload.get("image_urls")

        if not title:
            return self.send_json({"error": "Title is required."}, status=HTTPStatus.BAD_REQUEST)

        images = load_images()

        for item in images:
            if item["id"] == image_id:
                item["title"] = title
                item["description"] = description
                item["tags"] = tags

                if isinstance(image_urls, list) and image_urls:
                    normalized_urls = [str(url) for url in image_urls if str(url).startswith("/uploads/")]

                    if normalized_urls:
                        item["image_path"] = normalized_urls[0]

                        if len(normalized_urls) > 1:
                            item["image_paths"] = normalized_urls
                        else:
                            item.pop("image_paths", None)

                save_images(images)
                return self.send_json(image_payload(item))

        self.send_json({"error": "Image not found."}, status=HTTPStatus.NOT_FOUND)

    def delete_image(self, image_id):
        images = load_images()

        for index, item in enumerate(images):
            if item["id"] != image_id:
                continue

            image_paths = item.get("image_paths")

            if not isinstance(image_paths, list):
                image_paths = [item["image_path"]]

            for image_path in image_paths:
                file_path = BASE_DIR / image_path.lstrip("/")

                if file_path.exists() and file_path.parent == UPLOAD_DIR:
                    file_path.unlink()

            deleted = images.pop(index)
            save_images(images)
            return self.send_json(image_payload(deleted))

        self.send_json({"error": "Image not found."}, status=HTTPStatus.NOT_FOUND)

    def move_image(self, image_id):
        payload = parse_json_body(self)
        direction = payload.get("direction")
        images = load_images()

        for index, item in enumerate(images):
            if item["id"] != image_id:
                continue

            if direction == "up" and index > 0:
                images[index - 1], images[index] = images[index], images[index - 1]
            elif direction == "down" and index < len(images) - 1:
                images[index + 1], images[index] = images[index], images[index + 1]

            save_images(images)
            return self.send_json([image_payload(image) for image in images])

        self.send_json({"error": "Image not found."}, status=HTTPStatus.NOT_FOUND)

    def reorder_images(self):
        payload = parse_json_body(self)
        ordered_ids = payload.get("ids")

        if not isinstance(ordered_ids, list):
            return self.send_json({"error": "Invalid order."}, status=HTTPStatus.BAD_REQUEST)

        images = load_images()
        image_map = {item["id"]: item for item in images}

        if set(ordered_ids) != set(image_map):
            return self.send_json({"error": "Invalid order."}, status=HTTPStatus.BAD_REQUEST)

        reordered = [image_map[item_id] for item_id in ordered_ids]
        save_images(reordered)
        self.send_json([image_payload(image) for image in reordered])

    def serve_file(self, path):
        resolved = path.resolve()

        if not resolved.exists() or not str(resolved).startswith(str(BASE_DIR)):
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        mime_type, _ = mimetypes.guess_type(str(resolved))
        content_type = mime_type or "application/octet-stream"

        with resolved.open("rb") as handle:
            data = handle.read()

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def run():
    ensure_storage()
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), AppHandler)
    print(f"Serving on http://127.0.0.1:{port}")
    server.serve_forever()


def run_with_reloader():
    env = os.environ.copy()
    env["APP_RELOAD_CHILD"] = "1"
    previous = snapshot_files()

    while True:
        child = subprocess.Popen([sys.executable, __file__], env=env)

        try:
            while child.poll() is None:
                time.sleep(0.5)
                current = snapshot_files()
                if current != previous:
                    previous = current
                    child.send_signal(signal.SIGTERM)
                    child.wait()
                    break
            else:
                return child.returncode
        except KeyboardInterrupt:
            child.send_signal(signal.SIGTERM)
            child.wait()
            return 0


if __name__ == "__main__":
    if os.environ.get("APP_RELOAD_CHILD") == "1":
        run()
    else:
        raise SystemExit(run_with_reloader())