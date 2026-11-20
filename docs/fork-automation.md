# Fork automation

These workflows are under development. Automatic merging, signing, publishing,
and client updates have not yet been verified end to end.

## Who may merge

`maintenance` requires these checks: `Detect changed areas`, `Check`,
`Tests (desktop 1/2)`, `Tests (desktop 2/2)`, `Browser smoke` and
`Codex review finished`. These checks are required and strict on both `main`
and `maintenance`, including administrators. They do not yet establish a safe
trust boundary for code that can modify workflow definitions.

`fork-merge-gate.yml` supplies `Codex review finished`. Automatic merging is
currently disabled until the controller's trust boundaries have been verified.
The gate reads the state the Codex connector keeps in its summary comment
and accepts only that comment from `chatgpt-codex-connector[bot]`. The state names
the reviewed commit; manual dispatch also checks its run SHA against the PR
head. These checks still require end-to-end verification.

## Upstream

`fork-upstream-sync.yml` is intended to run daily and on demand, merge
`nightly-labs/openbot` `main` into `automation/upstream-sync`, and open or update
a pull request to `maintenance`. It stays inactive unless the repository variable
`FORK_SYNC_ENABLED` is `true`, and it deliberately fails after opening the PR until
trusted CI dispatch and review are implemented. It is not on the default branch,
so scheduling is not active.

A pull request opened with `GITHUB_TOKEN` does not start the required checks, and
this repository has no token that can. Enabling the schedule therefore needs an
installation token or fine-grained token with permission to create runs, which
means a new credential and a deliberate decision to give the workflow that
access. Until then the sync stays off rather than opening pull requests that
nothing can verify.

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
`package.json`, checks that a tag points into `maintenance` history, and prepares
the native runtimes. The publish job is disabled unless
`PERSONAL_RELEASE_ENABLED` is explicitly enabled. The workflow still needs
independent checks of CI, review status, and upgrade safety before publication.
It creates personal macOS and Windows artifacts without Developer ID or Windows
signing, and runs both jobs on relevant pull requests. macOS auto-update and
installation of the personal build are not yet verified.

The hosted server's updater reads `latest-linux.yml` from the newest release of
this repository and downloads the AppImage it names, and the desktop app reads
`latest-mac.yml`. Both point here because `electron-builder.yml` and
`scripts/hosting/openbot-hosted-update` name this repository rather than
upstream.

The update script accepts only `X.Y.Z` versions without a prerelease suffix and
expects the artifact named `OpenBot-$version-$architecture.AppImage`. It stages
an update only when its version is newer than the installed version. A fork
release therefore needs a version greater than the installed upstream build;
building the same or an older version cannot validate an upgrade.

The macOS job does not use Developer ID or Apple notarization; the Windows job
does not use a Windows signing identity. These builds can trigger operating
system security prompts. The published macOS updater normally requires signing,
so artifact generation alone does not verify that updates can be installed.
Any eventual release requires successful builds on all three platforms, and the
release automation and trust boundaries still need end-to-end verification.

Only macOS arm64, Windows x64, and Linux x64 artifacts are produced. The
updater's Linux arm64 feed and Intel macOS feed therefore stay unpublished, and
a machine on either of those platforms has no compatible fork update. That is a
deliberate limit of the personal build: add the missing architectures before
treating the fork feed as complete for other machines. The publish job releases
only the manifests the three jobs actually upload, so a missing feed is never
replaced by a manifest for a different architecture.

## Where the explanations live

The workflows carry no comments: the repository's rules keep comments out of
configuration and put reasons in a document. This file is that document. When a
workflow changes, change this file with it.
