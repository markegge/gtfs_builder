import type { Calendar, CalendarDate } from './types';
import type { ServiceProfile } from '../../shared/serviceProfiles';

// Profile grouping/labelling lives in shared/ because the editor frontend needs
// the same `ServiceProfile` shape to type the profiles it fetches from the JSON
// API and bakes into copied embed snippets. Re-exported here so route.ts,
// stop.ts and landing.ts keep importing from './services'.
export {
  buildServiceProfiles,
  type ServiceProfile,
  type ServiceCalendarRow,
} from '../../shared/serviceProfiles';

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
type DayKey = (typeof DAY_KEYS)[number];

/**
 * Compute "today" as a YYYYMMDD string in the agency's timezone (or UTC
 * fallback). Used for default-tab logic.
 */
export function todayInTimezone(timezone: string | undefined, now = new Date()): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(now).replace(/-/g, '');
  } catch {
    return now.toISOString().slice(0, 10).replace(/-/g, '');
  }
}

/**
 * Day-of-week index for a YYYYMMDD calendar date. 0 = Sunday … 6 = Saturday.
 *
 * No timezone argument, and none is missing: a calendar date already names a
 * specific day, so its weekday is the same everywhere. Feeding it
 * `todayInTimezone(tz)` therefore returns exactly what `dayOfWeekInTimezone(tz)`
 * would — which is what lets the date-picker path and the default path share one
 * code path in route.ts instead of branching on whether a date was requested.
 */
export function dayOfWeekForYmd(ymd: string): number {
  const day = ymdToUtcMillis(ymd);
  if (day === null) return 0;
  return new Date(day).getUTCDay();
}

/**
 * Day-of-week index in the agency's timezone. 0 = Sunday … 6 = Saturday.
 */
export function dayOfWeekInTimezone(timezone: string | undefined, now = new Date()): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      weekday: 'short',
    });
    const parts = fmt.format(now);
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[parts] ?? now.getUTCDay();
  } catch {
    return now.getUTCDay();
  }
}

/**
 * service_ids active on a specific YYYYMMDD date, applying calendar
 * weekly flags + calendar_dates exceptions.
 */
export function activeServicesOn(
  date: string,
  dayOfWeek: number,
  calendars: Calendar[],
  calendarDates: CalendarDate[],
): Set<string> {
  const active = new Set<string>();
  const dayKey: DayKey = DAY_KEYS[dayOfWeek];

  for (const cal of calendars) {
    if (!cal) continue;
    if (cal.start_date && date < cal.start_date) continue;
    if (cal.end_date && date > cal.end_date) continue;
    if (cal[dayKey] === 1) {
      active.add(cal.service_id);
    }
  }

  for (const ex of calendarDates) {
    if (ex.date !== date) continue;
    if (ex.exception_type === 1) active.add(ex.service_id);
    else if (ex.exception_type === 2) active.delete(ex.service_id);
  }

  return active;
}

/**
 * The ids of profiles whose service is over (issue #71).
 *
 * "Over" is *no remaining service*, not merely a past `end_date`: a pattern
 * whose calendar range ended can still be revived by a calendar_dates.txt
 * `exception_type=1` row — a holiday or special-event day added outside the
 * range — and a schedule that runs today is not expired however its dates read.
 * So a profile is expired only when its range has ended AND none of its
 * service_ids is added back on or after today.
 *
 * Deliberately computed from snapshot data plus a single `today` string, with
 * no other per-request state, so the rider embed and the operator JSON API can
 * both call it and always agree. If they disagreed, an agency would be told a
 * pattern is fine while riders can't see it — the exact confusion this feature
 * exists to remove.
 *
 * A blank or malformed `end_date` never expires: an unbounded service is a
 * publishing choice, and guessing at a date we can't parse would hide a live
 * schedule.
 */
export function expiredProfileIds(
  profiles: ServiceProfile[],
  calendarDates: CalendarDate[],
  today: string,
): Set<string> {
  const revived = new Set<string>();
  for (const ex of calendarDates) {
    if (ex.exception_type === 1 && ex.date >= today) revived.add(ex.service_id);
  }

  const expired = new Set<string>();
  for (const p of profiles) {
    if (!/^\d{8}$/.test(p.endDate)) continue;
    if (p.endDate >= today) continue;
    if (p.serviceIds.some((id) => revived.has(id))) continue;
    expired.add(p.id);
  }
  return expired;
}

/**
 * Given a set of active service_ids for "today", pick the matching
 * profile (the one whose serviceIds intersect today's most heavily).
 * Falls back to the first profile when there's no match.
 *
 * `expired` (from expiredProfileIds) removes ended patterns from contention.
 * Without it the fallback is profile *order*, so on a day when nothing is
 * running a feed whose first-ranked pattern happens to be a discontinued one
 * opens on a dead timetable. Ignored when every profile has expired — a
 * default still has to be something.
 */
