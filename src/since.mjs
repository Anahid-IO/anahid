/** Read `--since` as a date or "Nd" (N days before `now`). Returns an ISO string or null. */
export function parseSince(s, now = Date.now()) {
  const days = /^(\d+)d$/.exec(s);
  if (days) return new Date(now - Number(days[1]) * 86_400_000).toISOString();
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
