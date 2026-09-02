// ─── Service profiles — shared between the Worker and the editor frontend ────
//
// A "service profile" is a group of calendar.txt rows that share a day pattern
// AND a date range: the thing a rider sees as a "Weekday" / "Saturday" /
// "Weekday (Jun 1–Aug 31)" tab on an embed.
//
// The profile **id** is a public contract, not an implementation detail:
//   * the embed page resolves `?service=<id>` against it (worker/embeds/route.ts)
//   * the JSON API publishes it (worker/embeds/api.ts → /<slug>/api/v1/services)
//   * `<gtfs-schedule service="…">` passes it through (worker/embeds/widgets.ts)
//   * the snippet panel bakes it into iframes agencies paste onto live sites
//
// Those snippets outlive this process by months. If a second implementation of
// the id existed and its key format drifted by one character, every emitted id
// would stop matching and the embed would quietly fall back to today's service
// — no error, no failed request, nothing a typecheck or a lint would catch. So
// this lives in exactly one place and both sides import it.
//
// This module is deliberately dependency-free and DOM-free: it is compiled into
// the app project (tsconfig.app.json, lib DOM) and the worker project
// (tsconfig.worker.json, lib ES2022 + workers-types) alike.

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/**
 * The calendar.txt fields these helpers read. Structural on purpose and looser
 * than either side's own model (`worker/embeds/types.ts:Calendar`,
 * `src/types/gtfs.ts:Calendar`) so both are assignable without either project
 * importing the other's types.
 */
export interface ServiceCalendarRow {
  service_id: string;
  monday: number;
  tuesday: number;
  wednesday: number;
  thursday: number;
  friday: number;
  saturday: number;
  sunday: number;
  start_date: string;
  end_date: string;
}

export interface ServiceProfile {
  // Stable id derived from the day flags + date range, used as the value for
  // the radio/tab selector in the rendered HTML and for `?service=`.
  id: string;
  // Human label: "Weekday", "Saturday", "Sunday", "Daily", or
  // "Weekday + Saturday", etc.
  label: string;
  // The actual GTFS service_ids that share this day pattern.
  serviceIds: string[];
}

/**
 * Group calendar entries into named profiles ("Weekday" / "Saturday" / …).
 * Profiles split on **both** day pattern AND date range — so a feed with
 * a summer Weekday service and a winter Weekday service produces two
 * separate tabs. When a day pattern shows up in more than one profile
 * the label gets a date-range suffix so the rider can tell them apart.
 */
export function buildServiceProfiles(calendars: ServiceCalendarRow[]): ServiceProfile[] {
  const groups = new Map<string, {
    flags: number[];
    serviceIds: string[];
    startDate: string;
    endDate: string;
  }>();
  for (const cal of calendars) {
    const flags: number[] = DAY_KEYS.map((k) => cal[k]);
    const key = `${flags.join('')}|${cal.start_date}|${cal.end_date}`;
    let group = groups.get(key);
    if (!group) {
      group = { flags, serviceIds: [], startDate: cal.start_date, endDate: cal.end_date };
      groups.set(key, group);
    }
    group.serviceIds.push(cal.service_id);
  }

  const baseProfiles = Array.from(groups.entries()).map(([key, g]) => ({
    id: `svc-${hashKey(key)}`,
    flags: g.flags,
    serviceIds: g.serviceIds,
    startDate: g.startDate,
    endDate: g.endDate,
    baseLabel: labelForFlags(g.flags),
  }));

  // Count base-labels — only suffix dates onto labels that collide.
  const labelCounts = new Map<string, number>();
  for (const p of baseProfiles) {
    labelCounts.set(p.baseLabel, (labelCounts.get(p.baseLabel) ?? 0) + 1);
  }

  const profiles: ServiceProfile[] = baseProfiles.map((p) => ({
    id: p.id,
    label:
      (labelCounts.get(p.baseLabel) ?? 0) > 1
        ? `${p.baseLabel} (${formatYmdShort(p.startDate)}–${formatYmdShort(p.endDate)})`
        : p.baseLabel,
    serviceIds: p.serviceIds,
  }));

  // Order: Weekday → Saturday → Sunday → Daily → other (alphabetical).
  const order = (label: string) => {
    if (label.startsWith('Weekday')) return 0;
    if (label.startsWith('Saturday')) return 1;
    if (label.startsWith('Sunday')) return 2;
    if (label.startsWith('Daily')) return 3;
    return 4;
  };
  profiles.sort((a, b) => {
    const da = order(a.label);
    const db = order(b.label);
    if (da !== db) return da - db;
    return a.label.localeCompare(b.label);
  });
  return profiles;
}

export function formatYmdShort(ymd: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const [, , mo, d] = m;
  const date = new Date(Date.UTC(2000, parseInt(mo, 10) - 1, parseInt(d, 10)));
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(date);
}

export function hashKey(s: string): string {
  // Tiny stable hash so the URL-friendly id stays short. Collisions
  // unlikely at the size of any realistic feed.
  //
  // ⚠️ Changing this — or the `<flags>|<start_date>|<end_date>` key fed to it —
  // invalidates every `?service=` id already pasted into a customer's website.
  // Treat it as a wire format.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

export function labelForFlags(flags: number[]): string {
  // flags are [sun, mon, tue, wed, thu, fri, sat]
  const [sun, mon, tue, wed, thu, fri, sat] = flags;
  const weekdays = mon === 1 && tue === 1 && wed === 1 && thu === 1 && fri === 1;
  if (weekdays && sat === 1 && sun === 1) return 'Daily';
  if (weekdays && sat === 0 && sun === 0) return 'Weekday';
  if (sat === 1 && sun === 0 && mon === 0 && tue === 0 && wed === 0 && thu === 0 && fri === 0) {
    return 'Saturday';
  }
  if (sun === 1 && sat === 0 && mon === 0 && tue === 0 && wed === 0 && thu === 0 && fri === 0) {
    return 'Sunday';
  }
  // Compose a custom label from active day abbreviations.
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const active = names.filter((_, i) => flags[i] === 1);
  return active.length ? active.join(' ') : 'No service';
}