export function pickDefaultProfile(
  profiles: ServiceProfile[],
  activeToday: Set<string>,
  expired: ReadonlySet<string> = new Set(),
): ServiceProfile | null {
  if (profiles.length === 0) return null;
  const live = profiles.filter((p) => !expired.has(p.id));
  const candidates = live.length > 0 ? live : profiles;
  let best: ServiceProfile | null = null;
  let bestCount = -1;
  for (const p of candidates) {
    let count = 0;
    for (const id of p.serviceIds) {
      if (activeToday.has(id)) count++;
    }
    if (count > bestCount) {
      best = p;
      bestCount = count;
    }
  }
  return best ?? candidates[0];
}

// ─── Date selection (?date=) ─────────────────────────────────────────────────
//
// The rider-facing date picker on a route embed. `?date=` is *navigation state*
// a rider sets on the live page, the same standing the service-day tabs had —
// deliberately NOT something the snippet panel bakes into an iframe. A date
// frozen into an agency's page would keep serving one day's schedule long after
// it stopped being true, silently; see src/components/embed/embedOptions.ts,
// which has no `date` field for exactly that reason.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Epoch millis for a YYYYMMDD calendar date at UTC midnight, or null. */
function ymdToUtcMillis(ymd: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // Round-trip check: Date.UTC happily rolls 2026-02-30 forward into March, so
  // a syntactically valid but nonexistent date has to be rejected here or the
  // page would answer a question the rider never asked.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

/** A YYYYMMDD date `days` away from `ymd`, or null when `ymd` doesn't parse. */
export function addDaysYmd(ymd: string, days: number): string | null {
  const ms = ymdToUtcMillis(ymd);
  if (ms === null) return null;
  return ymdFromUtcMillis(ms + days * MS_PER_DAY);
}

function ymdFromUtcMillis(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const mo = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}${mo}${day}`;
}

/**
 * Parse a `?date=` param into GTFS YYYYMMDD, or null when it isn't a real date.
 *
 * Accepts the `YYYY-MM-DD` an `<input type="date">` submits and the bare
 * `YYYYMMDD` of calendar.txt, because both are things a person will end up with
 * in a URL bar. Anything else — including a well-formed-looking date that
 * doesn't exist — returns null, and the caller falls back to today rather than
 * erroring, matching how an unknown `?service=` is already treated.
 */
export function parseDateParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const compact = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed.replace(/-/g, '') : trimmed;
  if (!/^\d{8}$/.test(compact)) return null;
  return ymdToUtcMillis(compact) === null ? null : compact;
}

/** Render a YYYYMMDD as the `YYYY-MM-DD` an `<input type="date">` expects. */
export function ymdToInputValue(ymd: string): string {
  return /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : '';
}

/**
 * The span of dates the feed says anything about: the widest calendar.txt range
 * plus any calendar_dates.txt exception outside it.
 *
 * Used to bound the date input (`min`/`max`) and to tell "the feed has no
 * service that day" apart from "the feed doesn't cover that day at all" — two
 * different answers a rider deserves to be given differently. Returns null when
 * the feed has no parseable dates, in which case both bounds are simply omitted.
 */
export function feedCalendarRange(
  calendars: Calendar[],
  calendarDates: CalendarDate[],
): { start: string; end: string } | null {
  let start: string | null = null;
  let end: string | null = null;
  const widen = (ymd: string | undefined) => {
    if (!ymd || !/^\d{8}$/.test(ymd) || ymdToUtcMillis(ymd) === null) return;
    if (start === null || ymd < start) start = ymd;
    if (end === null || ymd > end) end = ymd;
  };
  for (const cal of calendars) {
    if (!cal) continue;
    widen(cal.start_date);
    widen(cal.end_date);
  }
  // Only *added* days widen the range. An exception_type=2 removal names a date
  // the feed already covers, so it can never extend what the feed knows about.
  for (const ex of calendarDates) {
    if (ex.exception_type === 1) widen(ex.date);
  }
  return start !== null && end !== null ? { start, end } : null;
}

/**
 * The next date on or after `from` whose active services intersect `wanted` —
 * i.e. the next day this route actually runs. Null when there is none within
 * `limitDays`.
 *
 * Route-scoped on purpose: a feed can be running a Saturday network on a day
 * when this particular route sits idle, and "next service" pointing at a day the
 * rider still finds nothing would be worse than saying nothing at all.
 */
export function nextServiceDate(
  from: string,
  wanted: ReadonlySet<string>,
  calendars: Calendar[],
  calendarDates: CalendarDate[],
  limitDays = 366,
): string | null {
  if (wanted.size === 0) return null;
  let cursor: string | null = from;
  for (let i = 0; i <= limitDays && cursor !== null; i++) {
    const active = activeServicesOn(cursor, dayOfWeekForYmd(cursor), calendars, calendarDates);
    for (const id of active) {
      if (wanted.has(id)) return cursor;
    }
    cursor = addDaysYmd(cursor, 1);
  }
  return null;
}
