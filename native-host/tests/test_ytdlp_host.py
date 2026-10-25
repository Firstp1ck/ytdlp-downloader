"""Protocol, option mapping, and actual child-process lifecycle tests (stdlib only)."""

import importlib.util
import io
import itertools
import json
import os
from pathlib import Path
import queue
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock


HOST_PATH = Path(__file__).resolve().parents[1] / "ytdlp_host.py"
SPEC = importlib.util.spec_from_file_location("ytdlp_host", HOST_PATH)
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)


class FramingTests(unittest.TestCase):
    def test_round_trip_and_concatenated_messages(self):
        messages = [{"type": "ping"}, {"title": 'Grüezi "world"\nnext line', "null": None}]
        stream = io.BytesIO(b"".join(host.encode_message(m) for m in messages))
        for expected in messages:
            self.assertEqual(host.read_message(stream), expected)
        self.assertIsNone(host.read_message(stream))

    def test_short_reads(self):
        class ShortStream(io.BytesIO):
            def read(self, size=-1):
                return super().read(min(size, 2))
        self.assertEqual(host.read_message(ShortStream(host.encode_message({"type": "ping"}))),
                         {"type": "ping"})

    def test_native_endian_header(self):
        frame = host.encode_message({"type": "ping"})
        self.assertEqual(struct.unpack("=I", frame[:4])[0], len(frame) - 4)

    def test_bad_frames(self):
        cases = [b"\x01", struct.pack("=I", 5), struct.pack("=I", 5) + b"{}",
                 struct.pack("=I", 0), struct.pack("=I", host.MAX_MESSAGE_BYTES + 1),
                 struct.pack("=I", 1) + b"\xff", struct.pack("=I", 1) + b"{",
                 struct.pack("=I", 2) + b"[]", struct.pack("=I", 4) + b"null"]
        for frame in cases:
            with self.subTest(frame=frame), self.assertRaises(host.HostError) as caught:
                host.read_message(io.BytesIO(frame))
            self.assertEqual(caught.exception.code, "bad_request")


class ValidationTests(unittest.TestCase):
    def expect_error(self, code, function, *args):
        with self.assertRaises(host.HostError) as caught:
            function(*args)
        self.assertEqual(caught.exception.code, code)

    def test_defaults_and_all_valid_enum_values(self):
        original = {"mode": "audio", "saveDir": "~/a/../Downloads", "playlist": True}
        before = dict(original)
        result = host.validate_options(original, "/tmp/downloads")
        self.assertEqual(original, before)
        self.assertEqual(result["saveDir"], str(Path.home() / "Downloads"))
        self.assertTrue(result["playlist"])
        self.assertEqual(host.validate_options({}, "/tmp/downloads")["saveDir"], "/tmp/downloads")
        for key, values in host.ENUMS.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    self.assertEqual(host.validate_options({key: value}, "/tmp")[key], value)

    def test_every_invalid_enum_type_and_value(self):
        for key in host.ENUMS:
            for value in ["invalid", "", "BEST", "--exec", 720, True, None, [], {}]:
                with self.subTest(key=key, value=value):
                    self.expect_error("bad_request", host.validate_options, {key: value}, "/tmp")

    def test_invalid_options_object_and_unknown_keys(self):
        for options in [None, [], "", 1, True, {"extraArgs": "--exec bad"}]:
            with self.subTest(options=options):
                self.expect_error("bad_request", host.validate_options, options, "/tmp")

    def test_playlist_is_strict_boolean(self):
        for value in [0, 1, "false", None, [], {}]:
            with self.subTest(value=value):
                self.expect_error("bad_request", host.validate_options, {"playlist": value}, "/tmp")
        self.assertFalse(host.validate_options({"playlist": False}, "/tmp")["playlist"])

    def test_invalid_paths(self):
        for value in [None, False, 1, [], {}, "relative", "~no_such_user_52918/path",
                      "/tmp/\x00bad", "/tmp/\nother", "/tmp/\rbad"]:
            with self.subTest(value=value):
                self.expect_error("invalid_path", host.validate_options, {"saveDir": value}, "/tmp")
        self.expect_error("invalid_path", host.normalize_path, "")
        self.assertEqual(host.normalize_path("/tmp/a/../b"), "/tmp/b")

    def test_url_validation(self):
        good = ["https://www.youtube.com/watch?v=a&list=b", "http://localhost:8080/video",
                "https://[::1]/video", "https://example.test/path?value=--exec"]
        for url in good:
            self.assertEqual(host.validate_url(url), url)
        for url in ["javascript:alert(1)", "file:///tmp/a", "--exec=bad", "-o/x", "ftp://host/a",
                    "https:///missing", "http://", "http://[bad", "http://host:bad/a", "", None,
                    1, True, [], " https://example.test", "https://example.test/\nbad",
                    "https://example.test/a b", "https://example.test/\x00"]:
            with self.subTest(url=url):
                self.expect_error("invalid_url", host.validate_url, url)


class ArgvTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(host, "find_js_runtime", return_value=None)
        self.runtime = patcher.start()
        self.addCleanup(patcher.stop)

    def test_runtime_mapping_with_and_without_each_runtime(self):
        options = host.validate_options({}, "/tmp/save")
        for runtime in (None, {"name": "deno", "path": "/tmp/my runtime/deno"},
                        {"name": "node", "path": "/usr/bin/node"}):
            with self.subTest(runtime=runtime):
                self.runtime.return_value = runtime
                argv = host.build_argv("yt-dlp", "https://example.test/a", options, "/tmp/staging")
                if runtime:
                    self.assertEqual(argv[argv.index("--js-runtimes") + 1],
                                     f'{runtime["name"]}:{runtime["path"]}')
                    self.assertLess(argv.index("--js-runtimes"), argv.index("--"))
                else:
                    self.assertNotIn("--js-runtimes", argv)

    def test_every_mode_format_resolution_quality_playlist_combination(self):
        keys = ["mode", "videoResolution", "videoFormat", "audioQuality", "audioFormat"]
        combinations = itertools.product(*(sorted(host.ENUMS[key]) for key in keys), [False, True])
        count = 0
        for values in combinations:
            count += 1
            supplied = dict(zip(keys + ["playlist"], values))
            with self.subTest(options=supplied):
                options = host.validate_options(supplied, "/tmp/save with spaces")
                argv = host.build_argv("/tmp/yt-dlp", "https://example.test/a?x=1&y=2", options,
                                       "/tmp/save with spaces/.staging/job")
                self.assertEqual(argv[0], "/tmp/yt-dlp")
                self.assertNotIn("--js-runtimes", argv)
                self.assertEqual(argv[-2:], ["--", "https://example.test/a?x=1&y=2"])
                self.assertEqual(argv[argv.index("-P") + 1], "/tmp/save with spaces/.staging/job")
                self.assertIn("--ignore-config", argv)
                self.assertIn("--newline", argv)
                self.assertIn("--no-simulate", argv)
                self.assertIn("--progress", argv)
                self.assertEqual(argv[argv.index("--color") + 1], "never")
                self.assertIn("download:" + host.PROGRESS_TEMPLATE, argv)
                self.assertIn("postprocess:" + host.PROGRESS_TEMPLATE, argv)
                self.assertIn("after_move:" + host.FILE_TEMPLATE, argv)
                self.assertIn("--yes-playlist" if options["playlist"] else "--no-playlist", argv)
                output = argv[argv.index("-o") + 1]
                expected = "%(title)s [%(id)s].%(ext)s"
                if options["playlist"]:
                    expected = "%(playlist_title)s/%(playlist_index)03d - " + expected
                self.assertEqual(output, expected)
                if options["mode"] == "video":
                    self.assertEqual(argv[argv.index("-f") + 1], "bv*+ba/b")
                    self.assertNotIn("-x", argv)
                    sort = []
                    if options["videoResolution"] != "best":
                        sort.append("res:" + options["videoResolution"])
                    fmt = options["videoFormat"]
                    if fmt in {"mp4", "webm"}:
                        sort.append("ext:mp4:m4a" if fmt == "mp4" else "ext:webm:webm")
                    if sort:
                        self.assertEqual(argv[argv.index("-S") + 1], ",".join(sort))
                    else:
                        self.assertNotIn("-S", argv)
                    if fmt != "any":
                        self.assertEqual(argv[argv.index("--merge-output-format") + 1], fmt)
                    else:
                        self.assertNotIn("--merge-output-format", argv)
                else:
                    self.assertEqual(argv[argv.index("-f") + 1], "ba/b")
                    self.assertIn("-x", argv)
                    self.assertNotIn("-S", argv)
                    self.assertNotIn("--merge-output-format", argv)
                    fmt = options["audioFormat"]
                    if fmt != "best":
                        self.assertEqual(argv[argv.index("--audio-format") + 1], fmt)
                    else:
                        self.assertNotIn("--audio-format", argv)
                    quality = options["audioQuality"]
                    self.assertEqual(argv[argv.index("--audio-quality") + 1],
                                     "0" if quality == "best" else quality + "K")

        self.assertEqual(count, 4032)


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="ytdlp-publish-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))
        self.save = self.root / "save"
        self.staging = self.save / host.STAGING_DIR_NAME / "job"
        self.staging.mkdir(parents=True)

    def test_existing_file_is_never_overwritten(self):
        (self.save / "Title [id].webm").write_bytes(b"finished video")
        (self.staging / "Title [id].webm").write_bytes(b"new")
        published = host.publish_files([str(self.staging / "Title [id].webm")], str(self.staging), str(self.save))
        self.assertEqual(published, [str(self.save / "Title [id] (2).webm")])
        self.assertEqual((self.save / "Title [id].webm").read_bytes(), b"finished video")
        self.assertEqual(Path(published[0]).read_bytes(), b"new")

    def test_playlist_subfolders_are_kept_and_staging_removed(self):
        nested = self.staging / "List" / "001 - A [x].mp3"
        nested.parent.mkdir()
        nested.write_bytes(b"a")
        published = host.publish_files([str(nested)], str(self.staging), str(self.save))
        self.assertEqual(published, [str(self.save / "List" / "001 - A [x].mp3")])
        host.remove_staging(str(self.staging))
        self.assertFalse((self.save / host.STAGING_DIR_NAME).exists())

    def test_failure_message_prefers_error_lines(self):
        lines = ["WARNING: Unknown codec iamf", "ERROR: Video unavailable", "WARNING: later noise"]
        self.assertEqual(host.failure_message(lines, 1), "ERROR: Video unavailable")
        self.assertEqual(host.failure_message(["WARNING: only"], 1), "WARNING: only")
        self.assertEqual(host.failure_message([], 3), "yt-dlp exited with code 3")


