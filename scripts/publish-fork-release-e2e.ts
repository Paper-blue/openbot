import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDynamicRecord } from "../packages/contracts/src/runtime-values";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "publish-fork-release.ts");
const OUT = join(ROOT, ".openbot-build", "publish-fork-release-e2e");
const REPOSITORY = "example-fork/openbot";
const TAG = "v1.2.3";
const TOKEN = "ghs_e2e_fork_release_token";
const RUN_TIMEOUT_MS = 60_000;
const RELEASE_ID = 501;
const OTHER_DIGEST = `sha256:${"0".repeat(64)}`;
const APPIMAGE = "OpenBot-1.2.3-x86_64.AppImage";
const MANIFEST = "latest.yml";

const ARTIFACTS = {
  "latest-linux.yml": "version: 1.2.3\npath: OpenBot-1.2.3-x86_64.AppImage\n",
  "latest-mac.yml": "version: 1.2.3\npath: OpenBot-1.2.3-arm64.zip\n",
  "latest.yml": "version: 1.2.3\npath: OpenBot-1.2.3-x64.exe\n",
  "OpenBot-1.2.3-arm64.zip": "mac zip bytes",
  "OpenBot-1.2.3-arm64.zip.blockmap": "zip blockmap",
  "OpenBot-1.2.3-arm64.dmg": "mac dmg bytes",
  "OpenBot-1.2.3-arm64.dmg.blockmap": "dmg blockmap",
  "OpenBot-1.2.3-x86_64.AppImage": "linux AppImage bytes",
  "OpenBot-1.2.3-x64.exe": "windows installer bytes",
  "OpenBot-1.2.3-x64.exe.blockmap": "exe blockmap",
};

const FILES = Object.entries(ARTIFACTS);
const DIGESTS = new Map(FILES.map(([name, content]) => [name, digestOf(content)]));

const RELEASE_TAG = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/[^/]+$/;
const RELEASES = /^\/repos\/[^/]+\/[^/]+\/releases$/;
const RELEASE = /^\/repos\/[^/]+\/[^/]+\/releases\/\d+$/;
const RELEASE_ASSETS = /^\/repos\/[^/]+\/[^/]+\/releases\/\d+\/assets$/;
const TAG_REF = /^\/repos\/[^/]+\/[^/]+\/git\/ref\/tags\/[^/]+$/;

interface StubAsset {
  readonly name: string;
  readonly digest: string;
}

interface StubRelease {
  readonly id: number;
  draft: boolean;
  readonly assets: StubAsset[];
}

interface StubRequest {
  readonly method: string;
  readonly path: string;
  readonly uploadName: string | null;
}

interface StubState {
  release: StubRelease | null;
  lookupStatus: number | null;
  echoedAuthorization: string;
  injectExtraOnVerification: boolean;
  publishBeforeUpload: boolean;
  readonly requests: StubRequest[];
  readonly uploads: Map<string, number>;
}

