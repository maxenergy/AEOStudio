import { isIP } from 'node:net';

function ipv4Octets(address: string): number[] | null {
  const match = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(address);
  if (match === null) {
    return null;
  }
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isPublicIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (octets === null) {
    return false;
  }
  const [first = 0, second = 0, third = 0] = octets;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function expandIpv6(address: string): number[] | null {
  let normalized = address.toLowerCase().split('%', 1)[0] ?? '';
  const embeddedIpv4 = ipv4Octets(normalized.slice(normalized.lastIndexOf(':') + 1));
  if (embeddedIpv4 !== null) {
    normalized = `${normalized.slice(0, normalized.lastIndexOf(':'))}:${(
      (embeddedIpv4[0] ?? 0) * 256 +
      (embeddedIpv4[1] ?? 0)
    ).toString(16)}:${((embeddedIpv4[2] ?? 0) * 256 + (embeddedIpv4[3] ?? 0)).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) {
    return null;
  }
  const left = (halves[0] ?? '').split(':').filter(Boolean);
  const right = (halves[1] ?? '').split(':').filter(Boolean);
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) {
    return null;
  }
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right].map((part) =>
    Number.parseInt(part, 16),
  );
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group <= 0xffff)
    ? groups
    : null;
}

function isSpecialPurposeIpv6(groups: number[]): boolean {
  const [first = 0, second = 0, third = 0] = groups;
  return (
    // IETF protocol assignments, including benchmarking, ORCHID, AMT and protocol anycast.
    (first === 0x2001 && second <= 0x01ff) ||
    // Documentation prefix.
    (first === 0x2001 && second === 0x0db8) ||
    // Deprecated 6to4 transition space.
    first === 0x2002 ||
    // Direct Delegation AS112 service anycast.
    (first === 0x2620 && second === 0x004f && third === 0x8000) ||
    // Documentation prefix 3fff::/20.
    (first === 0x3fff && (second & 0xf000) === 0)
  );
}

function isPublicIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (groups === null) {
    return false;
  }
  const [first = 0] = groups;
  const mappedIpv4 = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mappedIpv4) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return isPublicIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  return (first & 0xe000) === 0x2000 && !isSpecialPurposeIpv6(groups);
}

export function isPublicNetworkAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%', 1)[0] ?? '';
  const mapped = ipv4Octets(normalized);
  if (mapped !== null) {
    return isPublicIpv4(normalized);
  }
  const version = isIP(normalized);
  return version === 4 ? isPublicIpv4(normalized) : version === 6 && isPublicIpv6(normalized);
}
