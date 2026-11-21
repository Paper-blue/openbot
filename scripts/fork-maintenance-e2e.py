import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import runpy
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlsplit


ROOT = Path(__file__).resolve().parents[1]
CONTROLLER = ROOT / ".github/automation/maintenance.py"
SNAPSHOT = ROOT / ".github/automation/snapshot.py"
HEAD = "a" * 40
BASE = "b" * 40
MERGE = "c" * 40
BOT = "openbot-maintenance[bot]"
TOKEN = "e2e-do-not-print-this-token"
STATE = {}
CASES = []


def pull(head=HEAD):
    return {
        "number": 7,
        "draft": False,
        "state": "open",
        "merge_commit_sha": MERGE,
        "user": {"login": BOT},
        "base": {"ref": "maintenance", "sha": BASE},
        "head": {
            "ref": "bot/issue-3",
            "sha": head,
            "repo": {"full_name": "owner/repo"},
        },
        "labels": [
            {"name": name} for name in ["codex-managed", "automerge", "codex-round-0"]
        ],
    }


def reset():
    STATE.clear()
    STATE.update(
        {
            "writes": [],
            "comments": [],
            "prs": [],
            "issues": [],
            "statuses": [],
            "pr": pull(),
            "files": [{"filename": "src/example.ts"}],
            "assets": [],
            "release": None,
            "ref": None,
            "uploads": 0,
            "fail_upload": 0,
            "required": True,
            "ci": "success",
            "base_current": True,
        }
    )


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.respond("GET")

    def do_POST(self):
        self.respond("POST")

    def do_PUT(self):
        self.respond("PUT")

    def do_PATCH(self):
        self.respond("PATCH")

    def respond(self, method):
        url = urlsplit(self.path)
        path = url.path.removeprefix("/repos/owner/repo/")
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        body = None
        if raw and not path.endswith("/assets"):
            body = json.loads(raw)
        status = 200
        value = None
        if method != "GET":
            STATE["writes"].append((method, path, body))
        if path == "pulls" and method == "GET":
            value = STATE["prs"]
        elif path == "pulls" and method == "POST":
            STATE["pr"]["head"]["sha"] = subprocess.run(
                [
                    "git",
                    "--git-dir",
                    STATE["remote_path"],
                    "rev-parse",
                    "refs/heads/bot/issue-3",
                ],
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
            value = STATE["pr"]
        elif path.startswith("pulls/") and path.endswith("/files"):
            value = STATE["files"]
        elif path.startswith("pulls/") and path.endswith("/merge"):
            value = {"merged": True}
        elif path.startswith("pulls/"):
            value = STATE["pr"]
        elif path.startswith("collaborators/"):
            value = {"permission": STATE.get("permission", "write")}
        elif path == "issues" and method == "GET":
            value = STATE["issues"]
        elif path.startswith("issues/") and path.endswith("/events"):
            value = [
                {
                    "event": "labeled",
                    "label": {"name": "codex-ready"},
                    "actor": {"login": "owner"},
                }
            ]
        elif path == "labels":
            value = [
                {"name": name}
                for name in [
                    "codex-ready",
                    "codex-managed",
                    "codex-blocked",
                    "automerge",
                    "codex-round-0",
                    "codex-round-1",
                    "codex-round-2",
                ]
            ]
        elif path.startswith("issues/") and path.endswith("/comments"):
            if method == "POST":
                STATE["comments"].append({"user": {"login": BOT}, **body})
                value = {"id": len(STATE["comments"])}
            else:
                value = STATE["comments"]
        elif path.startswith("issues/") and path.endswith("/labels"):
            value = []
        elif path.startswith("issues/"):
            value = {
                "number": 3,
                "title": "Fix the example",
                "body": "A reproducible issue",
                "state": "open",
                "labels": [{"name": "codex-ready"}],
            }
        elif path == "git/ref/heads/maintenance":
            value = {"object": {"sha": STATE.get("start", HEAD)}}
        elif path.startswith("commits/") and path.endswith("/statuses"):
            value = STATE["statuses"]
        elif path.startswith("statuses/"):
            STATE["statuses"].insert(0, {**body, "creator": {"login": BOT}})
            value = {}
        elif path == "branches/maintenance/protection":
            value = {
                "required_status_checks": {
                    "strict": STATE["required"],
                    "contexts": ["Check", "Codex review finished"],
                },
                "enforce_admins": {"enabled": True},
            }
        elif path.startswith("compare/"):
            source = path.removeprefix("compare/").split("...")[0]
            value = {
                "merge_base_commit": {
                    "sha": source if STATE["base_current"] else "d" * 40
                }
            }
        elif path.endswith("/check-runs"):
            value = {
                "check_runs": [
                    {
                        "id": index,
                        "name": name,
                        "status": "completed",
                        "conclusion": STATE["ci"],
                        "app": {"slug": "github-actions"},
                    }
                    for index, name in enumerate(["Check", "Codex review finished"], 1)
                ]
            }
        elif path == "actions/workflows/ci.yml":
            value = {"id": 4}
        elif path.startswith("actions/workflows/4/runs"):
            value = {
                "workflow_runs": [
                    {
                        "head_sha": HEAD,
                        "head_branch": "maintenance",
                        "conclusion": STATE["ci"],
                    }
                ]
            }
        elif path == "git/refs":
            STATE["ref"] = {"object": {"type": "commit", "sha": body["sha"]}}
            value = STATE["ref"]
        elif path.startswith("git/ref/tags/"):
            value = STATE["ref"]
            if value is None:
                status = 404
        elif path == "releases":
            if method == "POST":
                STATE["release"] = {"id": 9, **body}
                value = STATE["release"]
            else:
                value = [STATE["release"]] if STATE["release"] else []
        elif path == "releases/9/assets":
            if method == "POST":
                STATE["uploads"] += 1
                if STATE["uploads"] == STATE["fail_upload"]:
                    status = 500
                    value = {}
                else:
                    name = parse_qs(url.query)["name"][0]
                    item = {
                        "name": name,
                        "digest": "sha256:" + hashlib.sha256(raw).hexdigest(),
                    }
                    STATE["assets"].append(item)
                    value = item
            else:
                value = STATE["assets"]
        elif path == "releases/9":
            if method == "PATCH":
                STATE["release"].update(body)
            value = STATE["release"]
        else:
            status = 404
            value = {"error": "Unimplemented fixture endpoint"}
        payload = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def command(args, cwd=None, env=None):
    result = subprocess.run(
        args, cwd=cwd, env=env, text=True, capture_output=True, timeout=30
    )
    if TOKEN in result.stdout + result.stderr:
        raise AssertionError("Secret leaked to output")
    return result


def run(args, env, ok=True):
    invocation = [sys.executable, *map(str, args)]
    if env.get("MAINTENANCE_FIXTURE"):
        Path(env["MAINTENANCE_FIXTURE"]).write_text(json.dumps(STATE))
        invocation = [
            sys.executable,
            str(Path(__file__)),
            "--fixture-child",
            *map(str, args),
        ]
    result = command(invocation, env=env)
    if env.get("MAINTENANCE_FIXTURE"):
        STATE.clear()
        STATE.update(json.loads(Path(env["MAINTENANCE_FIXTURE"]).read_text()))
    assert (result.returncode == 0) == ok, result.stderr + result.stdout
    return result


def checked(name):
    CASES.append(name)


def main():
    reset()
    offline = "--offline" in sys.argv
    server = None if offline else ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = (
        None if offline else threading.Thread(target=server.serve_forever, daemon=True)
    )
    if thread:
        thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="fork-maintenance-e2e-") as temp:
            directory = Path(temp)
            event = directory / "event.json"
            event.write_text("{}")
            env = {
                **os.environ,
                "GITHUB_REPOSITORY": "owner/repo",
                "GH_TOKEN": TOKEN,
                "GITHUB_API_URL": f"http://127.0.0.1:{server.server_port if server else 9}",
                "MAINTENANCE_E2E": "1",
                "MAINTENANCE_BOT_LOGIN": BOT,
                "GITHUB_EVENT_PATH": str(event),
                "GITHUB_RUN_ID": "123",
                "FORK_AUTOMERGE_ENABLED": "false",
            }
            if offline:
                env["MAINTENANCE_FIXTURE"] = str(directory / "api-state.json")
            task_dir = directory / "task"
            args = [CONTROLLER, "select", "--directory", task_dir]
            run(args, env)
            assert not STATE["writes"]
            checked("empty queue makes no remote mutation")
            STATE["issues"] = [{"number": 3, "labels": [{"name": "codex-ready"}]}]
            run(args, env)
            assert json.loads((task_dir / "task.json").read_text())["round"] == 0
            checked("one ready issue produces a task and an attempt marker")
            writes = len(STATE["writes"])
            run(args, env)
            assert len(STATE["writes"]) == writes
            checked("an attempted issue is not started twice")
            reset()
            STATE["issues"] = [{"number": 3, "labels": [{"name": "codex-ready"}]}]
            linked = pull()
            linked["user"]["login"] = "owner"
            linked["head"]["ref"] = "human-fix"
            linked["body"] = "Closes #3"
            STATE["prs"] = [linked]
            run(args, env)
            assert not STATE["writes"]
            checked("an existing human PR prevents duplicate development")
            writes = len(STATE["writes"])
            event.write_text(
                json.dumps(
                    {
                        "action": "labeled",
                        "sender": {"login": "outsider"},
                        "label": {"name": "codex-ready"},
                        "issue": {"number": 3},
                    }
                )
            )
            STATE["permission"] = "read"
            run(args, env, ok=False)
            assert len(STATE["writes"]) == writes
            checked("a reader cannot authorize development")
            event.write_text("{}")
            reset()
            STATE["prs"] = [pull()]
            STATE["statuses"] = [
                {
                    "context": "Codex API review",
                    "state": "failure",
                    "creator": {"login": BOT},
                }
            ]
            run(args, env)
            assert json.loads((task_dir / "task.json").read_text())["round"] == 1
            checked("a failed independent review selects a repair")
            STATE["prs"][0]["labels"].append({"name": "codex-round-2"})
            run(args, env)
            assert any(write[1] == "issues/7/labels" for write in STATE["writes"])
            checked("two repair rounds stop with a blocked PR")
            STATE["prs"][0]["labels"] = [
                label
                for label in STATE["prs"][0]["labels"]
                if label["name"] != "codex-round-2"
            ]
            STATE["comments"].append(
                {"user": {"login": BOT}, "body": "<!-- codex-attempt:124:2 -->"}
            )
            writes = len(STATE["writes"])
            run(args, env)
            assert any(
                write[1] == "issues/7/labels" for write in STATE["writes"][writes:]
            )
            checked("failed worker attempts also consume the repair limit")

            repo = directory / "product"
            repo.mkdir()
            for args_git in [
                ["init", "-b", "maintenance"],
                ["config", "user.name", "E2E"],
                ["config", "user.email", "e2e@example.invalid"],
            ]:
                assert command(["git", *args_git], cwd=repo).returncode == 0
            (repo / "example.txt").write_text("before\n")
            command(["git", "add", "."], cwd=repo)
            command(["git", "commit", "-m", "Fixture"], cwd=repo)
            start = command(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()
            task = {
                "issue": 3,
                "pr": 0,
                "start": start,
                "base": start,
                "round": 0,
                "branch": "bot/issue-3",
                "kind": "code",
            }
            (task_dir / "task.json").write_text(json.dumps(task))
            (repo / "example.txt").write_text("after\n")
            diff = command(["git", "diff", "--binary"], cwd=repo).stdout
            (task_dir / "changes.patch").write_text(diff)
            command(["git", "checkout", "--", "example.txt"], cwd=repo)
            reset()
            publish_args = [
                CONTROLLER,
                "publish",
                "--directory",
                task_dir,
                "--checkout",
                repo,
            ]
            (repo / ".github").mkdir()
            (repo / ".github/attack.yml").write_text("attack\n")
            command(["git", "add", "--intent-to-add", ".github/attack.yml"], cwd=repo)
            bad = command(["git", "diff", "--binary"], cwd=repo).stdout
            command(["git", "reset", "--hard", "HEAD"], cwd=repo)
            (task_dir / "changes.patch").write_text(bad)
            run(publish_args, env, ok=False)
            assert not STATE["writes"]
            checked("protected patch is refused before a remote mutation")
            command(["git", "reset", "--hard", "HEAD"], cwd=repo)
            (task_dir / "changes.patch").write_text(diff)
            bare = directory / "remote.git"
            command(["git", "init", "--bare", str(bare)])
            command(["git", "remote", "add", "origin", str(bare)], cwd=repo)
            STATE["remote_path"] = str(bare)
            run(publish_args, env)
            published = json.loads((task_dir / "task.json").read_text())
            stored = command(
                [
                    "git",
                    "--git-dir",
                    str(bare),
                    "show",
                    f"{published['head']}:example.txt",
                ]
            )
            assert stored.stdout == "after\n"
            checked("validated patch becomes a real Git commit and PR")
            review_file = directory / "review.json"
            review_file.write_text(
                json.dumps(
                    {
                        "verdict": "pass",
                        "findings": [],
                        "summary": "No actionable finding",
                    }
                )
            )
            run(
                [
                    CONTROLLER,
                    "report",
                    "--directory",
                    task_dir,
                    "--review-file",
                    review_file,
                ],
                env,
            )
            assert STATE["statuses"][0]["state"] == "success"
            checked("independent review is attached to the published commit")
            STATE["pr"]["head"]["sha"] = HEAD
            count = len(STATE["writes"])
            run(
                [
                    CONTROLLER,
                    "report",
                    "--directory",
                    task_dir,
                    "--review-file",
                    review_file,
                ],
                env,
                ok=False,
            )
            assert len(STATE["writes"]) == count
            checked("a stale review cannot pass a newer commit")

            reset()
            STATE["prs"] = [pull()]
            STATE["statuses"] = [
                {
                    "context": "Codex API review",
                    "state": "success",
                    "creator": {"login": BOT},
                }
            ]
            gate_env = {**env, "FORK_AUTOMERGE_ENABLED": "true"}
            for name, field, value in [
                ("failed CI", "ci", "failure"),
                ("stale base", "base_current", False),
                ("disabled strict protection", "required", False),
            ]:
                original = STATE[field]
                STATE[field] = value
                run([CONTROLLER, "gate"], gate_env)
                assert not any(write[1].endswith("/merge") for write in STATE["writes"])
                STATE[field] = original
                checked(name + " blocks automatic merge")
            STATE["statuses"][0]["creator"]["login"] = "attacker"
            run([CONTROLLER, "gate"], gate_env)
            assert not STATE["writes"]
            checked("a forged review identity cannot authorize merge")
            STATE["statuses"][0]["creator"]["login"] = BOT
            run([CONTROLLER, "gate"], gate_env)
            assert STATE["writes"][-1][2]["sha"] == HEAD
            checked("merge request is bound to the checked head")

            reset()
            artifacts = directory / "artifacts"
            artifacts.mkdir()
            for suffix in ["arm64.dmg", "arm64.zip", "x64.exe", "x86_64.AppImage"]:
                (artifacts / f"OpenBot-0.73.0-{suffix}").write_bytes(
                    b"artifact " + suffix.encode()
                )
            release_env = {**env, "SOURCE_SHA": HEAD, "ARTIFACTS_DIR": str(artifacts)}
            STATE["fail_upload"] = 3
            run([SNAPSHOT], release_env, ok=False)
            assert STATE["release"]["draft"] and len(STATE["assets"]) == 2
            checked("interrupted upload retains a draft with verified assets")
            STATE["fail_upload"] = 0
            run([SNAPSHOT], release_env)
            assert not STATE["release"]["draft"] and STATE["release"]["prerelease"]
            assert len(STATE["assets"]) == 5
            assert not any(item["name"].endswith(".yml") for item in STATE["assets"])
            checked("resume publishes all packages and checksums without updater feeds")
            uploads = STATE["uploads"]
            writes = len(STATE["writes"])
            run([SNAPSHOT], release_env)
            assert STATE["uploads"] == uploads and len(STATE["writes"]) == writes
            checked("published snapshot is idempotent")
            STATE["assets"][0]["digest"] = "sha256:wrong"
            run([SNAPSHOT], release_env, ok=False)
            assert STATE["uploads"] == uploads
            checked("remote digest mismatch is never overwritten")
            (artifacts / "unexpected.txt").write_text("unexpected")
            run([SNAPSHOT], release_env, ok=False)
            assert STATE["uploads"] == uploads
            checked("unexpected local assets stop release")
            STATE["ci"] = "failure"
            run([SNAPSHOT, "verify"], release_env, ok=False)
            checked("release source needs successful maintenance push CI")
    finally:
        if server:
            server.shutdown()
            server.server_close()
            thread.join()
    report = ROOT / ".openbot-build/fork-maintenance-e2e/report.json"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(
        json.dumps(
            {
                "passed": len(CASES),
                "transport": "offline fixture" if offline else "HTTP fixture",
                "cases": CASES,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"Passed {len(CASES)} process cases. Report: {report.relative_to(ROOT)}")


def fixture_child():
    state_path = Path(os.environ["MAINTENANCE_FIXTURE"])
    STATE.update(json.loads(state_path.read_text()))

    def open_fixture(request, timeout=30):
        handler = Handler.__new__(Handler)
        parsed = urlsplit(request.full_url)
        handler.path = parsed.path + ("?" + parsed.query if parsed.query else "")
        raw = request.data or b""
        if hasattr(raw, "read"):
            raw = raw.read()
        handler.headers = {"Content-Length": str(len(raw))}
        handler.rfile = io.BytesIO(raw)
        handler.wfile = io.BytesIO()
        code = []
        handler.send_response = code.append
        handler.send_header = lambda *args: None
        handler.end_headers = lambda: None
        handler.respond(request.get_method())
        state_path.write_text(json.dumps(STATE))
        if code[0] >= 400:
            raise urllib.error.HTTPError(
                request.full_url, code[0], "Fixture failure", {}, None
            )
        return io.BytesIO(handler.wfile.getvalue())

    urllib.request.urlopen = open_fixture
    target = sys.argv[2]
    sys.argv = sys.argv[2:]
    sys.path.insert(0, str(Path(target).parent))
    runpy.run_path(target, run_name="__main__")


if __name__ == "__main__":
    if "--fixture-child" in sys.argv:
        fixture_child()
    else:
        main()
