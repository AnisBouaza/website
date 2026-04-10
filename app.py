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
TAGS_FILE = DATA_DIR / "tags.json"
WATCHED_SUFFIXES = {".py", ".html", ".css", ".js", ".json"}


# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------

def ensure_storage():
    DATA_DIR.mkdir(exist_ok=True)
    UPLOAD_DIR.mkdir(exist_ok=True)

    if not TAGS_FILE.exists():
        write_json(TAGS_FILE, [])

    if DATA_FILE.exists():
        return

    sample_items = [
        {
            "id": str(uuid.uuid4()),
            "title": f"Untitled {label}",
            "description": "Placeholder description for this drawing.",
            "tags": [],
            "image_path": f"/uploads/sample-{index}.svg",
        }
        for index, label in enumerate(["I", "II", "III", "IV"], start=1)
    ]

    for index in range(1, 5):
        (UPLOAD_DIR / f"sample-{index}.svg").write_text(
            build_sample_svg(index), encoding="utf-8"
        )

    write_json(DATA_FILE, sample_items)


def write_json(path, data):
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=4)


def read_json(path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def build_sample_svg(index):
    number = escape(str(index))
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 900">\n'
        f'  <rect width="900" height="900" fill="white"/>\n'
        f'  <rect x="90" y="90" width="720" height="720" fill="none" '
        f'stroke="black" stroke-width="8"/>\n'
        f'  <text x="450" y="470" text-anchor="middle" '
        f'font-family="EB Garamond, serif" font-size="96" '
        f'fill="black">Drawing {number}</text>\n'
        f"</svg>\n"
    )


# ---------------------------------------------------------------------------
# Image helpers
# ---------------------------------------------------------------------------

def load_images():
    ensure_storage()
    return read_json(DATA_FILE)


def save_images(images):
    write_json(DATA_FILE, images)


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
        "image_urls": image_urls,
    }


# ---------------------------------------------------------------------------
# Tag library helpers
# ---------------------------------------------------------------------------

def load_tags():
    ensure_storage()
    return read_json(TAGS_FILE)


def save_tags(tags):
    write_json(TAGS_FILE, tags)


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

def sanitize_filename(filename):
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", filename or "image")
    return cleaned.strip(".-") or "image"


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

    tags, seen = [], set()

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
    raw = (
        f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode()
        + body
    )
    message = BytesParser(policy=default).parsebytes(raw)
    fields = {}

    for part in message.iter_parts():
        disposition = part.get("Content-Disposition", "")
        if "form-data" not in disposition:
            continue

        name = part.get_param("name", header="Content-Disposition")
        filename = part.get_filename()
        payload = part.get_payload(decode=True) or b""

        value = (
            {"filename": filename, "content": payload}
            if filename
            else payload.decode("utf-8").strip()
        )

        if name in fields:
            existing = fields[name]
            fields[name] = (
                existing + [value] if isinstance(existing, list) else [existing, value]
            )
        else:
            fields[name] = value

    return fields


# ---------------------------------------------------------------------------
# File watcher (dev reload)
# ---------------------------------------------------------------------------

def iter_watched_files():
    for path in BASE_DIR.rglob("*"):
        if (
            path.is_file()
            and path.suffix.lower() in WATCHED_SUFFIXES
            and path.parent != UPLOAD_DIR
        ):
            yield path


def snapshot_files():
    snapshot = {}
    for path in iter_watched_files():
        try:
            snapshot[str(path)] = path.stat().st_mtime_ns
        except FileNotFoundError:
            continue
    return snapshot


# ---------------------------------------------------------------------------
# Request handler
# ---------------------------------------------------------------------------

