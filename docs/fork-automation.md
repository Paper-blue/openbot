# Personal fork automation

The owner has authorized OpenAI API usage and personal macOS packages without
Developer ID signing or notarization. The control plane runs on GitHub-hosted
runners. It does not need an online Mac or a Codex Cloud session.

## Branches and activation

`main` holds trusted workflow definitions and control scripts. `maintenance` holds
the product source. Install this change through the existing bootstrap PR into
`maintenance`, then review the maintenance-to-main PR before enabling schedules.
GitHub reads scheduled workflows from the default branch. A workflow file that
exists only on a development branch is not an active schedule.

Keep `main` and `maintenance` protected, including administrators. Retain the
existing strict CI requirements and `Codex review finished` requirement. Add
`Maintenance controller process checks` to required checks after its first run.
Do not give the maintenance App a ruleset or branch-protection bypass.

Before setting any enable flag, create the GitHub Environment `fork-control`.
Set its deployment branch policy to selected branches, with exactly `main`.
Do not allow tags, pull-request refs, or other branches. Do not require a manual
reviewer if unattended runs are wanted. Store these secrets in that Environment,
not as repository secrets:

| Setting | Kind | Value |
| --- | --- | --- |
| `OPENAI_API_KEY` | Environment secret | A project-specific OpenAI API key |
| `MAINTENANCE_APP_PRIVATE_KEY` | Environment secret | Private key for the repository-scoped GitHub App |
| `MAINTENANCE_APP_ID` | Repository variable | App numeric ID |
| `MAINTENANCE_BOT_LOGIN` | Repository variable | App login including `[bot]` |
| `MAINTENANCE_MODEL` | Repository variable | Optional API model; empty uses the Codex default |
| `MAINTENANCE_REVIEW_MODEL` | Repository variable | Optional separate review model |
| `FORK_CODEX_ENABLED` | Repository variable | `true` enables Issue work and API reviews |
| `FORK_SYNC_ENABLED` | Repository variable | `true` enables upstream synchronization |
| `FORK_AUTOMERGE_ENABLED` | Repository variable | `true` enables the trusted merge controller |
| `PERSONAL_SNAPSHOT_ENABLED` | Repository variable | `true` enables manual-install prereleases |

Install the GitHub App on this repository only. It needs Contents, Pull requests,
Issues, Commit statuses, and Actions read/write. Metadata and Administration are
read-only; Administration read permits inspection of branch protection. It does
not need Administration write, Workflows, or organization permissions. App installation
tokens are short-lived and allow created PRs to trigger checks without a manual
approval. Do not replace them with a broadly scoped personal token.

Create `codex-ready` once in the repository's Labels page. Other queue labels are
created by the controller when the first authorized task starts. The sync job
creates its own two labels.

Enable Issue work first, run a small controlled Issue through the pipeline, and
then enable merging, synchronization, and snapshots. All flags are off when
unset. Existing ChatGPT/Codex scheduled tasks must be inspected and paused during
cutover; these files cannot inspect or change those tasks.

## Issue development and repair

Add `codex-ready` to an Issue with reproduction steps and acceptance criteria.
Only an actor with write, maintain, or admin permission can authorize work. The
controller also checks the label's recorded actor during scheduled selection
and before publication. A ready label applied by a read-only or triage user does
not authorize API spending.

`fork-maintenance.yml` starts on a ready-label event, daily at 01:00 UTC
(09:00 Asia/Shanghai), on CI completion, or by manual dispatch on `main`.
GitHub schedule execution can be delayed. The controller and upstream sync share
a concurrency group; active work is never cancelled by a new queue event.

One Issue is selected per run. It receives a durable attempt marker before API
work starts. The worker checks out a fixed commit, installs frozen dependencies
without lifecycle scripts, and uses the official Codex Action in the workspace
permission profile with `drop-sudo`. It receives the API proxy, but no App key,
Git write token, server credentials, or release credentials. The Codex home is a
fresh runner-temporary directory, not repository-provided configuration. All
Actions are pinned to commit SHAs.

The worker exports a patch. A new job downloads the immutable plan and patch,
checks the selected commit and current authorization, applies the patch without
executing product scripts, and checks all changed paths. It refuses patches over
2 MB or 50 files, symlinks, submodules, automation, agent configuration, signing,
update controls, database migrations, and selected permission-boundary paths.
These tasks need a maintainer-driven PR. Git creates a commit directly from the
validated index; no generated hooks or test scripts run in the publication job.
The App pushes a normal fast-forward branch and opens or updates the Issue PR.

A separate disposable runner reviews the full PR diff with a fresh read-only
Codex session and structured output. A separate trusted job validates that output,
checks the head SHA again, writes a PR comment, and publishes `Codex API review`
with the App's identity. The existing Codex connector review remains an additional
required check during this rollout.

