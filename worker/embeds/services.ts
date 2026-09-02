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
 * Given a set of active service_ids for "today", pick the matching
 * profile (the one whose serviceIds intersect today's most heavily).
 * Falls back to the first profile when there's no match.
 */
export function pickDefaultProfile(
  profiles: ServiceProfile[],
  activeToday: Set<string>,
): ServiceProfile | null {
  if (profiles.length === 0) return null;
  let best: ServiceProfile | null = null;
  let bestCount = -1;
  for (const p of profiles) {
    let count = 0;
    for (const id of p.serviceIds) {
      if (activeToday.has(id)) count++;
    }
    if (count > bestCount) {
      best = p;
      bestCount = count;
    }
  }
  return best ?? profiles[0];
}
