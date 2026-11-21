import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request

from maintenance import GitHub, Stop, sha


def verify_source(api, source):
    source = sha(source)
    comparison = api.request(f"compare/{source}...maintenance")
    if comparison["merge_base_commit"]["sha"] != source:
        raise Stop("Release source is outside maintenance history")
    workflow = api.request("actions/workflows/ci.yml")
    runs = api.pages(
        f"actions/workflows/{workflow['id']}/runs?head_sha={source}&event=push&branch=maintenance",
        "workflow_runs",
    )
    latest = (
        max(runs, key=lambda run: (run.get("id", 0), run.get("run_attempt", 0)))
        if runs
        else None
    )
    if (
        not latest
        or latest["head_sha"] != source
        or latest["head_branch"] != "maintenance"
        or latest["conclusion"] != "success"
    ):
        raise Stop("Release source has no successful maintenance push CI")


def assets(directory):
    paths = sorted(directory.iterdir())
    packages = [
        path for path in paths if path.suffix in {".dmg", ".zip", ".exe", ".AppImage"}
    ]
    versions = set()
    suffixes = set()
    for path in packages:
        match = re.fullmatch(
            r"OpenBot-(\d+\.\d+\.\d+)-(arm64\.(?:dmg|zip)|x64\.exe|x86_64\.AppImage)",
            path.name,
        )
        if not match or path.is_symlink() or not path.is_file():
            raise Stop("Unexpected package")
        versions.add(match[1])
        suffixes.add(match[2])
    if (
        len(packages) != 4
        or len(versions) != 1
        or suffixes != {"arm64.dmg", "arm64.zip", "x64.exe", "x86_64.AppImage"}
    ):
        raise Stop("All three platform packages with one version are required")
    allowed = {path.name for path in packages}
    allowed.update(path.name + ".blockmap" for path in packages)
    allowed.update({"latest-mac.yml", "latest-linux.yml", "latest.yml", "SHA256SUMS"})
    if any(
        path.name not in allowed or path.is_symlink() or not path.is_file()
        for path in paths
    ):
        raise Stop("Unexpected release artifact")
    result = []
    sums = []
    for path in packages:
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if path.stat().st_size == 0:
            raise Stop("Empty package")
        result.append((path, "sha256:" + digest))
        sums.append(f"{digest}  {path.name}\n")
    sums_path = directory / "SHA256SUMS"
    sums_path.write_text("".join(sums))
    result.append(
        (sums_path, "sha256:" + hashlib.sha256(sums_path.read_bytes()).hexdigest())
    )
    return result


def upload(api, release_id, path):
    host = "https://uploads.github.com"
    if os.environ.get("MAINTENANCE_E2E") == "1":
        host = api.root
    url = f"{host}/repos/{api.repo}/releases/{release_id}/assets?name={path.name}"
    try:
        with path.open("rb") as stream:
            request = urllib.request.Request(
                url,
                stream,
                {
                    "Authorization": f"Bearer {os.environ['GH_TOKEN']}",
                    "Content-Type": "application/octet-stream",
                    "Content-Length": str(path.stat().st_size),
                    "Accept": "application/vnd.github+json",
                },
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=300) as response:
                return json.load(response)
    except urllib.error.HTTPError as error:
        raise Stop(f"Artifact upload returned {error.code}") from None


def publish(api, source, directory):
    verify_source(api, source)
    local = assets(directory)
    tag = "personal-" + sha(source)
    ref = api.request(f"git/ref/tags/{tag}", missing=True)
    if ref is None:
        api.request("git/refs", "POST", {"ref": f"refs/tags/{tag}", "sha": source})
    elif ref["object"]["type"] != "commit" or ref["object"]["sha"] != source:
        raise Stop("Snapshot tag differs from source")
    releases = api.pages("releases")
    release = next((item for item in releases if item["tag_name"] == tag), None)
    if release is None:
        release = api.request(
            "releases",
            "POST",
            {
                "tag_name": tag,
                "target_commitish": source,
                "name": f"Personal build {source[:12]}",
                "draft": True,
                "prerelease": True,
                "make_latest": "false",
                "body": "Personal macOS arm64, Windows x64, and Linux x64 packages. "
                "macOS is not Developer ID signed or notarized. Install manually. "
                "This prerelease does not update existing installations. "
                f"Source commit: {source}. Verify downloads against SHA256SUMS.",
            },
        )
    if release["target_commitish"] != source or not release["prerelease"]:
        raise Stop("Existing release has a different source or channel")
    ref = api.request(f"git/ref/tags/{tag}")
    if ref["object"]["type"] != "commit" or ref["object"]["sha"] != source:
        raise Stop("Snapshot tag does not point to the source commit")
    expected = {path.name: digest for path, digest in local}
    remote = api.pages(f"releases/{release['id']}/assets")
    if any(item["name"] not in expected for item in remote):
        raise Stop("Unexpected remote asset")
    for path, digest in local:
        found = next((item for item in remote if item["name"] == path.name), None)
        if found and found.get("state") == "starter":
            current = api.request(f"releases/{release['id']}")
            current_ref = api.request(f"git/ref/tags/{tag}")
            asset = api.request(f"releases/assets/{int(found['id'])}")
            if (
                not current["draft"]
                or current["target_commitish"] != source
                or not current["prerelease"]
                or current["tag_name"] != tag
                or current_ref["object"]["type"] != "commit"
                or current_ref["object"]["sha"] != source
                or asset.get("state") != "starter"
                or asset.get("size") != 0
                or asset.get("digest") is not None
                or asset.get("name") != path.name
            ):
                raise Stop("Incomplete asset cannot be recovered safely")
            api.request(f"releases/assets/{int(found['id'])}", "DELETE")
            found = None
        if found:
            if found.get("digest") != digest:
                raise Stop("Existing asset digest differs")
        elif release["draft"]:
            current = api.request(f"releases/{release['id']}")
            if (
                not current["draft"]
                or current["target_commitish"] != source
                or not current["prerelease"]
            ):
                raise Stop("Release changed before upload")
            upload(api, release["id"], path)
        else:
            raise Stop("Published snapshot is incomplete")
    remote = api.pages(f"releases/{release['id']}/assets")
    if {item["name"]: item.get("digest") for item in remote} != expected:
        raise Stop("Uploaded artifact set differs")
    if release["draft"]:
        current = api.request(f"releases/{release['id']}")
        if (
            not current["draft"]
            or current["target_commitish"] != source
            or not current["prerelease"]
        ):
            raise Stop("Release changed during upload")
        api.request(
            f"releases/{release['id']}",
            "PATCH",
            {"draft": False, "make_latest": "false"},
        )
    print(f"Snapshot verified: {tag}")


if __name__ == "__main__":
    try:
        api = GitHub()
        source = sha(os.environ["SOURCE_SHA"])
        if len(sys.argv) == 2 and sys.argv[1] == "verify":
            verify_source(api, source)
        else:
            publish(api, source, Path(os.environ["ARTIFACTS_DIR"]))
    except (Stop, KeyError, ValueError, OSError) as error:
        print(
            "Snapshot stopped: "
            + (
                str(error)
                if isinstance(error, Stop)
                else "invalid input or local operation failed"
            ),
            file=sys.stderr,
        )
        sys.exit(1)
