#!/usr/bin/env python3
"""Native messaging host for dev.firstpick.ytdlp_downloader.

YTDLP_HOST_YTDLP overrides executable discovery, primarily for subprocess tests.
It is one executable path, never a shell command or a list of extra arguments.
"""

import collections
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import struct
import subprocess
import sys
import threading
import uuid
from urllib.parse import urlsplit


HOST_VERSION = "1.2.0"
MAX_CONCURRENT = 2
MAX_MESSAGE_BYTES = 1024 * 1024
# Firefox rejects host messages over 1 MB; a long playlist's path list could exceed it.
MAX_REPORTED_FILES = 100
STAGING_DIR_NAME = ".ytdlp-downloader-staging"
PROGRESS_PREFIX = "__YTDLP_PROGRESS__"
FILE_PREFIX = "__YTDLP_FILE__"
PROGRESS_TEMPLATE = (
    PROGRESS_PREFIX + '{"progress":%(progress)j,"title":%(info.title|null)j,'
    '"playlistIndex":%(info.playlist_index|null)j,'
    '"playlistCount":%(info.playlist_count|null)j}'
)
FILE_TEMPLATE = FILE_PREFIX + "%(filepath)j"
DEFAULT_OPTIONS = {
    "mode": "video", "videoResolution": "best", "videoFormat": "any",
    "audioQuality": "best", "audioFormat": "best", "saveDir": "",
    "playlist": False,
}
ENUMS = {
    "mode": {"video", "audio"},
    "videoResolution": {"best", "2160", "1440", "1080", "720", "480", "360"},
    "videoFormat": {"any", "mp4", "webm", "mkv"},
    "audioQuality": {"best", "320", "256", "192", "128", "96"},
    "audioFormat": {"best", "mp3", "m4a", "opus", "flac", "wav"},
}


class HostError(Exception):
    """An error safe to return to the extension with its protocol code."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def read_exact(stream, size):
    """Read size bytes, returning None only on clean EOF before any bytes."""
    chunks = bytearray()
    while len(chunks) < size:
        part = stream.read(size - len(chunks))
        if not part:
            if not chunks:
                return None
            raise HostError("bad_request", "Truncated native message.")
        chunks.extend(part)
    return bytes(chunks)


def read_message(stream):
    """Read one native-endian framed JSON object, or None on clean EOF."""
    header = read_exact(stream, 4)
    if header is None:
        return None
    size = struct.unpack("=I", header)[0]
    if not 0 < size <= MAX_MESSAGE_BYTES:
        raise HostError("bad_request", "Native message size is invalid.")
    body = read_exact(stream, size)
    if body is None:
        raise HostError("bad_request", "Missing native message body.")
    try:
        message = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise HostError("bad_request", "Native message must be UTF-8 JSON.") from exc
    if not isinstance(message, dict):
        raise HostError("bad_request", "Native message must be an object.")
    return message


def encode_message(message):
    """Encode one JSON message in the browser's native messaging framing."""
    body = json.dumps(message, ensure_ascii=False, allow_nan=False).encode("utf-8")
    return struct.pack("=I", len(body)) + body


def validate_url(url):
    """Return an HTTP(S) URL with a host or raise invalid_url."""
    if not isinstance(url, str) or not url or any(ord(c) < 33 for c in url):
        raise HostError("invalid_url", "URL must be an HTTP or HTTPS URL.")
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("missing scheme or host")
        parsed.port
    except ValueError as exc:
        raise HostError("invalid_url", "URL must be an HTTP or HTTPS URL with a host.") from exc
    return url


def normalize_path(value, default=None):
    """Expand ~ and normalize an absolute path without accessing the filesystem."""
    if not isinstance(value, str) or any(ord(c) < 32 for c in value):
        raise HostError("invalid_path", "Path must be a string without control characters.")
    value = value or default
    if not value:
        raise HostError("invalid_path", "An absolute path is required.")
    expanded = os.path.expanduser(value)
    if not os.path.isabs(expanded):
        raise HostError("invalid_path", "Path must be absolute after expanding ~.")
    return os.path.normpath(expanded)