class AppHandler(BaseHTTPRequestHandler):

    # -- Routing -------------------------------------------------------------

    def do_GET(self):
        path = urlparse(self.path).path

        routes = {
            "/": BASE_DIR / "index.html",
            "/index.html": BASE_DIR / "index.html",
            "/dashboard": BASE_DIR / "dashboard.html",
            "/dashboard.html": BASE_DIR / "dashboard.html",
        }

        if path in routes:
            return self.serve_file(routes[path])

        if path == "/api/images":
            return self.send_json(
                [image_payload(item) for item in load_images()]
            )

        if path == "/api/tags":
            return self.send_json(load_tags())

        if path.startswith(("/css/", "/js/", "/uploads/", "/data/")):
            return self.serve_file(BASE_DIR / path.lstrip("/"))

        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        path = urlparse(self.path).path

        if path == "/api/images":
            return self.create_image()
        if path == "/api/images/reorder":
            return self.reorder_images()
        if path == "/api/tags":
            return self.create_tag()
        if path.endswith("/move"):
            return self.move_image(path.split("/")[-2])

        self.send_error(HTTPStatus.NOT_FOUND)

    def do_PUT(self):
        path = urlparse(self.path).path

        if path.startswith("/api/images/"):
            return self.update_image(path.rsplit("/", 1)[-1])

        self.send_error(HTTPStatus.NOT_FOUND)

    def do_DELETE(self):
        path = urlparse(self.path).path

        if path.startswith("/api/tags/"):
            return self.delete_tag(path.rsplit("/", 1)[-1])
        if path.startswith("/api/images/"):
            return self.delete_image(path.rsplit("/", 1)[-1])

        self.send_error(HTTPStatus.NOT_FOUND)

    # -- Image CRUD ----------------------------------------------------------

    def create_image(self):
        form = parse_multipart_form(self)
        uploads = form.get("image")

        if isinstance(uploads, dict):
            uploads = [uploads]
        if not isinstance(uploads, list) or not uploads:
            return self.send_json(
                {"error": "Image is required."}, status=HTTPStatus.BAD_REQUEST
            )
        if not all(
            isinstance(u, dict) and u.get("filename") for u in uploads
        ):
            return self.send_json(
                {"error": "Image is required."}, status=HTTPStatus.BAD_REQUEST
            )

        title = str(form.get("title", "")).strip()
        description = str(form.get("description", "")).strip()
        tags = normalize_tags(form.get("tags", "[]"))

        if not title:
            return self.send_json(
                {"error": "Title is required."}, status=HTTPStatus.BAD_REQUEST
            )

        image_paths = []
        for upload in uploads:
            ext = Path(upload["filename"]).suffix.lower() or ".bin"
            stem = sanitize_filename(Path(upload["filename"]).stem)
            filename = f"{uuid.uuid4().hex}-{stem}{ext}"
            target = UPLOAD_DIR / filename
            target.write_bytes(upload["content"])
            image_paths.append(f"/uploads/{filename}")

        images = load_images()
        item = {
            "id": str(uuid.uuid4()),
            "title": title,
            "description": description,
            "tags": tags,
            "image_path": image_paths[0],
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
            return self.send_json(
                {"error": "Title is required."}, status=HTTPStatus.BAD_REQUEST
            )

        images = load_images()

        for item in images:
            if item["id"] != image_id:
                continue

            item["title"] = title
            item["description"] = description
            item["tags"] = tags

            if isinstance(image_urls, list) and image_urls:
                valid = [
                    str(u) for u in image_urls if str(u).startswith("/uploads/")
                ]
                if valid:
                    item["image_path"] = valid[0]
                    if len(valid) > 1:
                        item["image_paths"] = valid
                    else:
                        item.pop("image_paths", None)

            save_images(images)
            return self.send_json(image_payload(item))

        self.send_json(
            {"error": "Image not found."}, status=HTTPStatus.NOT_FOUND
        )

    def delete_image(self, image_id):
        images = load_images()

        for index, item in enumerate(images):
            if item["id"] != image_id:
                continue

            paths = item.get("image_paths")
            if not isinstance(paths, list):
                paths = [item["image_path"]]

            for p in paths:
                fp = BASE_DIR / p.lstrip("/")
                if fp.exists() and fp.parent == UPLOAD_DIR:
                    fp.unlink()

            deleted = images.pop(index)
            save_images(images)
            return self.send_json(image_payload(deleted))

        self.send_json(
            {"error": "Image not found."}, status=HTTPStatus.NOT_FOUND
        )

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
            return self.send_json(
                [image_payload(img) for img in images]
            )

        self.send_json(
            {"error": "Image not found."}, status=HTTPStatus.NOT_FOUND
        )

    def reorder_images(self):
        payload = parse_json_body(self)
        ordered_ids = payload.get("ids")

        if not isinstance(ordered_ids, list):
            return self.send_json(
                {"error": "Invalid order."}, status=HTTPStatus.BAD_REQUEST
            )

        images = load_images()
        image_map = {item["id"]: item for item in images}

        if set(ordered_ids) != set(image_map):
            return self.send_json(
                {"error": "Invalid order."}, status=HTTPStatus.BAD_REQUEST
            )

        reordered = [image_map[i] for i in ordered_ids]
        save_images(reordered)
        self.send_json([image_payload(img) for img in reordered])

    # -- Tag library CRUD ---------------------------------------------------

    def create_tag(self):
        payload = parse_json_body(self)
        name = re.sub(r"\s+", " ", str(payload.get("name", "")).strip())

        if not name:
            return self.send_json(
                {"error": "Tag name is required."}, status=HTTPStatus.BAD_REQUEST
            )

        tags = load_tags()

        if any(t.lower() == name.lower() for t in tags):
            return self.send_json(
                {"error": "Tag already exists."}, status=HTTPStatus.CONFLICT
            )

        tags.append(name)
        save_tags(tags)
        self.send_json(tags, status=HTTPStatus.CREATED)

    def delete_tag(self, tag_name):
        from urllib.parse import unquote
        name = unquote(tag_name)
        tags = load_tags()
        lower = name.lower()
        updated = [t for t in tags if t.lower() != lower]

        if len(updated) == len(tags):
            return self.send_json(
                {"error": "Tag not found."}, status=HTTPStatus.NOT_FOUND
            )

        save_tags(updated)
        self.send_json(updated)

    # -- Static files / JSON response ----------------------------------------

    def serve_file(self, path):
        resolved = path.resolve()

        if not resolved.exists() or not str(resolved).startswith(str(BASE_DIR)):
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        mime_type, _ = mimetypes.guess_type(str(resolved))
        data = resolved.read_bytes()

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime_type or "application/octet-stream")
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


# ---------------------------------------------------------------------------
# Server entry
# ---------------------------------------------------------------------------

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
