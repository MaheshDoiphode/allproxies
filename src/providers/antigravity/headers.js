import os from "node:os";
import { request } from "../../http/request.js";
import {
  HUB_MANIFEST_URL,
  HUB_VERSION_FLOOR,
  IDE_TYPE,
  ONBOARD_UA_SUFFIX,
  USER_AGENT_PRODUCT,
  X_GOOG_API_CLIENT,
} from "../../core/constants.js";

const VERSION_RE = /^version:\s*['"]?([0-9]+\.[0-9]+\.[0-9]+)/im;

export function osArch() {
  const system = os.platform();
  const machine = os.arch();
  const osName = { win32: "win32", darwin: "darwin", linux: "linux" }[system] || system || "linux";
  const arch = { x64: "x64", arm64: "arm64" }[machine] || machine || "x64";
  return `${osName}/${arch}`;
}

export function parseHubVersion(yamlText) {
  const match = VERSION_RE.exec(yamlText || "");
  return match ? match[1] : null;
}

function parts(value) {
  return String(value)
    .split(".")
    .concat(["0", "0", "0"])
    .slice(0, 3)
    .map((bit) => Number(String(bit).replace(/\D/g, "") || 0));
}

export function cmpSemver(left, right) {
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

export function resolveHubVersion(configured, fetched) {
  let version = String(configured || "").trim() || HUB_VERSION_FLOOR;
  if (cmpSemver(version, HUB_VERSION_FLOOR) < 0) version = HUB_VERSION_FLOOR;
  if (fetched && cmpSemver(fetched, version) > 0) return fetched;
  return version;
}

export async function fetchHubVersion(timeoutMs = 5000) {
  try {
    const response = await request(HUB_MANIFEST_URL, { timeoutMs });
    if (response.status >= 400) return null;
    return parseHubVersion(response.body);
  } catch {
    return null;
  }
}

export function shortUserAgent(version) {
  return `${USER_AGENT_PRODUCT}/hub/${version} ${osArch()}`;
}

export function longUserAgent(version) {
  return `${shortUserAgent(version)} ${ONBOARD_UA_SUFFIX}`;
}

export function clientMetadata() {
  return JSON.stringify({ ideType: IDE_TYPE });
}

export function requestHeaders(version, { onboard = false } = {}) {
  return {
    "User-Agent": onboard ? longUserAgent(version) : shortUserAgent(version),
    "Content-Type": "application/json",
    "X-Goog-Api-Client": X_GOOG_API_CLIENT,
    "Client-Metadata": clientMetadata(),
  };
}

export function stripApiKeyHeaders(headers) {
  const blocked = new Set(["x-goog-api-key", "x-api-key", "x-goog-api_key"]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}