class ProgressTests(unittest.TestCase):
    def line(self, progress, **extra):
        return host.PROGRESS_PREFIX + json.dumps({"progress": progress, **extra})

    def test_percent_and_escaped_title(self):
        parsed = host.parse_progress_line(self.line(
            {"status": "downloading", "_percent_str": " 42.1%", "_speed_str": " 3.2MiB/s ",
             "_eta_str": "00:12"}, title='A "title"\nsecond line ✓', playlistIndex=3, playlistCount=10))
        self.assertEqual(parsed, {"status": "downloading", "percent": 42.1, "speed": "3.2MiB/s",
                                  "eta": "00:12", "title": 'A "title"\nsecond line ✓',
                                  "playlistIndex": 3, "playlistCount": 10})

    def test_byte_estimate_and_missing_fields(self):
        parsed = host.parse_progress_line(self.line(
            {"status": "downloading", "downloaded_bytes": 50, "total_bytes_estimate": 200,
             "_percent_str": "Unknown", "_speed_str": " Unknown B/s", "_eta_str": "Unknown"},
            title=None, playlistIndex=None, playlistCount=None))
        self.assertEqual(parsed["percent"], 25)
        for key in ["speed", "eta", "title", "playlistIndex", "playlistCount"]:
            self.assertIsNone(parsed[key])

    def test_postprocess_and_download_completion(self):
        for status in ["started", "finished", "processing"]:
            parsed = host.parse_progress_line(self.line({"status": status}))
            self.assertEqual(parsed["status"], "processing")
            self.assertIsNone(parsed["percent"])
        parsed = host.parse_progress_line(self.line({"status": "finished", "_percent_str": "100.0%"}))
        self.assertEqual(parsed["percent"], 100)

    def test_malformed_or_unmarked_output(self):
        for line in ["", "[download] 42%", host.PROGRESS_PREFIX + "{bad}",
                     host.PROGRESS_PREFIX + 'null', host.PROGRESS_PREFIX + '{}',
                     host.PROGRESS_PREFIX + '{"progress":null}',
                     host.PROGRESS_PREFIX + '{"progress":[]}',
                     host.PROGRESS_PREFIX + '{"progress":{},"playlistIndex":NA}']:
            self.assertIsNone(host.parse_progress_line(line))

    def test_invalid_numeric_fields(self):
        parsed = host.parse_progress_line(self.line({"status": "downloading", "downloaded_bytes": 1,
                                                    "total_bytes": 0}, playlistIndex=True, playlistCount="10"))
        self.assertIsNone(parsed["percent"])
        self.assertIsNone(parsed["playlistIndex"])
        self.assertIsNone(parsed["playlistCount"])

    def test_final_path_json(self):
        path = '/tmp/A "title"\nnext line.mp4'
        self.assertEqual(host.parse_file_line(host.FILE_PREFIX + json.dumps(path)), path)
        for line in ["ordinary output", host.FILE_PREFIX + "bad", host.FILE_PREFIX + '"relative"',
                     host.FILE_PREFIX + "null"]:
            self.assertIsNone(host.parse_file_line(line))