def validate_options(options, default_dir):
    """Return a validated defaults-merged copy; do not create directories."""
    if not isinstance(options, dict):
        raise HostError("bad_request", "options must be an object.")
    unknown = set(options) - set(DEFAULT_OPTIONS)
    if unknown:
        raise HostError("bad_request", "Unknown option: " + str(sorted(unknown)[0]))
    result = {**DEFAULT_OPTIONS, **options}
    for key, values in ENUMS.items():
        if not isinstance(result[key], str) or result[key] not in values:
            raise HostError("bad_request", "Invalid " + key + ".")
    if type(result["playlist"]) is not bool:
        raise HostError("bad_request", "playlist must be a boolean.")
    result["saveDir"] = normalize_path(result["saveDir"], default_dir)
    return result


def build_argv(binary, url, options, staging_dir):
    """Build yt-dlp argv from already validated options; URL is always after --.

    yt-dlp writes into staging_dir, not saveDir: two jobs with the same title would
    otherwise share .part files, and -x would delete a finished video of the same name.
    """
    output = "%(title)s [%(id)s].%(ext)s"
    if options["playlist"]:
        output = "%(playlist_title)s/%(playlist_index)03d - " + output
    # Ignore ambient config so it cannot replace the protocol's templates or args.
    argv = [binary, "--ignore-config", "--newline", "--progress", "--color", "never",
            "--no-simulate", "-P", staging_dir, "-o", output,
            "--progress-template", "download:" + PROGRESS_TEMPLATE,
            "--progress-template", "postprocess:" + PROGRESS_TEMPLATE,
            "--print", "after_move:" + FILE_TEMPLATE,
            "--yes-playlist" if options["playlist"] else "--no-playlist"]
    runtime = find_js_runtime()
    if runtime:
        argv += ["--js-runtimes", f'{runtime["name"]}:{runtime["path"]}']
    if options["mode"] == "video":
        argv += ["-f", "bv*+ba/b"]
        sort = []
        if options["videoResolution"] != "best":
            sort.append("res:" + options["videoResolution"])
        fmt = options["videoFormat"]
        if fmt in {"mp4", "webm"}:
            sort.append("ext:mp4:m4a" if fmt == "mp4" else "ext:webm:webm")
        if sort:
            argv += ["-S", ",".join(sort)]
        if fmt != "any":
            argv += ["--merge-output-format", fmt]
    else:
        argv += ["-f", "ba/b", "-x"]
        if options["audioFormat"] != "best":
            argv += ["--audio-format", options["audioFormat"]]
        quality = options["audioQuality"]
        argv += ["--audio-quality", "0" if quality == "best" else quality + "K"]
    return argv + ["--", url]


def unique_destination(path):
    """Return path, or the first free "name (n).ext" sibling if it already exists."""
    if not os.path.lexists(path):
        return path
    stem, ext = os.path.splitext(path)
    n = 2
    while os.path.lexists(f"{stem} ({n}){ext}"):
        n += 1
    return f"{stem} ({n}){ext}"


def publish_files(files, staging_dir, save_dir):
    """Move finished files from staging into save_dir without overwriting; return final paths."""
    published = []
    for path in files:
        relative = os.path.relpath(path, staging_dir)
        if relative.startswith(os.pardir) or not os.path.exists(path):
            published.append(path)
            continue
        destination = unique_destination(os.path.join(save_dir, relative))
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        os.replace(path, destination)
        published.append(destination)
    return published


def remove_staging(staging_dir):
    """Delete a job's staging dir and the shared parent once it is empty."""
    shutil.rmtree(staging_dir, ignore_errors=True)
    try:
        os.rmdir(os.path.dirname(staging_dir))
    except OSError:
        pass