interface Stub {
  readonly base: string;
  readonly state: StubState;
  readonly close: () => Promise<void>;
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Outcome {
  readonly run: Run;
  readonly state: StubState;
}

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

function digestOf(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function respond(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function routeUpload(response: ServerResponse, state: StubState, uploadName: string, body: Buffer): void {
  if (state.release === null) {
    respond(response, 422, { message: "The upload needs a release" });
    return;
  }
  if (state.release.assets.some((asset) => asset.name === uploadName)) {
    respond(response, 422, { message: "already_exists" });
    return;
  }
  const digest = digestOf(body);
  state.release.assets.push({ name: uploadName, digest });
  state.uploads.set(uploadName, (state.uploads.get(uploadName) ?? 0) + 1);
  respond(response, 201, { name: uploadName, digest });
}

function routeRelease(response: ServerResponse, state: StubState, authorization: string): void {
  if (state.lookupStatus !== null) {
    state.echoedAuthorization = authorization;
    respond(response, state.lookupStatus, { message: `Authorization ${authorization} is not permitted` });
    return;
  }
  if (state.release === null) {
    respond(response, 404, { message: "Not Found" });
    return;
  }
  if (
    state.publishBeforeUpload &&
    state.requests.filter((request) => request.method === "GET" && RELEASE_TAG.test(request.path)).length > 1
  ) {
    state.release.draft = false;
  }
  respond(response, 200, { id: state.release.id, tag_name: TAG, name: TAG, draft: state.release.draft });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  state: StubState,
  body: Buffer,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://stub.invalid");
  const method = request.method ?? "GET";
  const uploadName = url.searchParams.get("name");
  const authorization = request.headers.authorization ?? "";
  if (method === "GET" && RELEASE_TAG.test(url.pathname)) {
    routeRelease(response, state, authorization);
    return;
  }
  if (method === "GET" && TAG_REF.test(url.pathname)) {
    respond(response, 200, { ref: `refs/tags/${TAG}` });
    return;
  }
  if (method === "POST" && RELEASES.test(url.pathname)) {
    if (state.release !== null) {
      respond(response, 422, { message: "already_exists" });
      return;
    }
    state.release = { id: RELEASE_ID, draft: true, assets: [] };
    respond(response, 201, { id: RELEASE_ID, draft: true });
    return;
  }
  if (method === "GET" && RELEASE_ASSETS.test(url.pathname)) {
    if (state.injectExtraOnVerification && state.uploads.size === FILES.length && state.release !== null) {
      state.release.assets.push({ name: "unexpected.exe", digest: OTHER_DIGEST });
      state.injectExtraOnVerification = false;
    }
    respond(response, 200, state.release?.assets ?? []);
    return;
  }
  if (method === "PATCH" && RELEASE.test(url.pathname)) {
    const patch = JSON.parse(body.toString());
    if (!isDynamicRecord(patch) || patch.draft !== false) {
      respond(response, 422, { message: "The patch body has no draft field" });
      return;
    }
    if (state.release !== null) state.release.draft = false;
    respond(response, 200, { id: state.release?.id ?? RELEASE_ID, draft: false });
    return;
  }
  if (method === "POST" && RELEASE_ASSETS.test(url.pathname)) {
    if (uploadName === null) {
      respond(response, 422, { message: "The upload needs an asset name" });
      return;
    }
    routeUpload(response, state, uploadName, body);
    return;
  }
  respond(response, 404, { message: `No stub route for ${method} ${url.pathname}` });
}

async function startStub(setup: (state: StubState) => void): Promise<Stub> {
  const state: StubState = {
    release: null,
    lookupStatus: null,
    echoedAuthorization: "",
    injectExtraOnVerification: false,
    publishBeforeUpload: false,
    requests: [],
    uploads: new Map(),
  };
  setup(state);
  const server = createServer((request, response) => {
    const recorded = new URL(request.url ?? "/", "http://stub.invalid");
    state.requests.push({
      method: request.method ?? "GET",
      path: recorded.pathname,
      uploadName: recorded.searchParams.get("name"),
    });
    readBody(request)
      .then((body) => route(request, response, state, body))
      .catch(() => response.destroy());
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The stub server has no port.");
  const close = () =>
    new Promise<void>((closed) => {
      server.closeAllConnections();
      server.close(() => closed());
    });
  return { base: `http://127.0.0.1:${address.port}`, state, close };
}

function runScript(environment: Record<string, string>): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? tmpdir(),
        REPO: REPOSITORY,
        TAG,
        GH_TOKEN: TOKEN,
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const guard = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(guard);
      fail(error);
    });
    child.on("close", (code) => {
      clearTimeout(guard);
      done({ code, stdout, stderr });
    });
  });
}

