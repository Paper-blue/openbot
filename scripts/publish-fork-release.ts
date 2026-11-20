import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isBoolean, isDynamicRecord, isNumber, isString } from "../packages/contracts/src/runtime-values";

const REDACTED = "[redacted]";
const ASSETS_PER_PAGE = 100;
const MAX_ASSET_PAGES = 10;
const REQUIRED_MANIFESTS = ["latest-linux.yml", "latest-mac.yml", "latest.yml"];
const REQUIRED_EXTENSIONS = [".AppImage", ".exe", ".zip"];
const API_VERSION = "2022-11-28";

class ReleaseFailure extends Error {}

interface ReleaseAsset {
  readonly name: string;
  readonly digest: string | null;
}

interface LocalAsset {
  readonly name: string;
  readonly path: string;
  readonly digest: string;
}

interface ReleaseState {
  readonly id: number;
  readonly draft: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new ReleaseFailure(`${name} is not set.`);
  return value;
}

function endpoint(name: string, host: string): URL {
  const url = new URL(process.env[name] ?? `https://${host}`);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  const allowed = (url.protocol === "https:" && url.hostname === host) || (url.protocol === "http:" && loopback);
  if (!allowed) throw new ReleaseFailure(`${name} must be https://${host} or http on the loopback address.`);
  return url;
}

const TOKEN = required("GH_TOKEN");
const REPOSITORY = required("REPO");
const TAG = required("TAG");
const ARTIFACTS = resolve(required("ARTIFACTS_DIR"));
const API = endpoint("GITHUB_API_URL", "api.github.com");
const UPLOADS = endpoint("GITHUB_UPLOADS_URL", "uploads.github.com");

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function redact(text: string): string {
  return text.replaceAll(TOKEN, REDACTED);
}

function isDigest(value: unknown): value is string | null {
  return value === null || isString(value);
}

