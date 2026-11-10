// The reviewed host list per platform. A platform's key may only be sent to hosts in this lock; the generator stops when a spec
// would change a list, and tests compare every generated platform.json to it. Compared field by field so key order never matters.
export function hostEntry(p) {
  return { hosts: [...(p.hosts ?? [])].sort(), hostPatterns: [...(p.hostPatterns ?? [])].sort(), hostFromEnv: !!p.hostFromEnv };
}
export function sameHosts(a, b) {
  if (!a || !b) return false;
  const eq = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  return eq(a.hosts ?? [], b.hosts ?? []) && eq(a.hostPatterns ?? [], b.hostPatterns ?? []) && !!a.hostFromEnv === !!b.hostFromEnv;
}
