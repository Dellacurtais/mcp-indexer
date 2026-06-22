/**
 * SSRF host classification — shared, zero-dependency so both the code-agent
 * web tools and the API-client send proxy use ONE battle-tested guard.
 *
 * `isPrivateHost` returns true for hostnames that resolve to private/loopback/
 * link-local/special ranges (v4 + v6), IPv4-mapped IPv6, and obfuscated numeric/
 * hex IP literals (e.g. `2130706433`, `0x7f000001`) that bypass a naive
 * dotted-quad regex. It is hostname-level only — it does NOT defeat DNS-rebinding
 * (a public name resolving to a private IP); that needs resolve-and-pin.
 */
import { isIP } from 'node:net';

/** A literal IPv4 octet quad in a private/loopback/special range. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return (
    a === 127 || // loopback 127/8
    a === 10 || // private 10/8
    a === 0 || // "this host" 0/8 (0.0.0.0 etc.)
    (a === 172 && b >= 16 && b <= 31) || // private 172.16/12
    (a === 192 && b === 168) || // private 192.168/16
    (a === 169 && b === 254) // link-local 169.254/16 (cloud metadata)
  );
}

/** Should an outbound request to `hostname` be refused as private/internal? */
export function isPrivateHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (!host) return true;
  // Strip IPv6 zone id and surrounding brackets from `[::1]` style hosts.
  host = host.replace(/^\[/, '').replace(/\]$/, '').replace(/%.*$/, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const kind = isIP(host);
  if (kind === 4) return isPrivateIpv4(host);
  if (kind === 6) {
    if (host === '::1' || host === '::') return true;
    // IPv4-mapped / -compatible (`::ffff:127.0.0.1`): check the embedded v4.
    const v4 = host.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (v4 && isPrivateIpv4(v4[1])) return true;
    // Unique-local fc00::/7 (fc.. / fd..) and link-local fe80::/10.
    if (/^f[cd]/.test(host)) return true;
    if (/^fe[89ab]/.test(host)) return true;
    return false;
  }

  // Not a recognized DNS name or dotted-quad: a bare integer or hex literal
  // (`2130706433`, `0x7f000001`) is an obfuscated IP — refuse it outright. Also
  // refuse dotted forms with hex/octal octets that `isIP` rejects.
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) return true;
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){1,3}$/i.test(host)) return true;

  return false;
}