def failure_message(lines, returncode):
    """Prefer yt-dlp ERROR lines over trailing WARNING noise."""
    errors = [line for line in lines if line.startswith("ERROR")]
    return "\n".join(errors or lines) or "yt-dlp exited with code " + str(returncode)


def positive_int(value):
    """Return a positive playlist integer, treating missing template values as null."""
    return value if type(value) is int and value > 0 else None


def progress_text(value):
    """Normalize yt-dlp's padded display fields and missing-value placeholders."""
    if (not isinstance(value, str) or value.strip() in {"", "NA", "N/A"}
            or value.strip().startswith("Unknown")):
        return None
    return value.strip()


def parse_progress_line(line):
    """Return protocol progress fields for a marked JSON line, otherwise None."""
    if not line.startswith(PROGRESS_PREFIX):
        return None
    try:
        data = json.loads(line[len(PROGRESS_PREFIX):])
        progress = data["progress"]
        if not isinstance(progress, dict):
            return None
        percent = None
        display = progress.get("_percent_str")
        if isinstance(display, str):
            match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)%\s*", display)
            if match:
                percent = float(match.group(1))
        if percent is None:
            downloaded = progress.get("downloaded_bytes")
            total = progress.get("total_bytes") or progress.get("total_bytes_estimate")
            if (type(downloaded) in (int, float) and type(total) in (int, float)
                    and total > 0):
                percent = 100.0 * downloaded / total
        if percent is not None:
            percent = min(100.0, max(0.0, percent)) if math.isfinite(percent) else None
        return {
            "status": "downloading" if progress.get("status") == "downloading" else "processing",
            "percent": percent,
            "speed": progress_text(progress.get("_speed_str")),
            "eta": progress_text(progress.get("_eta_str")),
            "title": data.get("title") if isinstance(data.get("title"), str) else None,
            "playlistIndex": positive_int(data.get("playlistIndex")),
            "playlistCount": positive_int(data.get("playlistCount")),
        }
    except (ValueError, KeyError, TypeError, OverflowError):
        return None


def parse_file_line(line):
    """Return an absolute final path from an after_move JSON line, otherwise None."""
    if line.startswith(FILE_PREFIX):
        try:
            value = json.loads(line[len(FILE_PREFIX):])
            if isinstance(value, str) and os.path.isabs(value):
                return value
        except ValueError:
            pass
    return None


def find_ytdlp():
    """Find yt-dlp, honoring the test override and reduced browser PATHs."""
    override = os.environ.get("YTDLP_HOST_YTDLP")
    if override:
        return shutil.which(override)
    binary = shutil.which("yt-dlp")
    fallback = Path.home() / ".local/bin/yt-dlp"
    if not binary and fallback.is_file() and os.access(fallback, os.X_OK):
        binary = str(fallback)
    return binary


# yt-dlp's minimum Node for its YouTube challenge solver.
NODE_MIN_MAJOR = 22


def runtime_candidates(name):
    """Yield executable paths for name: PATH first, then per-user install locations.

    The browser may start the helper with a short PATH, so common user-level
    install directories (including nvm's newest version and Volta) are searched too.
    """
    binary = shutil.which(name)
    if binary:
        yield os.path.abspath(binary)
    home = Path.home()
    directories = [home / ".local/bin", home / ".deno/bin", home / ".volta/bin"]
    directories += sorted((home / ".nvm/versions/node").glob("*/bin"), reverse=True)
    for directory in directories:
        candidate = directory / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            yield str(candidate)


