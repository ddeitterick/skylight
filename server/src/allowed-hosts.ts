// Host / Origin allowlist used by both the REST middleware (DNS-rebinding gate)
// and the WebSocket verifyClient (cross-site WS hijack gate).
//
// Defaults are tuned for Skylight's documented topology:
//   - localhost / 127.0.0.1 / [::1]  (developer machine)
//   - RFC1918 LAN IPs                (phone control panel on home Wi-Fi)
//   - IPv6 unique-local + link-local (LAN over IPv6)
//   - *.local                        (mDNS, e.g. skylight.local)
//
// Operators that expose Skylight on a public hostname can add it via the
// ALLOWED_HOSTS env var (comma-separated). Hostnames are matched
// case-insensitively; a leading "*." marks a single-level wildcard.

export interface HostMatcher {
  test(host: string | undefined): boolean;
  describe(): string;
}

const IPV4_SHAPE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const LOOPBACK_V6 = /^::1$/;
const ULA_V6 = /^f[cd][0-9a-f]{2}:/i;          // fc00::/7
const LINK_LOCAL_V6 = /^fe80:/i;
const MDNS = /\.local$/i;

function parseIPv4(host: string): [number, number, number, number] | null {
  const m = IPV4_SHAPE.exec(host);
  if (!m) return null;
  const parts: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    parts.push(n);
  }
  return parts as [number, number, number, number];
}

function isPrivateOrLoopbackV4(host: string): boolean {
  const ip = parseIPv4(host);
  if (!ip) return false;
  const [a, b] = ip;
  if (a === 127) return true;                       // loopback /8
  if (a === 10) return true;                        // RFC1918 /8
  if (a === 192 && b === 168) return true;          // RFC1918 /16
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 /12
  if (a === 169 && b === 254) return true;          // link-local /16
  return false;
}

function isLoopbackV4(host: string): boolean {
  const ip = parseIPv4(host);
  return ip !== null && ip[0] === 127;
}

function stripPort(rawHost: string): string {
  if (rawHost.startsWith("[")) {
    const end = rawHost.indexOf("]");
    return end > 0 ? rawHost.slice(1, end) : rawHost;
  }
  const colon = rawHost.lastIndexOf(":");
  return colon > -1 && !rawHost.includes(":", colon + 1)
    ? rawHost.slice(0, colon)
    : rawHost;
}

function hostnameFromOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (u.hostname.startsWith("[") && u.hostname.endsWith("]")) {
      return u.hostname.slice(1, -1).toLowerCase();
    }
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function matchExtra(host: string, extras: string[]): boolean {
  for (const e of extras) {
    if (e === host) return true;
    if (e.startsWith("*.") && host.endsWith(e.slice(1)) && host !== e.slice(2)) {
      return true;
    }
  }
  return false;
}

export function buildHostMatcher(env: NodeJS.ProcessEnv = process.env): HostMatcher {
  const extras = (env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const allowPrivateLan = (env.ALLOW_PRIVATE_LAN ?? "1") !== "0";

  function testHostname(host: string): boolean {
    const h = host.toLowerCase();
    if (h === "localhost") return true;
    if (isLoopbackV4(h)) return true;
    if (LOOPBACK_V6.test(h)) return true;
    if (MDNS.test(h)) return true;
    if (allowPrivateLan) {
      if (isPrivateOrLoopbackV4(h)) return true;
      if (ULA_V6.test(h)) return true;
      if (LINK_LOCAL_V6.test(h)) return true;
    }
    return matchExtra(h, extras);
  }

  return {
    test(rawHost: string | undefined): boolean {
      if (!rawHost) return false;
      const host = stripPort(rawHost).toLowerCase();
      if (!host) return false;
      return testHostname(host);
    },
    describe(): string {
      const parts = [
        "localhost / 127.0.0.0/8 / [::1]",
        "*.local (mDNS)",
      ];
      if (allowPrivateLan) {
        parts.push("RFC1918 (10/8, 172.16/12, 192.168/16, 169.254/16)");
        parts.push("IPv6 ULA (fc00::/7) + link-local (fe80::/10)");
      }
      if (extras.length) parts.push(`extras: ${extras.join(", ")}`);
      return parts.join(" | ");
    },
  };
}

export function originHostname(origin: string | undefined): string | null {
  if (!origin) return null;
  return hostnameFromOrigin(origin);
}

export { stripPort };
