# Fork automation

These workflows are under development. Automatic merging, signing, publishing,
and client updates have not yet been verified end to end.

## Who may merge

`maintenance` requires these checks: `Detect changed areas`, `Check`,
`Tests (desktop 1/2)`, `Tests (desktop 2/2)`, `Browser smoke` and
`Codex review finished`. A change lands only when the checks pass and Codex
finished reviewing the exact commit being merged with no unresolved finding.

`fork-merge-gate.yml` supplies `Codex review finished` and switches on
auto-merge. It reads the state the Codex connector keeps in its summary comment
and accepts only that comment from `chatgpt-codex-connector[bot]`, so another
commenter cannot claim a review happened. The state names the reviewed commit,
so a review of an older push never unlocks a newer one.

Auto-merge turns on for pull requests this repository produces by itself: those
carrying the `automerge` label, and those opened by a bot such as Codex. A pull
request opened by a person waits for that person.

## Upstream

`fork-upstream-sync.yml` runs daily and on demand. It merges
`nightly-labs/openbot` `main` into `automation/upstream-sync`, opens or updates a
pull request to `maintenance`, and enables auto-merge.

It merges rather than squashes because the next sync asks whether upstream `main`
is already an ancestor of `maintenance`. A squash would copy the file changes
without the commits, so every sync after the first would try to replay work that
is already present.

A merge that conflicts stops the run and opens an issue. Resolution is manual: a
guessed resolution to inherited upstream code is worse than a person looking at
it.

Events created with the workflow token do not start other workflows, so the sync
also dispatches `ci.yml` and `fork-merge-gate.yml` for the branch it pushed.
Without that the required checks would never report and the pull request could
not merge.

## Releases

`fork-release.yml` builds on a `v*.*.*` tag. It checks the tag against
`package.json` and prepares the native runtimes. The publish job requires Linux,
signed and notarized macOS, and Windows builds to succeed. It checks their
update manifests and packages, uploads them to a draft release, then publishes
it. This workflow has not yet been validated end to end.

The hosted server's updater reads `latest-linux.yml` from the newest release of
this repository and downloads the AppImage it names, and the desktop app reads
`latest-mac.yml`. Both point here because `electron-builder.yml` and
`scripts/hosting/openbot-hosted-update` name this repository rather than
upstream.

The update script accepts only `X.Y.Z` versions without a prerelease suffix and
expects the artifact named `OpenBot-$version-$architecture.AppImage`. A
prerelease tag builds but cannot be installed by the hosted server.

The macOS job requires `MAC_RELEASE_ENABLED=true` and signing and notarization
secrets. The Windows job runs an unsigned x64 build on relevant pull requests
and on manual dispatch for verification only; tag-triggered runs fail until a
signing solution is configured.
Without successful builds on all three platforms no release is published. The
release credentials and the automation's trust boundaries still need verification.

## Where the explanations live

The workflows carry no comments: the repository's rules keep comments out of
configuration and put reasons in a document. This file is that document. When a
workflow changes, change this file with it.