def node_major(path):
    """Return Node's major version from `node --version`, or None if it can't be read."""
    try:
        result = subprocess.run([path, "--version"], capture_output=True, text=True,
                                timeout=3, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    match = re.fullmatch(r"v(\d+)\.\d+\.\d+.*", result.stdout.strip())
    return int(match[1]) if result.returncode == 0 and match else None


def find_js_runtime():
    """Return Deno (yt-dlp's default), else Node >= NODE_MIN_MAJOR, else None.

    Bun is left out on purpose: yt-dlp deprecated it and it runs YouTube's
    challenge script without any sandbox. Deno's development ends around
    October 2027; when yt-dlp picks a new default, change the order here.
    """
    for path in runtime_candidates("deno"):
        return {"name": "deno", "path": path}
    for path in runtime_candidates("node"):
        if (node_major(path) or 0) >= NODE_MIN_MAJOR:
            return {"name": "node", "path": path}
    return None


def default_save_dir(timeout=3):
    """Resolve the XDG download directory, falling back to ~/Downloads."""
    binary = shutil.which("xdg-user-dir")
    if binary:
        try:
            result = subprocess.run([binary, "DOWNLOAD"], capture_output=True,
                                    text=True, timeout=timeout, check=False)
            if result.returncode == 0 and result.stdout.strip():
                return normalize_path(result.stdout.strip())
        except (OSError, subprocess.TimeoutExpired, HostError):
            pass
    return str(Path.home() / "Downloads")


def find_picker():
    """Return the first installed supported native folder picker."""
    return next((name for name in ("zenity", "kdialog", "yad") if shutil.which(name)), None)


def find_native_messaging_proxy():
    """Find the proxy even when the browser supplies a reduced PATH."""
    binary = shutil.which("xdg-native-messaging-proxy")
    if binary:
        return binary
    for location in ("/usr/libexec/xdg-native-messaging-proxy",
                     "/usr/lib/xdg-native-messaging-proxy",
                     "/usr/lib/xdg-native-messaging-proxy/xdg-native-messaging-proxy"):
        candidate = Path(location)
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return location
    return None


def terminate_group(process):
    """Terminate a child session, escalating to SIGKILL after a short grace period."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass
    # The leader may have exited while ffmpeg (or another descendant) survived.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


class Job:
    """One validated queued or running download and its cancellation state."""

    def __init__(self, job_id, url, options, binary):
        self.id = job_id
        self.url = url
        self.options = options
        self.binary = binary
        self.process = None
        self.cancelled = False
        self.terminal = False
        self.staging_dir = os.path.join(options["saveDir"], STAGING_DIR_NAME, uuid.uuid4().hex)


class NativeHost:
    """Own job lifecycle and serialize all messages to a binary output stream."""

    def __init__(self, output):
        self.output = output
        self.output_lock = threading.Lock()
        self.lock = threading.RLock()
        self.jobs = {}
        self.pending = collections.deque()
        self.active = 0
        self.threads = set()
        self.auxiliary = set()
        self.stopping = False
        self._user_dirs_available = shutil.which("xdg-user-dir") is not None
        self.default_dir = default_save_dir()

    def send(self, message):
        """Write and flush an entire frame under one lock; tolerate a closed port."""
        with self.output_lock:
            try:
                self.output.write(encode_message(message))
                self.output.flush()
            except (BrokenPipeError, OSError):
                pass

    def error(self, job_id, code, message, request_id=None):
        """Send a protocol error; request_id ties picker failures to their pickDirectory."""
        payload = {"type": "error", "id": job_id, "code": code, "message": str(message)}
        if request_id is not None:
            payload["requestId"] = request_id
        self.send(payload)

    def start_thread(self, target, *args):
        """Start a tracked task; caller holds the lifecycle lock."""
        def run():
            try:
                target(*args)
            finally:
                with self.lock:
                    self.threads.discard(threading.current_thread())
        thread = threading.Thread(target=run, daemon=True)
        self.threads.add(thread)
        thread.start()

    def ping(self):
        """Answer from a worker thread; yt-dlp --version can take seconds on a cold start."""
        with self.lock:
            self.start_thread(self.send_pong)

    def send_pong(self):
        """Report installed tools and protocol version."""
        binary = find_ytdlp()
        version = None
        if binary:
            try:
                result = subprocess.run([binary, "--version"], capture_output=True,
                                        text=True, timeout=5, check=False)
                if result.returncode == 0:
                    version = result.stdout.strip()
            except (OSError, subprocess.TimeoutExpired):
                pass
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        downloader_name, downloader_path = None, None
        for name in ("curl", "wget"):
            path = shutil.which(name)
            if path:
                downloader_name, downloader_path = name, path
                break
        missing_coreutils = [name for name in ("cat", "mkdir", "install", "rm", "rmdir", "mktemp", "uname")
                             if not shutil.which(name)]
        opener = shutil.which("xdg-open")
        user_dirs = shutil.which("xdg-user-dir")
        with self.lock:
            if bool(user_dirs) != self._user_dirs_available:
                # Reserve room in the 10 s ping budget for yt-dlp and Node probes.
                self.default_dir = default_save_dir(timeout=1)
                self._user_dirs_available = bool(user_dirs)
            default_dir = self.default_dir
        proxy = find_native_messaging_proxy()
        # A host without these markers may still serve a sandboxed browser.
        sandboxed = any(os.environ.get(name) for name in ("FLATPAK_ID", "SNAP", "SNAP_NAME"))
        proxy_applicable = True if sandboxed else None
        self.send({"type": "pong", "hostVersion": HOST_VERSION,
                   "ytDlp": {"found": binary is not None, "path": binary, "version": version},
                   "ffmpeg": {"found": ffmpeg is not None, "path": ffmpeg},
                   "python": {"found": True, "path": sys.executable,
                              "version": ".".join(str(part) for part in sys.version_info[:3]),
                              "supported": sys.version_info >= (3, 8)},
                   "ffprobe": {"found": ffprobe is not None, "path": ffprobe},
                   "downloader": {"found": downloader_path is not None,
                                  "name": downloader_name, "path": downloader_path},
                   "coreutils": {"found": not missing_coreutils, "missing": missing_coreutils},
                   "opener": {"found": opener is not None, "path": opener},
                   "userDirs": {"found": user_dirs is not None, "path": user_dirs},
                   "nativeMessagingProxy": {"found": proxy is not None, "path": proxy,
                                            "applicable": proxy_applicable},
                   "jsRuntime": find_js_runtime(),
                   "defaultSaveDir": default_dir, "picker": find_picker()})

    def submit(self, message):
        """Validate and accept a job, queueing once both slots are occupied."""
        job_id = message.get("id")
        if not isinstance(job_id, str) or not job_id or len(job_id) > 128:
            raise HostError("bad_request", "A nonempty id of at most 128 characters is required.")
        url = validate_url(message.get("url"))
        options = validate_options(message.get("options"), self.default_dir)
        binary = find_ytdlp()
        if not binary:
            raise HostError("ytdlp_missing", "yt-dlp was not found. Install it and reconnect.")
        # Every mapping needs ffmpeg: bv*+ba merges, and -x probes with ffprobe even when copying.
        for tool in ("ffmpeg", "ffprobe"):
            if not shutil.which(tool):
                raise HostError("ffmpeg_missing", tool + " is required for video merging and audio downloads. "
                                "Install the ffmpeg package and reconnect.")
        with self.lock:
            if job_id in self.jobs:
                raise HostError("bad_request", "This download id is already in use.")
            job = Job(job_id, url, options, binary)
            self.jobs[job_id] = job
            self.pending.append(job)
            if self.active >= MAX_CONCURRENT:
                self.send({"type": "queued", "id": job_id})
            self.schedule()

    def schedule(self):
        """Fill free slots; caller holds the lifecycle lock."""
        while not self.stopping and self.pending and self.active < MAX_CONCURRENT:
            job = self.pending.popleft()
            self.active += 1
            self.start_thread(self.download, job)

    def download(self, job):
        """Run yt-dlp, stream progress, and emit exactly one terminal event."""
        stderr_tail = collections.deque(maxlen=8)
        files = []
        finished = None
        stderr_thread = None
        try:
            with self.lock:
                if job.cancelled or self.stopping:
                    return
                try:
                    Path(job.staging_dir).mkdir(parents=True, exist_ok=True)
                except OSError as exc:
                    raise HostError("invalid_path", str(exc)) from exc
                job.process = subprocess.Popen(
                    build_argv(job.binary, job.url, job.options, job.staging_dir),
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True, encoding="utf-8", errors="replace", start_new_session=True,
                )
                self.send({"type": "started", "id": job.id, "saveDir": job.options["saveDir"]})

            def consume(stream, is_stderr):
                with stream:
                    for line in stream:
                        progress = parse_progress_line(line.rstrip("\r\n"))
                        if progress is not None:
                            with self.lock:
                                if not job.cancelled and not self.stopping:
                                    self.send({"type": "progress", "id": job.id, **progress})
                            continue
                        path = parse_file_line(line.rstrip("\r\n")) if not is_stderr else None
                        if path:
                            if path not in files:
                                files.append(path)
                        elif is_stderr and line.strip():
                            stderr_tail.append(line.strip()[-2000:])

            stderr_thread = threading.Thread(target=consume, args=(job.process.stderr, True), daemon=True)
            stderr_thread.start()
            consume(job.process.stdout, False)
            returncode = job.process.wait()
            stderr_thread.join()
            with self.lock:
                if not job.cancelled and not self.stopping:
                    job.terminal = True
                    if returncode == 0:
                        try:
                            published = publish_files(files, job.staging_dir, job.options["saveDir"])
                        except OSError as exc:
                            self.error(job.id, "internal", "Could not move the download: " + str(exc))
                        else:
                            finished = {"type": "finished", "id": job.id,
                                        "files": published[:MAX_REPORTED_FILES],
                                        "fileCount": len(published)}
                    else:
                        self.error(job.id, "ytdlp_failed", failure_message(list(stderr_tail), returncode))
        except HostError as exc:
            with self.lock:
                if not job.cancelled and not self.stopping:
                    job.terminal = True
                    self.error(job.id, exc.code, str(exc))
        except Exception as exc:
            print("download failed: " + str(exc), file=sys.stderr)
            with self.lock:
                if not job.cancelled and not self.stopping:
                    job.terminal = True
                    self.error(job.id, "internal", str(exc))
        finally:
            if job.process is not None:
                if job.process.poll() is None:
                    terminate_group(job.process)
                job.process.wait()
            if stderr_thread is not None:
                stderr_thread.join(timeout=2)
            remove_staging(job.staging_dir)
            with self.lock:
                if job.cancelled and not self.stopping:
                    self.send({"type": "cancelled", "id": job.id})
                elif finished is not None and not self.stopping:
                    self.send(finished)
                self.jobs.pop(job.id, None)
                self.active -= 1
                self.schedule()

    def cancel(self, job_id):
        """Cancel queued jobs immediately or kill the running process group."""
        with self.lock:
            job = self.jobs.get(job_id) if isinstance(job_id, str) else None
            # A process that already exited is about to report finished; don't relabel it.
            if job is None or job.terminal or (job.process is not None and job.process.poll() is not None):
                raise HostError("unknown_id", "No download has this id.")
            if job.cancelled:
                return
            job.cancelled = True
            if job in self.pending:
                self.pending.remove(job)
                del self.jobs[job.id]
                self.send({"type": "cancelled", "id": job.id})
                return
            process = job.process
        if process is not None:
            terminate_group(process)

    def pick_directory(self, message):
        """Launch a native folder picker and return a directory or cancellation."""
        request_id = message.get("requestId")
        if not isinstance(request_id, str) or not request_id:
            raise HostError("bad_request", "pickDirectory needs a requestId.")
        start = normalize_path(message.get("start", ""), self.default_dir)
        picker = find_picker()
        if picker is None:
            raise HostError("no_picker", "Install zenity, kdialog, or yad to choose a folder.")
        if picker == "kdialog":
            argv = [picker, "--getexistingdirectory", start, "--title", "Download folder"]
        else:
            argv = [picker, "--file-selection", "--directory", "--title=Download folder",
                    "--filename=" + start.rstrip("/") + "/"]
        with self.lock:
            self.start_thread(self.run_picker, argv, request_id)

    def run_picker(self, argv, request_id):
        """Track the dialog so a disconnected browser cannot leave it behind."""
        process = None
        try:
            with self.lock:
                if self.stopping:
                    return
                process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                           stderr=subprocess.DEVNULL, text=True, start_new_session=True)
                self.auxiliary.add(process)
            output, _ = process.communicate()
            path = normalize_path(output.rstrip("\n")) if process.returncode == 0 and output.strip() else None
            with self.lock:
                if not self.stopping:
                    self.send({"type": "directory", "requestId": request_id, "path": path})
        except (OSError, HostError) as exc:
            self.error(None, "internal", str(exc), request_id)
        finally:
            with self.lock:
                self.auxiliary.discard(process)

    def open_path(self, message):
        """Open an existing absolute path with xdg-open without invoking a shell."""
        path = normalize_path(message.get("path"))
        # Folders only: xdg-open on a file such as a .desktop entry may execute it.
        if not os.path.isdir(path):
            raise HostError("invalid_path", "Folder does not exist.")
        binary = shutil.which("xdg-open")
        if not binary:
            raise HostError("internal", "xdg-open was not found.")
        with self.lock:
            self.start_thread(self.run_opener, binary, path)

    def run_opener(self, binary, path):
        """Reap xdg-open and report a failed invocation."""
        process = None
        try:
            with self.lock:
                if self.stopping:
                    return
                process = subprocess.Popen([binary, path], stdin=subprocess.DEVNULL,
                                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                           text=True, start_new_session=True)
                self.auxiliary.add(process)
            _, error = process.communicate(timeout=15)
            with self.lock:
                if process.returncode and not self.stopping:
                    self.error(None, "internal", error.strip() or "xdg-open failed.")
        except (OSError, subprocess.TimeoutExpired) as exc:
            self.error(None, "internal", str(exc))
        finally:
            if process is not None and process.poll() is None:
                terminate_group(process)
                process.communicate()
            with self.lock:
                self.auxiliary.discard(process)

    def handle(self, message):
        """Dispatch one validated JSON object, returning protocol errors to the client."""
        try:
            kind = message.get("type")
            if kind == "ping":
                self.ping()
            elif kind == "download":
                self.submit(message)
            elif kind == "cancel":
                self.cancel(message.get("id"))
            elif kind == "pickDirectory":
                self.pick_directory(message)
            elif kind == "openPath":
                self.open_path(message)
            else:
                raise HostError("bad_request", "Unknown message type.")
        except HostError as exc:
            job_id = message.get("id")
            request_id = message.get("requestId")
            self.error(job_id if isinstance(job_id, str) else None, exc.code, str(exc),
                       request_id if isinstance(request_id, str) else None)
        except Exception as exc:
            print("request failed: " + str(exc), file=sys.stderr)
            self.error(None, "internal", str(exc))

    def shutdown(self):
        """Stop queue dispatch, terminate every child, and wait for workers on EOF."""
        with self.lock:
            self.stopping = True
            self.pending.clear()
            processes = list(self.auxiliary)
            for job in self.jobs.values():
                job.cancelled = True
                if job.process is not None:
                    processes.append(job.process)
            threads = list(self.threads)
        for process in processes:
            terminate_group(process)
        for thread in threads:
            thread.join(timeout=4)


def main():
    """Serve framed messages until EOF; malformed framing closes the connection."""
    host = NativeHost(sys.stdout.buffer)
    try:
        while True:
            message = read_message(sys.stdin.buffer)
            if message is None:
                break
            host.handle(message)
    except HostError as exc:
        host.error(None, exc.code, str(exc))
    except KeyboardInterrupt:
        pass
    finally:
        host.shutdown()


if __name__ == "__main__":
    main()
