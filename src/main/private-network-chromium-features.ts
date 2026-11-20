import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRemoteNetworkRoute } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

// The file that `remote-network-route-preference-store.ts` stores the route in. Read here with plain
// `readFileSync` because this runs before `app.whenReady`, where the effectful store cannot load yet.
const ROUTE_PREFERENCE_FILE = "openbot-remote-network-route-v1.json";

/**
 * The Chromium features that this build turns off.
 *
 * `FedCm` is off for every route, as before. On the private network route this host must also show
 * its own addresses: Chromium hides local host IPs behind mDNS names (`WebRtcHideLocalIpsWithMdns`),
 * and such a name resolves only on the local link. `isPrivateNetworkAddress` accepts tailnet
 * addresses (100.64.0.0/10, fd00::/8) so a device on the tailnet can connect, but a hidden address
 * never becomes a candidate, and the route then has nothing to offer. Only the host needs this: a
 * device that still hides its own addresses connects once the host's candidate is a real address.
 */
export function disabledChromiumFeatures(userData: string): string[] {
  const features = ["FedCm"];
  if (privateNetworkRoute(userData)) features.push("WebRtcHideLocalIpsWithMdns");
  return features;
}

/** Whether this computer is on the private network route. Anything unreadable means the default. */
function privateNetworkRoute(userData: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(userData, ROUTE_PREFERENCE_FILE), "utf8"));
    return isDynamicRecord(parsed) && isRemoteNetworkRoute(parsed.route) && parsed.route === "private";
  } catch {
    return false;
  }
}
