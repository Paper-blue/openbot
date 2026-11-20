import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { disabledChromiumFeatures } from "./private-network-chromium-features";

const folders: string[] = [];

function preferences(content?: string): string {
  const folder = mkdtempSync(join(tmpdir(), "openbot-route-test-"));
  folders.push(folder);
  if (content !== undefined) writeFileSync(join(folder, "openbot-remote-network-route-v1.json"), content);
  return folder;
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("private network Chromium features", () => {
  it("exposes host candidates only for the supported private route preference", () => {
    expect(disabledChromiumFeatures(preferences('{"version":1,"route":"private"}'))).toEqual([
      "FedCm",
      "WebRtcHideLocalIpsWithMdns",
    ]);
  });

  it("keeps the default features when the route is absent or invalid", () => {
    for (const content of [
      undefined,
      "invalid json",
      '{"version":2,"route":"private"}',
      '{"version":1,"route":"openbot"}',
      '{"version":1,"route":"unknown"}',
    ]) {
      expect(disabledChromiumFeatures(preferences(content))).toEqual(["FedCm"]);
    }
  });
});
