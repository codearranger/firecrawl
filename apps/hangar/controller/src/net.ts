/** IPv4 subnet membership (IPv4-mapped IPv6 addresses included). */
function ipToInt(ip: string): number | null {
  const m = ip.replace(/^::ffff:/, "").match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0;
}

export function inSubnet(ip: string | undefined, cidr: string): boolean {
  if (!ip || !cidr) return false;
  const [base, bitsStr] = cidr.split("/");
  const a = ipToInt(ip);
  const b = ipToInt(base);
  if (a === null || b === null) return false;
  const bits = Number(bitsStr ?? 32);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}
