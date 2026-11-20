# Fork automation

These workflows are under development. Automatic merging, signing, publishing,
and client updates have not yet been verified end to end.

## Who may merge

`maintenance` requires these checks: `Detect changed areas`, `Check`,
`Tests (desktop 1/2)`, `Tests (desktop 2/2)`, `Browser smoke` and
`Codex review finished`. A change lands only when the checks pass and Codex
finished reviewing the exact commit being merged with no unresolved finding.

`fork-merge-gate.yml` supplies `Codex review finished`. Automatic merging is
currently disabled until the controller's trust boundaries have been verified.
The gate reads the state the Codex connector keeps in its summary comment
and accepts only that comment from `chatgpt-codex-connector[bot]`. The state names
the reviewed commit; manual dispatch also checks its run SHA against the PR
head. These checks still require end-to-end verification.

## Upstream

`fork-upstream-sync.yml` is intended to run daily and on demand, merge
`nightly-labs/openbot` `main` into `automation/upstream-sync`, and open or update
a pull request to `maintenance`. It deliberately fails after opening the PR until
trusted CI dispatch and review are implemented. It is not on the default branch,
so scheduling is not active.

It merges rather than squashes because the next sync asks whether upstream `main`
is already an ancestor of `maintenance`. A squash would copy the file changes
without the commits, so every sync after the first would try to replay work that
is already present.

A merge that conflicts stops the run and opens an issue. Resolution is manual: a
guessed resolution to inherited upstream code is worse than a person looking at
it.

GitHub currently documents that `pull_request` opened, synchronize, and reopened
events caused by `GITHUB_TOKEN` may create runs that require approval; other
generated pull request activities do not trigger runs. `workflow_dispatch` is an
exception, but dispatching a workflow from the unreviewed sync branch can run
its workflow definition with write permissions. A trusted controller is needed
before automatic checks and merging can be enabled safely.

## Releases

`fork-release.yml` builds on a `v*.*.*` tag. It checks the tag against
`package.json` and prepares the native runtimes. The publish job is disabled
unless `PERSONAL_RELEASE_ENABLED` is explicitly enabled. The build workflow now
creates personal macOS and Windows artifacts without Developer ID or Windows
signing, and runs both jobs on relevant pull requests. macOS auto-update and
installation of the personal build are not yet verified.

The hosted server's updater reads `latest-linux.yml` from the newest release of
this repository and downloads the AppImage it names, and the desktop app reads
`latest-mac.yml`. Both point here because `electron-builder.yml` and
`scripts/hosting/openbot-hosted-update` name this repository rather than
upstream.

The update script accepts only `X.Y.Z` versions without a prerelease suffix and
expects the artifact named `OpenBot-$version-$architecture.AppImage`. A
prerelease tag builds but cannot be installed by the hosted server.

The macOS job does not use Developer ID or Apple notarization; the Windows job
does not use a Windows signing identity. These builds can trigger operating
system security prompts. The published macOS updater normally requires signing,
so artifact generation alone does not verify that updates can be installed.
Any eventual release requires successful builds on all three platforms, and the
release automation and trust boundaries still need end-to-end verification.

## Where the explanations live

The workflows carry no comments: the repository's rules keep comments out of
configuration and put reasons in a document. This file is that document. When a
workflow changes, change this file with it.