FAKE_YTDLP = r'''#!PYTHON
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

if '--version' in sys.argv:
    print('fake-1.0')
    raise SystemExit(0)
url = sys.argv[sys.argv.index('--') + 1]
directory = Path(sys.argv[sys.argv.index('-P') + 1])
if url.endswith('/fail'):
    print('ERROR: fake download failed', file=sys.stderr)
    raise SystemExit(7)
if url.endswith('/instant'):
    path = directory / 'fake "title".mp4'
    path.write_bytes(b'fake media')
    print('__YTDLP_PROGRESS__' + json.dumps({'progress': {'status': 'downloading', '_percent_str': '50.0%'}, 'title': 'Fake'}), flush=True)
    print('__YTDLP_FILE__' + json.dumps(str(path)), flush=True)
    raise SystemExit(0)
child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)'])
if url.endswith('/stubborn'):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
# -P is the job's staging dir, <saveDir>/<staging>/<random>; tests look in saveDir.
(directory.parent.parent / 'pids.json').write_text(json.dumps([os.getpid(), child.pid]))
print('__YTDLP_PROGRESS__' + json.dumps({'progress': {'status': 'downloading', '_percent_str': '1.0%'}, 'title': 'Fake'}), flush=True)
time.sleep(120)
'''


def process_alive(pid):
    """Treat a killed descendant awaiting init's reap as no longer running."""
    try:
        state = Path(f"/proc/{pid}/stat").read_text().split(") ", 1)[1].split()[0]
        return state != "Z"
    except FileNotFoundError:
        return False