async function send(method: string, url: URL, body?: BodyInit, contentType?: string): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${TOKEN}`,
    "x-github-api-version": API_VERSION,
  };
  if (contentType !== undefined) headers["content-type"] = contentType;
  try {
    return await fetch(url, { method, headers, body });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ReleaseFailure(`${method} ${url.href} failed: ${redact(reason)}.`);
  }
}

async function describe(response: Response): Promise<string> {
  const text = redact((await response.text()).trim()).slice(0, 300);
  return text === "" ? `HTTP ${response.status}` : `HTTP ${response.status}: ${text}`;
}

async function releaseStateOf(response: Response): Promise<ReleaseState> {
  const body = await response.json();
  if (!isDynamicRecord(body) || !isNumber(body.id) || !isBoolean(body.draft)) {
    throw new ReleaseFailure("The release lookup returned a body without an id and a draft flag.");
  }
  return { id: body.id, draft: body.draft };
}

function assetOf(value: unknown): ReleaseAsset {
  if (!isDynamicRecord(value) || !isString(value.name) || !isDigest(value.digest)) {
    throw new ReleaseFailure("The asset lookup returned an entry without a name and a digest field.");
  }
  return { name: value.name, digest: value.digest };
}

async function releaseAssetsOf(response: Response): Promise<ReleaseAsset[]> {
  const body = await response.json();
  if (!Array.isArray(body)) throw new ReleaseFailure("The asset lookup returned a body that is not a list.");
  return body.map((entry) => assetOf(entry));
}

async function findRelease(): Promise<ReleaseState | null> {
  const response = await send("GET", new URL(`/repos/${REPOSITORY}/releases/tags/${encodeURIComponent(TAG)}`, API));
  if (response.status === 404) return null;
  if (!response.ok) throw new ReleaseFailure(`The release lookup for ${TAG} failed: ${await describe(response)}.`);
  return releaseStateOf(response);
}

async function tagExists(): Promise<boolean> {
  const response = await send("GET", new URL(`/repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(TAG)}`, API));
  if (response.status === 404) return false;
  if (!response.ok) throw new ReleaseFailure(`The tag lookup for ${TAG} failed: ${await describe(response)}.`);
  return true;
}

async function releaseAssets(releaseId: number): Promise<ReleaseAsset[]> {
  const assets: ReleaseAsset[] = [];
  for (let page = 1; page <= MAX_ASSET_PAGES; page += 1) {
    const pageUrl = new URL(
      `/repos/${REPOSITORY}/releases/${releaseId}/assets?per_page=${ASSETS_PER_PAGE}&page=${page}`,
      API,
    );
    const response = await send("GET", pageUrl);
    if (!response.ok) throw new ReleaseFailure(`The asset lookup for ${TAG} failed: ${await describe(response)}.`);
    const pageAssets = await releaseAssetsOf(response);
    assets.push(...pageAssets);
    if (pageAssets.length < ASSETS_PER_PAGE) return assets;
  }
  throw new ReleaseFailure(`${TAG} holds more than ${ASSETS_PER_PAGE * MAX_ASSET_PAGES} assets.`);
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
  if (size === 0) throw new ReleaseFailure(`${path} is empty.`);
  return `sha256:${hash.digest("hex")}`;
}

function requiredAssetProblems(names: readonly string[]): string[] {
  const missingManifests = REQUIRED_MANIFESTS.filter((manifest) => !names.includes(manifest));
  const missingArtifacts = REQUIRED_EXTENSIONS.filter(
    (extension) => !names.some((name) => name.endsWith(extension)),
  ).map((extension) => `no ${extension} artifact`);
  return [...missingManifests, ...missingArtifacts];
}

async function localAssets(): Promise<LocalAsset[]> {
  const names = (await readdir(ARTIFACTS)).sort();
  const problems = requiredAssetProblems(names);
  if (problems.length > 0) throw new ReleaseFailure(`The artifact set is incomplete: ${problems}.`);
  const assets: LocalAsset[] = [];
  for (const name of names) {
    const path = join(ARTIFACTS, name);
    const info = await stat(path);
    if (!info.isFile()) throw new ReleaseFailure(`${path} is not a file.`);
    assets.push({ name, path, digest: await fileDigest(path) });
  }
  return assets;
}

function difference(asset: LocalAsset, remote: ReleaseAsset): string {
  return remote.digest === null
    ? `${asset.name} has no server digest`
    : `${asset.name} differs: the server holds ${remote.digest}, the local file is ${asset.digest}`;
}

function assetProblems(local: readonly LocalAsset[], remote: readonly ReleaseAsset[]): string[] {
  const byName = new Map(remote.map((asset) => [asset.name, asset]));
  return local.flatMap((asset) => {
    const match = byName.get(asset.name);
    if (match === undefined) return [`${asset.name} is missing`];
    return match.digest === asset.digest ? [] : [difference(asset, match)];
  });
}

async function createDraft(): Promise<ReleaseState> {
  const response = await send(
    "POST",
    new URL(`/repos/${REPOSITORY}/releases`, API),
    JSON.stringify({ tag_name: TAG, name: TAG, draft: true }),
    "application/json",
  );
  if (!response.ok)
    throw new ReleaseFailure(`Creating the draft release for ${TAG} failed: ${await describe(response)}.`);
  return releaseStateOf(response);
}

async function uploadAsset(releaseId: number, asset: LocalAsset): Promise<void> {
  const response = await send(
    "POST",
    new URL(`/repos/${REPOSITORY}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`, UPLOADS),
    await readFile(asset.path),
    "application/octet-stream",
  );
  if (!response.ok) throw new ReleaseFailure(`Uploading ${asset.name} failed: ${await describe(response)}.`);
  log(`Uploaded ${asset.name}.`);
}

async function uploadMissing(releaseId: number, local: readonly LocalAsset[]): Promise<void> {
  const remote = await releaseAssets(releaseId);
  const byName = new Map(remote.map((asset) => [asset.name, asset]));
  const missing = local.filter((asset) => !byName.has(asset.name));
  const conflicts = local.flatMap((asset) => {
    const match = byName.get(asset.name);
    return match === undefined || match.digest === asset.digest ? [] : [difference(asset, match)];
  });
  if (conflicts.length > 0) {
    throw new ReleaseFailure(
      `The draft release for ${TAG} already holds different assets, so this run uploaded nothing: ${conflicts}.`,
    );
  }
  const extra = remote.filter((asset) => !local.some((candidate) => candidate.name === asset.name));
  if (extra.length > 0) {
    log(`The draft release for ${TAG} also holds ${extra.map((asset) => asset.name)}; this run leaves them.`);
  }
  for (const asset of missing) await uploadAsset(releaseId, asset);
  if (missing.length === 0) log(`The draft release for ${TAG} already holds all ${local.length} assets.`);
}

async function verifyAssets(releaseId: number, local: readonly LocalAsset[]): Promise<void> {
  const problems = assetProblems(local, await releaseAssets(releaseId));
  if (problems.length > 0) {
    throw new ReleaseFailure(
      `The release for ${TAG} does not match the artifact set, so this run did not publish it: ${problems}.`,
    );
  }
  log(`Verified all ${local.length} assets of ${TAG} against their server digests.`);
}

async function publish(releaseId: number): Promise<void> {
  const response = await send(
    "PATCH",
    new URL(`/repos/${REPOSITORY}/releases/${releaseId}`, API),
    JSON.stringify({ draft: false }),
    "application/json",
  );
  if (!response.ok) throw new ReleaseFailure(`Publishing ${TAG} failed: ${await describe(response)}.`);
  log(`Published ${TAG}.`);
}

async function main(): Promise<void> {
  const local = await localAssets();
  const existing = await findRelease();
  if (existing === null) {
    if (!(await tagExists())) throw new ReleaseFailure(`The tag ${TAG} does not exist in ${REPOSITORY}.`);
    const created = await createDraft();
    log(`Created the draft release for ${TAG}.`);
    await uploadMissing(created.id, local);
    await verifyAssets(created.id, local);
    await publish(created.id);
    return;
  }
  if (!existing.draft) {
    const problems = assetProblems(local, await releaseAssets(existing.id));
    if (problems.length > 0) {
      throw new ReleaseFailure(
        `${TAG} is already published with other assets, so this run changed nothing: ${problems}.`,
      );
    }
    log(`${TAG} is already published with these assets; nothing to do.`);
    return;
  }
  log(`Continuing the draft release for ${TAG}.`);
  await uploadMissing(existing.id, local);
  await verifyAssets(existing.id, local);
  await publish(existing.id);
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof ReleaseFailure ? error.message : String(error instanceof Error ? error.stack : error);
  process.stderr.write(`${redact(message)}\n`);
  process.exitCode = 1;
}