async function publishCase(
  setup: (state: StubState) => void,
  files: readonly (readonly [string, string])[] = FILES,
): Promise<Outcome> {
  const workspace = mkdtempSync(join(tmpdir(), "openbot-fork-release-"));
  const stub = await startStub(setup);
  try {
    const artifacts = join(workspace, "artifacts");
    mkdirSync(artifacts);
    for (const [name, content] of files) writeFileSync(join(artifacts, name), content);
    const run = await runScript({
      ARTIFACTS_DIR: artifacts,
      GITHUB_API_URL: stub.base,
      GITHUB_UPLOADS_URL: stub.base,
    });
    return { run, state: stub.state };
  } finally {
    await stub.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

function digestOnRelease(state: StubState, name: string): string | null {
  return state.release?.assets.find((asset) => asset.name === name)?.digest ?? null;
}

function holdsExactly(state: StubState, digests: Map<string, string>): boolean {
  if (state.release === null) return false;
  if (state.release.assets.length !== digests.size) return false;
  return [...digests].every(([name, digest]) => digestOnRelease(state, name) === digest);
}

function uploadsOf(state: StubState, name: string): number {
  return state.uploads.get(name) ?? 0;
}

function recordOutcome(name: string, outcome: Outcome): void {
  outputs.push(outcome.run.stdout, outcome.run.stderr);
  runs.push({ name, exitCode: outcome.run.code, mutations: mutations(outcome.state) });
}

const checks: Check[] = [];
const outputs: string[] = [];
const runs: { name: string; exitCode: number | null; mutations: string[] }[] = [];

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

function creates(state: StubState): number {
  return state.requests.filter((request) => request.method === "POST" && request.uploadName === null).length;
}

function mutations(state: StubState): string[] {
  return state.requests
    .filter((request) => request.method !== "GET")
    .map((request) => {
      const suffix = request.uploadName === null ? "" : ` ${request.uploadName}`;
      return `${request.method} ${request.path}${suffix}`;
    });
}

const fresh = await publishCase(() => {});
recordOutcome("publishes a new tag", fresh);
check("a new tag creates one draft release", creates(fresh.state) === 1, `${creates(fresh.state)} creates`);
check(
  "a new tag publishes the release",
  fresh.run.code === 0 && fresh.state.release?.draft === false,
  `exit ${fresh.run.code}`,
);
check(
  "a new tag uploads every artifact once",
  [...DIGESTS.keys()].every((name) => uploadsOf(fresh.state, name) === 1),
  JSON.stringify([...fresh.state.uploads]),
);
check(
  "the published release holds every artifact with its local digest",
  holdsExactly(fresh.state, DIGESTS),
  JSON.stringify(fresh.state.release?.assets ?? null),
);

const resumed = await publishCase((state) => {
  state.release = {
    id: RELEASE_ID,
    draft: true,
    assets: [{ name: APPIMAGE, digest: DIGESTS.get(APPIMAGE) ?? "" }],
  };
});
recordOutcome("continues an interrupted draft", resumed);
check(
  "an interrupted run keeps the asset that the draft already holds",
  uploadsOf(resumed.state, APPIMAGE) === 0,
  JSON.stringify([...resumed.state.uploads]),
);
check(
  "an interrupted run uploads only the missing assets",
  [...DIGESTS.keys()].filter((name) => name !== APPIMAGE).every((name) => uploadsOf(resumed.state, name) === 1),
  JSON.stringify([...resumed.state.uploads]),
);
check(
  "an interrupted run publishes the release after it checks every artifact",
  resumed.run.code === 0 && resumed.state.release?.draft === false && holdsExactly(resumed.state, DIGESTS),
  `exit ${resumed.run.code}`,
);

const conflicting = await publishCase((state) => {
  state.release = { id: RELEASE_ID, draft: true, assets: [{ name: MANIFEST, digest: OTHER_DIGEST }] };
});
recordOutcome("stops on a different asset of the same name", conflicting);
check("a different asset of the same name fails the run", conflicting.run.code === 1, `exit ${conflicting.run.code}`);
check(
  "a different asset of the same name uploads nothing",
  conflicting.state.uploads.size === 0 && mutations(conflicting.state).length === 0,
  JSON.stringify(mutations(conflicting.state)),
);
check(
  "a different asset of the same name leaves the release a draft",
  conflicting.state.release?.draft === true && digestOnRelease(conflicting.state, MANIFEST) === OTHER_DIGEST,
  JSON.stringify(conflicting.state.release),
);
check(
  "a different asset of the same name names the asset",
  conflicting.run.stderr.includes(MANIFEST) && conflicting.run.stderr.includes("uploaded nothing"),
  "The message does not name the asset.",
);

const extraAsset = await publishCase((state) => {
  state.release = { id: RELEASE_ID, draft: true, assets: [{ name: "unexpected.exe", digest: OTHER_DIGEST }] };
});
recordOutcome("stops on an unexpected draft asset", extraAsset);
check(
  "an unexpected asset leaves the release untouched and unpublished",
  extraAsset.run.code === 1 && extraAsset.state.release?.draft === true && mutations(extraAsset.state).length === 0,
  JSON.stringify(mutations(extraAsset.state)),
);

const changedDraft = await publishCase((state) => {
  state.release = { id: RELEASE_ID, draft: true, assets: [] };
  state.publishBeforeUpload = true;
});
recordOutcome("stops if the draft is published before upload", changedDraft);
check(
  "a changed draft prevents uploads",
  changedDraft.run.code === 1 && mutations(changedDraft.state).length === 0,
  JSON.stringify(mutations(changedDraft.state)),
);

const lateExtra = await publishCase((state) => {
  state.injectExtraOnVerification = true;
});
recordOutcome("stops on an extra asset at final verification", lateExtra);
check(
  "an asset added after upload prevents publication",
  lateExtra.run.code === 1 &&
    lateExtra.state.release?.draft === true &&
    !mutations(lateExtra.state).some((item) => item.startsWith("PATCH ")),
  JSON.stringify(mutations(lateExtra.state)),
);

const publishedExtra = await publishCase((state) => {
  state.release = {
    id: RELEASE_ID,
    draft: false,
    assets: [...DIGESTS]
      .map(([name, digest]) => ({ name, digest }))
      .concat([{ name: "unexpected.exe", digest: OTHER_DIGEST }]),
  };
});
recordOutcome("refuses an extra asset in a published release", publishedExtra);
check(
  "a published release with an extra asset is rejected without mutation",
  publishedExtra.run.code === 1 && mutations(publishedExtra.state).length === 0,
  JSON.stringify(mutations(publishedExtra.state)),
);

const localExtra = await publishCase(() => {}, [...FILES, ["unexpected.blockmap", "other bytes"]]);
recordOutcome("rejects an extra local artifact", localExtra);
check(
  "an extra local artifact makes no request",
  localExtra.run.code === 1 && localExtra.state.requests.length === 0,
  JSON.stringify(localExtra.state.requests),
);

const published = await publishCase((state) => {
  state.release = {
    id: RELEASE_ID,
    draft: false,
    assets: [...DIGESTS].map(([name, digest]) => ({ name, digest })),
  };
});
recordOutcome("leaves a published release unchanged", published);
check("a published release with matching assets passes", published.run.code === 0, `exit ${published.run.code}`);
check(
  "a published release with matching assets gets no change",
  mutations(published.state).length === 0,
  JSON.stringify(mutations(published.state)),
);
check(
  "a published release keeps its assets",
  holdsExactly(published.state, DIGESTS),
  JSON.stringify(published.state.release?.assets ?? null),
);

for (const status of [403, 503]) {
  const failed = await publishCase((state) => {
    state.lookupStatus = status;
  });
  recordOutcome(`reports a ${status} lookup error`, failed);
  check(`a ${status} lookup error fails the run`, failed.run.code === 1, `exit ${failed.run.code}`);
  check(
    `a ${status} lookup error creates no release`,
    failed.state.release === null && mutations(failed.state).length === 0,
    JSON.stringify(mutations(failed.state)),
  );
  check(
    `a ${status} lookup error reports the status`,
    failed.run.stderr.includes(`HTTP ${status}`),
    "The message has no HTTP status.",
  );
  check(
    `a ${status} lookup error comes back with the token`,
    failed.state.echoedAuthorization === `Bearer ${TOKEN}`,
    "The stub did not echo the token.",
  );
  check(
    `a ${status} lookup error keeps the token out of the output`,
    !failed.run.stdout.includes(TOKEN) && !failed.run.stderr.includes(TOKEN),
    "The output holds the token.",
  );
}

const incomplete = await publishCase(
  () => {},
  FILES.filter(([name]) => name !== MANIFEST),
);
recordOutcome("stops on an incomplete artifact set", incomplete);
check("an incomplete artifact set fails the run", incomplete.run.code === 1, `exit ${incomplete.run.code}`);
check(
  "an incomplete artifact set makes no request",
  incomplete.state.requests.length === 0,
  JSON.stringify(incomplete.state.requests),
);
check(
  "an incomplete artifact set names the missing manifest",
  incomplete.run.stderr.includes(MANIFEST),
  "The message does not name the manifest.",
);

check(
  "the token stays out of every run",
  outputs.every((text) => !text.includes(TOKEN)),
  "An output holds the token.",
);

const failed = checks.filter((item) => !item.passed);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ passed: failed.length === 0, runs, checks }, null, 2)}\n`);
for (const item of checks) process.stdout.write(`${item.passed ? "ok" : "FAILED"} ${item.name}\n`);
assert.equal(
  failed.length,
  0,
  `${failed.length} of ${checks.length} fork release checks failed; see ${join(OUT, "report.json")}.`,
);
process.stdout.write(`Passed ${checks.length} fork release checks. Wrote ${join(OUT, "report.json")}.\n`);