A failed API review or failed CI check selects a repair on a later controller run.
The repair prompt includes the latest independent findings and failed check names.
The controller makes at most two repair rounds after the initial implementation.
After that it labels the PR `codex-blocked` and leaves it open. Worker timeouts,
missing output, protected patches, and publication errors produce an Issue
notification and do not trigger unbounded retries. A maintainer must investigate
an attempt that stopped before opening a PR; remove the bot's attempt marker only
after confirming there is no active run or corresponding branch/PR.

The 45-minute development and 30-minute review limits bound runtime, not exact
API cost. Configure a dedicated API project and monitor its usage; budget alerts
alone are not a hard spending cap. There is no automatic model fallback or
unbounded self-retry loop.

## Merge controller

Only `main` executes the merge controller. The old PR-controlled merge job has
been removed. Eligible PRs must be authored by the configured App, use a known
Issue or sync branch, have `codex-managed` and `automerge`, and not be drafts.

The controller rejects protected file changes, requires a successful API review
from the configured App for the exact head, and reads strict branch protection.
It requires successful mandatory checks and permits skipped optional test lanes.
It checks that the current base is an ancestor of the PR head and rechecks both
head and base before a SHA-bound merge request. GitHub branch protection remains
the final authority. API errors, stale bases, missing reviews, or missing checks
stop merging. Issue PRs use squash; upstream PRs use merge to retain ancestry.

A source change to the base may require updating a PR branch and rerunning its
checks before merging. The controller does not silently merge an out-of-date PR.

## Upstream synchronization

`fork-upstream-sync.yml` checks upstream `nightly-labs/openbot` `main` daily at
01:17 UTC and on manual dispatch. It merges into `automation/upstream-sync`,
retains an existing sync branch, and uses a normal push. There are no forced
branch updates. Merge conflicts stop the job and require investigation.

The App-created PR starts CI. The sync job then dispatches the trusted Issue
controller on `main` for an independent API review. Upstream changes to workflow,
update, migration, signing, or other protected paths remain manual merge tasks.
A successful textual merge is not evidence of runtime compatibility.

## Personal builds and publication

`fork-release.yml` remains the three-platform builder. It can now be called by
`fork-personal-release.yml` with an exact source SHA. The build jobs have read-only
GitHub permissions and no inherited App or OpenAI secrets. macOS sets
`CSC_IDENTITY_AUTO_DISCOVERY=false`, `mac.identity=null`, and `mac.notarize=false`.
It produces arm64 DMG and ZIP; Windows produces an x64 installer; Linux produces
an x64 AppImage. Artifact and updater-metadata validation still runs.

After successful push CI on `maintenance`, the trusted snapshot workflow verifies
source ancestry and successful CI, then calls those build jobs. Publication runs
in a new job from the trusted control commit. It creates an immutable
`personal-<full-source-sha>` tag and a prerelease that is not marked latest.
The publication script validates the four platform packages, computes SHA-256
checksums, and uploads the packages plus `SHA256SUMS`. It does not publish updater
feeds or blockmaps. Thus these personal snapshots do not replace installed apps.
They also avoid version bumps just to identify a rebuild of the same upstream
version; the tag and release body identify the exact source commit.

Only one snapshot writer runs at a time. An interrupted upload can resume the same
draft. Existing assets must have matching GitHub digests. Unexpected assets,
changed tags, changed release state, missing CI, or digest mismatches stop the
publisher. Published assets are never overwritten or deleted.

macOS packages require manual installation and may require an explicit OS allow
step. Developer ID, notarization, TCC permission continuity, Windows installation,
Linux service upgrades, database-aware rollback, and automatic device updates are
separate acceptance tasks. No existing installation is changed by this pipeline.

The older stable-tag publisher remains gated by `PERSONAL_RELEASE_ENABLED`.
Leave that flag off during this rollout. A stable version bump or tag still
requires the repository's release-upgrade audit.

## Validation and current limits

Run `python3 scripts/fork-maintenance-e2e.py` to exercise the controller against a
loopback HTTP API and real temporary Git repositories. It writes a JSON report
under `.openbot-build/fork-maintenance-e2e/`. A sandbox that forbids loopback
sockets can run `--offline`; this uses the same API fixture via process-local
transport while still executing the real controller and Git subprocesses. CI runs
the HTTP version in `fork-controller-check.yml`.

The process fixture checks queue deduplication, maintainer authorization, repair
limits, protected patches, Git publication, stale review rejection, merge gates,
interrupted release recovery, digests, idempotence, and source CI. It does not prove
live API authentication, GitHub App setup, actual Codex output quality, real
cross-platform installation, or the full unattended production chain.

The repository does not contain the owner's API key or App private key. Live
acceptance requires the Environment and App setup above, the trusted definitions
on `main`, an actual Issue, independent review, CI, and a real three-platform
snapshot run. Report these milestones separately.