class PipeHost:
    """Drive the real host process with bounded reads of native frames."""

    def __init__(self, env):
        self.process = subprocess.Popen([sys.executable, str(HOST_PATH)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        self.events = queue.Queue()
        self.history = []
        self.close_result = None
        def reader():
            try:
                while (message := host.read_message(self.process.stdout)) is not None:
                    self.events.put(message)
            except Exception as exc:
                self.events.put(exc)
        self.reader = threading.Thread(target=reader, daemon=True)
        self.reader.start()

    def send(self, message):
        self.process.stdin.write(host.encode_message(message))
        self.process.stdin.flush()

    def until(self, predicate, timeout=8):
        deadline = time.monotonic() + timeout
        while True:
            message = self.events.get(timeout=max(0.01, deadline - time.monotonic()))
            if isinstance(message, Exception):
                raise message
            self.history.append(message)
            if predicate(message):
                return message

    def close(self):
        if self.close_result is not None:
            return self.close_result
        if not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            code = self.process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
            raise
        self.reader.join(timeout=2)
        self.process.stdout.close()
        stderr = self.process.stderr.read().decode()
        self.process.stderr.close()
        self.close_result = (code, stderr)
        return self.close_result


class SubprocessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ytdlp-host-test-")
        self.root = Path(self.temp.name)
        binary = self.root / "yt-dlp"
        binary.write_text(FAKE_YTDLP.replace("#!PYTHON", "#!" + sys.executable))
        binary.chmod(0o755)
        # The host refuses jobs without ffmpeg on PATH; a stub keeps these tests
        # independent of the machine (CI runners have no ffmpeg).
        stub_bin = self.root / "bin"
        stub_bin.mkdir()
        ffmpeg = stub_bin / "ffmpeg"
        ffmpeg.write_text("#!/bin/sh\nexit 0\n")
        ffmpeg.chmod(0o755)
        deno = stub_bin / "deno"
        deno.write_text("#!/bin/sh\nexit 0\n")
        deno.chmod(0o755)
        self.runtime = {"name": "deno", "path": str(deno)}
        self.env = {**os.environ, "YTDLP_HOST_YTDLP": str(binary),
                    "HOME": str(self.root), "PATH": str(stub_bin)}
        self.pipe = PipeHost(self.env)
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.pipe.close)

    def download(self, job_id, suffix="wait"):
        self.pipe.send({"type": "download", "id": job_id, "url": "https://example.test/" + suffix,
                        "options": {"mode": "audio", "audioFormat": "best",
                                    "saveDir": str(self.root / job_id)}})

    def get_pids(self, job_id):
        path = self.root / job_id / "pids.json"
        deadline = time.monotonic() + 4
        while not path.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        return json.loads(path.read_text())

    def assert_stopped(self, pids):
        deadline = time.monotonic() + 3
        while any(process_alive(pid) for pid in pids) and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(any(process_alive(pid) for pid in pids), pids)

    def test_real_framing_ping_pong_and_eof(self):
        self.pipe.send({"type": "ping"})
        pong = self.pipe.until(lambda m: m["type"] == "pong")
        self.assertEqual(pong["hostVersion"], "1.1.0")
        self.assertEqual(pong["jsRuntime"], self.runtime)
        self.assertEqual(pong["ytDlp"]["version"], "fake-1.0")
        self.assertTrue(pong["ytDlp"]["found"])
        self.assertTrue(os.path.isabs(pong["defaultSaveDir"]))
        code, stderr = self.pipe.close()
        self.assertEqual(code, 0, stderr)

    def test_success_and_failure_events(self):
        self.download("success", "instant")
        finished = self.pipe.until(lambda m: m["type"] == "finished")
        self.assertEqual(finished["id"], "success")
        self.assertEqual(len(finished["files"]), 1)
        self.assertEqual(finished["fileCount"], 1)
        self.assertTrue(Path(finished["files"][0]).is_file())
        self.assertEqual(Path(finished["files"][0]).parent, self.root / "success", "moved out of staging")
        self.assertFalse((self.root / "success" / host.STAGING_DIR_NAME).exists())
        self.assertTrue(any(m["type"] == "progress" for m in self.pipe.history))
        self.download("failure", "fail")
        error = self.pipe.until(lambda m: m["type"] == "error")
        self.assertEqual(error["code"], "ytdlp_failed")
        self.assertIn("ERROR: fake download failed", error["message"])

    def test_cancel_kills_entire_group_and_allows_ping(self):
        self.download("cancel")
        self.pipe.until(lambda m: m["type"] == "progress")
        pids = self.get_pids("cancel")
        self.pipe.send({"type": "cancel", "id": "cancel"})
        self.assertEqual(self.pipe.until(lambda m: m["type"] == "cancelled")["id"], "cancel")
        self.assert_stopped(pids)
        self.pipe.send({"type": "ping"})
        self.pipe.until(lambda m: m["type"] == "pong")
        terminal = [m for m in self.pipe.history if m.get("id") == "cancel"
                    and m["type"] in {"finished", "cancelled", "error"}]
        self.assertEqual(len(terminal), 1)

    def test_eof_kills_active_groups_and_discards_queue(self):
        for job_id in ["one", "two"]:
            self.download(job_id)
            self.pipe.until(lambda m: m["type"] == "progress" and m["id"] == job_id)
        self.download("three")
        self.pipe.until(lambda m: m["type"] == "queued")
        pids = self.get_pids("one") + self.get_pids("two")
        code, stderr = self.pipe.close()
        self.assertEqual(code, 0, stderr)
        self.assert_stopped(pids)
        self.assertFalse((self.root / "three").exists())

    def test_cancel_escalates_when_sigterm_is_ignored(self):
        self.download("stubborn", "stubborn")
        self.pipe.until(lambda m: m["type"] == "progress")
        pids = self.get_pids("stubborn")
        self.pipe.send({"type": "cancel", "id": "stubborn"})
        self.pipe.until(lambda m: m["type"] == "cancelled")
        self.assert_stopped(pids)

    def test_queue_limit_dispatch_and_queued_cancellation(self):
        for job_id in ["one", "two"]:
            self.download(job_id)
            self.pipe.until(lambda m: m["type"] == "progress" and m["id"] == job_id)
        self.download("three", "instant")
        self.pipe.until(lambda m: m["type"] == "queued" and m["id"] == "three")
        self.download("four")
        self.pipe.until(lambda m: m["type"] == "queued" and m["id"] == "four")
        self.assertEqual(len([m for m in self.pipe.history if m["type"] == "started"]), 2)
        self.pipe.send({"type": "cancel", "id": "four"})
        self.pipe.until(lambda m: m["type"] == "cancelled" and m["id"] == "four")
        self.assertFalse((self.root / "four").exists())
        self.pipe.send({"type": "cancel", "id": "one"})
        self.pipe.until(lambda m: m["type"] == "finished" and m["id"] == "three")
        relevant = [m["type"] for m in self.pipe.history if m.get("id") == "three"]
        self.assertEqual(relevant, ["queued", "started", "progress", "finished"])

    def test_duplicate_invalid_ids_and_unknown_message(self):
        self.download("duplicate")
        self.pipe.until(lambda m: m["type"] == "started")
        self.download("duplicate")
        self.assertEqual(self.pipe.until(lambda m: m["type"] == "error")["code"], "bad_request")
        for message, code in [({"type": "cancel", "id": "missing"}, "unknown_id"),
                              ({"type": "download", "id": []}, "bad_request"),
                              ({"type": "download", "id": ""}, "bad_request"),
                              ({"type": "download", "id": "a" * 129}, "bad_request"),
                              ({"type": "wat"}, "bad_request")]:
            self.pipe.send(message)
            self.assertEqual(self.pipe.until(lambda m: m["type"] == "error")["code"], code)


class ToolAndDispatchTests(unittest.TestCase):
    def setUp(self):
        self.output = io.BytesIO()
        with mock.patch.object(host, "default_save_dir", return_value="/tmp/downloads"):
            self.native = host.NativeHost(self.output)
        self.addCleanup(self.native.shutdown)

    def messages(self):
        stream = io.BytesIO(self.output.getvalue())
        result = []
        while (message := host.read_message(stream)) is not None:
            result.append(message)
        return result

    def request(self, options=None):
        return {"type": "download", "id": "id", "url": "https://example.test/a",
                "options": options or {}}

    def test_missing_ytdlp_and_ffmpeg(self):
        with mock.patch.object(host, "find_ytdlp", return_value=None):
            self.native.handle(self.request())
        self.assertEqual(self.messages()[-1]["code"], "ytdlp_missing")
        for options in [{}, {"mode": "audio", "audioFormat": "mp3"}, {"mode": "audio", "audioFormat": "best"}]:
            with mock.patch.object(host, "find_ytdlp", return_value="/bin/true"), \
                    mock.patch.object(host.shutil, "which", return_value=None):
                self.native.handle(self.request(options))
            self.assertEqual(self.messages()[-1]["code"], "ffmpeg_missing")

    def test_cancel_after_process_exit_is_unknown(self):
        job = host.Job("done", "https://example.test/a", host.validate_options({}, "/tmp"), "/bin/true")
        job.process = mock.Mock()
        job.process.poll.return_value = 0
        self.native.jobs["done"] = job
        self.native.handle({"type": "cancel", "id": "done"})
        self.assertEqual(self.messages()[-1]["code"], "unknown_id")
        self.assertFalse(job.cancelled, "a finished download must not be relabelled as cancelled")
        del self.native.jobs["done"]

    def test_invalid_directory_creation(self):
        with tempfile.NamedTemporaryFile() as target, \
                mock.patch.object(host, "find_ytdlp", return_value="/bin/true"), \
                mock.patch.object(host.shutil, "which", side_effect=lambda name: "/usr/bin/" + name):
            self.native.handle(self.request({"saveDir": target.name + "/child", "mode": "audio"}))
            for thread in list(self.native.threads):
                thread.join(timeout=3)
            self.assertEqual(self.messages()[-1]["code"], "invalid_path")

    def test_picker_absent_and_invalid_requests(self):
        for message, code in [({"type": "pickDirectory"}, "bad_request"),
                              ({"type": "pickDirectory", "requestId": "r", "start": "relative"}, "invalid_path"),
                              ({"type": "openPath", "path": "/does/not/exist/ws1"}, "invalid_path"),
                              ({"type": "openPath", "path": str(HOST_PATH)}, "invalid_path")]:
            self.native.handle(message)
            self.assertEqual(self.messages()[-1]["code"], code)
        with mock.patch.object(host, "find_picker", return_value=None):
            self.native.handle({"type": "pickDirectory", "requestId": "r"})
        self.assertEqual(self.messages()[-1]["code"], "no_picker")
        self.assertEqual(self.messages()[-1]["requestId"], "r")

    def test_picker_mapping_and_result(self):
        for picker in ["zenity", "kdialog", "yad"]:
            with self.subTest(picker=picker), mock.patch.object(host, "find_picker", return_value=picker), \
                    mock.patch.object(self.native, "start_thread") as start:
                self.native.handle({"type": "pickDirectory", "requestId": "r", "start": "/tmp/start"})
                argv = start.call_args.args[1]
                self.assertEqual(argv[0], picker)
                self.assertIn("--getexistingdirectory" if picker == "kdialog" else "--directory", argv)
        for returncode, output, path in [(0, "/tmp/chosen\n", "/tmp/chosen"), (1, "", None)]:
            process = mock.Mock(returncode=returncode)
            process.communicate.return_value = (output, None)
            with mock.patch.object(host.subprocess, "Popen", return_value=process):
                self.native.run_picker(["zenity"], "r")
            self.assertEqual(self.messages()[-1], {"type": "directory", "requestId": "r", "path": path})

    def test_open_path_uses_absolute_argv(self):
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(host.shutil, "which", return_value="/usr/bin/xdg-open"), \
                mock.patch.object(self.native, "start_thread") as start:
            self.native.handle({"type": "openPath", "path": directory})
            self.assertEqual(start.call_args.args[1:], ("/usr/bin/xdg-open", directory))
        process = mock.Mock(returncode=0)
        process.communicate.return_value = (None, "")
        process.poll.return_value = 0
        with mock.patch.object(host.subprocess, "Popen", return_value=process) as popen:
            self.native.run_opener("/usr/bin/xdg-open", "/tmp/a;echo bad")
        self.assertEqual(popen.call_args.args[0], ["/usr/bin/xdg-open", "/tmp/a;echo bad"])
        self.assertNotIn("shell", popen.call_args.kwargs)

    def test_binary_fallback_and_override(self):
        with mock.patch.dict(os.environ, {"YTDLP_HOST_YTDLP": "/custom/yt-dlp"}), \
                mock.patch.object(host.shutil, "which", return_value="/custom/yt-dlp") as which:
            self.assertEqual(host.find_ytdlp(), "/custom/yt-dlp")
            which.assert_called_once_with("/custom/yt-dlp")
        with mock.patch.dict(os.environ, {"YTDLP_HOST_YTDLP": ""}), \
                mock.patch.object(host.shutil, "which", return_value=None), \
                mock.patch.object(Path, "is_file", return_value=True), \
                mock.patch.object(host.os, "access", return_value=True):
            self.assertEqual(host.find_ytdlp(), str(Path.home() / ".local/bin/yt-dlp"))

    def test_runtime_discovery_order_with_executable_fakes(self):
        def fake(path, output):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"#!/bin/sh\necho {output}\n")
            path.chmod(0o755)

        with tempfile.TemporaryDirectory(prefix="ytdlp-runtimes-") as directory:
            root = Path(directory)
            path_bin = root / "path"
            deno_order = [path_bin / "deno", root / ".local/bin/deno", root / ".deno/bin/deno",
                          root / ".volta/bin/deno"]
            node_order = [path_bin / "node", root / ".local/bin/node", root / ".volta/bin/node",
                          root / ".nvm/versions/node/v24.0.0/bin/node",
                          root / ".nvm/versions/node/v22.3.0/bin/node"]
            for path in deno_order:
                fake(path, "deno 2.9.8")
            for path in node_order:
                fake(path, "v22.3.0")
            fake(path_bin / "bun", "1.3.14")
            with mock.patch.dict(os.environ, {"HOME": str(root), "PATH": str(path_bin)}):
                # Deno (yt-dlp's default) wins over any Node, in search order.
                for path in deno_order:
                    self.assertEqual(host.find_js_runtime(), {"name": "deno", "path": str(path)})
                    path.unlink()
                # Then Node; nvm's newest version comes first.
                for path in node_order:
                    self.assertEqual(host.find_js_runtime(), {"name": "node", "path": str(path)})
                    path.unlink()
                # Bun alone is not used (deprecated in yt-dlp, unsandboxed).
                self.assertIsNone(host.find_js_runtime())

    def test_node_older_than_22_is_skipped(self):
        with tempfile.TemporaryDirectory(prefix="ytdlp-node-") as directory:
            root = Path(directory)
            old, new = root / "path/node", root / ".local/bin/node"
            for path, version in ((old, "v20.19.0"), (new, "v22.0.0")):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(f"#!/bin/sh\necho {version}\n")
                path.chmod(0o755)
            with mock.patch.dict(os.environ, {"HOME": str(root), "PATH": str(old.parent)}):
                self.assertEqual(host.find_js_runtime(), {"name": "node", "path": str(new)})
                new.unlink()
                self.assertIsNone(host.find_js_runtime())
                # Garbled or failing version output counts as unusable.
                old.write_text("#!/bin/sh\necho nonsense\n")
                self.assertIsNone(host.find_js_runtime())
                # Nonexecutable files and directories aren't runtimes either.
                (root / ".local/bin/deno").write_text("not executable")
                (root / ".deno/bin").mkdir(parents=True)
                (root / ".deno/bin/deno").mkdir()
                self.assertIsNone(host.find_js_runtime())

    def test_pong_runtime_field_and_failed_ytdlp_probe(self):
        for runtime in (None, {"name": "node", "path": "/tmp/node"}):
            for code, expected_version in ((0, "2026.10.21"), (3, None)):
                with self.subTest(runtime=runtime, code=code), \
                        mock.patch.object(host, "find_js_runtime", return_value=runtime), \
                        mock.patch.object(host, "find_ytdlp", return_value="/tmp/yt-dlp"), \
                        mock.patch.object(host.subprocess, "run", return_value=mock.Mock(returncode=code, stdout="2026.10.21\n")):
                    self.native.send_pong()
                    pong = self.messages()[-1]
                    self.assertEqual(pong["hostVersion"], "1.1.0")
                    self.assertEqual(pong["jsRuntime"], runtime)
                    self.assertEqual(pong["ytDlp"]["version"], expected_version)

    def test_default_directory_fallback(self):
        with mock.patch.object(host.shutil, "which", return_value=None):
            self.assertEqual(host.default_save_dir(), str(Path.home() / "Downloads"))
        with mock.patch.object(host.shutil, "which", return_value="xdg-user-dir"), \
                mock.patch.object(host.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="/tmp/xdg\n")):
            self.assertEqual(host.default_save_dir(), "/tmp/xdg")

    def test_thread_safe_frames(self):
        threads = [threading.Thread(target=lambda n=n: [self.native.send({"n": n, "i": i})
                                                       for i in range(50)]) for n in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(self.messages()), 400)


if __name__ == "__main__":
    unittest.main()
