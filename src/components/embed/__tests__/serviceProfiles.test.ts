// Unit tests for the shared service-profile helpers (shared/serviceProfiles.ts).
//
// This module is imported by BOTH the Worker (worker/embeds/services.ts, which
// renders the service-day tabs and honors ?service=) and the frontend (the
// embed snippet panel, which types the profiles it fetches from the JSON API).
// The profile **id** is the contract between them: the panel bakes it into a
// copied snippet and the embed page resolves it months later. If the key format
// or the hash drifts by one character, every emitted id silently misses and the
// embed falls back to today's service — no error, nothing else catches it.
//
// So these tests pin the id format with hard-coded golden values, not with a
// re-derivation from the implementation.

import { describe, expect, it } from 'vitest';
import {
  buildServiceProfiles,
  labelForFlags,
  formatYmdShort,
  hashKey,
  type ServiceCalendarRow,
} from '../../../../shared/serviceProfiles';

/** calendar.txt row builder — days given as a 7-char sun..sat flag string. */
function cal(service_id: string, flags: string, start_date = '20260101', end_date = '20261231'): ServiceCalendarRow {
  const f = flags.split('').map((c) => (c === '1' ? 1 : 0));
  return {
    service_id,
    sunday: f[0], monday: f[1], tuesday: f[2], wednesday: f[3],
    thursday: f[4], friday: f[5], saturday: f[6],
    start_date,
    end_date,
  };
}

const WEEKDAY = '0111110';
const SATURDAY = '0000001';
const SUNDAY = '1000000';
const DAILY = '1111111';

describe('buildServiceProfiles', () => {
  it('groups a weekday + saturday feed into two labelled profiles', () => {
    const profiles = buildServiceProfiles([cal('WKDY', WEEKDAY), cal('SAT', SATURDAY)]);
    expect(profiles.map((p) => p.label)).toEqual(['Weekday', 'Saturday']);
    expect(profiles.map((p) => p.serviceIds)).toEqual([['WKDY'], ['SAT']]);
  });

  it('collapses several service_ids that share day flags AND date range into one profile', () => {
    const profiles = buildServiceProfiles([
      cal('WKDY_A', WEEKDAY),
      cal('WKDY_B', WEEKDAY),
      cal('SAT', SATURDAY),
    ]);
    expect(profiles).toHaveLength(2);
    expect(profiles[0].label).toBe('Weekday');
    expect(profiles[0].serviceIds).toEqual(['WKDY_A', 'WKDY_B']);
  });

  it('splits the same day pattern across different date ranges and suffixes the labels', () => {
    const profiles = buildServiceProfiles([
      cal('WINTER', WEEKDAY, '20260101', '20260630'),
      cal('SUMMER', WEEKDAY, '20260701', '20261231'),
    ]);
    expect(profiles).toHaveLength(2);
    expect(profiles.map((p) => p.label)).toEqual([
      'Weekday (Jan 1–Jun 30)',
      'Weekday (Jul 1–Dec 31)',
    ]);
    // Distinct ids — this is what makes a seasonal pin addressable at all.
    expect(profiles[0].id).not.toBe(profiles[1].id);
  });

  it('leaves the label unsuffixed when a day pattern appears only once', () => {
    const profiles = buildServiceProfiles([
      cal('WKDY', WEEKDAY, '20260101', '20260630'),
      cal('SAT', SATURDAY, '20260701', '20261231'),
    ]);
    expect(profiles.map((p) => p.label)).toEqual(['Weekday', 'Saturday']);
  });

  it('orders profiles Weekday → Saturday → Sunday → Daily → other', () => {
    const profiles = buildServiceProfiles([
      cal('OTHER', '0101010'),
      cal('DAILY', DAILY),
      cal('SUN', SUNDAY),
      cal('SAT', SATURDAY),
      cal('WKDY', WEEKDAY),
    ]);
    expect(profiles.map((p) => p.label)).toEqual([
      'Weekday',
      'Saturday',
      'Sunday',
      'Daily',
      'Mon Wed Fri',
    ]);
  });

  it('returns [] for a feed with no calendar.txt rows', () => {
    expect(buildServiceProfiles([])).toEqual([]);
  });

  // ─── The id contract ──────────────────────────────────────────────────────

  it('produces the exact documented id for a known calendar (golden values)', () => {
    // Hard-coded on purpose. These ids are baked into snippets agencies paste
    // onto live sites; a change here is a silent breaking change for them.
    const profiles = buildServiceProfiles([
      cal('WKDY', WEEKDAY),
      cal('SAT', SATURDAY),
      cal('EVERY', DAILY),
    ]);
    const byLabel = Object.fromEntries(profiles.map((p) => [p.label, p.id]));
    expect(byLabel.Weekday).toBe('svc-1rbulw');
    expect(byLabel.Saturday).toBe('svc-1rnwq6');
    expect(byLabel.Daily).toBe('svc-kyafpq');
  });

  it('derives the id from `<flags>|<start_date>|<end_date>` hashed with hashKey', () => {
    // Re-derives the id from an independent statement of the key format, so a
    // drift in either the key layout or the hash fails here.
    const profiles = buildServiceProfiles([cal('WKDY', WEEKDAY, '20260401', '20260930')]);
    expect(profiles[0].id).toBe(`svc-${hashKey('0111110|20260401|20260930')}`);
  });

  it('keeps ids stable regardless of the order calendars arrive in', () => {
    const a = buildServiceProfiles([cal('WKDY', WEEKDAY), cal('SAT', SATURDAY)]);
    const b = buildServiceProfiles([cal('SAT', SATURDAY), cal('WKDY', WEEKDAY)]);
    expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));
  });

  it('changes the id when only the date range changes', () => {
    const [winter] = buildServiceProfiles([cal('S', WEEKDAY, '20260101', '20260630')]);
    const [summer] = buildServiceProfiles([cal('S', WEEKDAY, '20260701', '20261231')]);
    expect(winter.id).not.toBe(summer.id);
  });

  it('ignores service_id when computing the id (only flags + range matter)', () => {
    const [a] = buildServiceProfiles([cal('ALPHA', WEEKDAY)]);
    const [b] = buildServiceProfiles([cal('OMEGA', WEEKDAY)]);
    expect(a.id).toBe(b.id);
  });

  it('emits URL-safe ids', () => {
    const profiles = buildServiceProfiles([cal('WKDY', WEEKDAY), cal('SAT', SATURDAY), cal('D', DAILY)]);
    for (const p of profiles) {
      expect(p.id).toMatch(/^svc-[0-9a-z]+$/);
      expect(encodeURIComponent(p.id)).toBe(p.id);
    }
  });
});

describe('labelForFlags', () => {
  it('names the four canonical patterns', () => {
    expect(labelForFlags([0, 1, 1, 1, 1, 1, 0])).toBe('Weekday');
    expect(labelForFlags([0, 0, 0, 0, 0, 0, 1])).toBe('Saturday');
    expect(labelForFlags([1, 0, 0, 0, 0, 0, 0])).toBe('Sunday');
    expect(labelForFlags([1, 1, 1, 1, 1, 1, 1])).toBe('Daily');
  });

  it('composes day abbreviations for anything else', () => {
    expect(labelForFlags([0, 1, 0, 1, 0, 1, 0])).toBe('Mon Wed Fri');
    expect(labelForFlags([1, 0, 0, 0, 0, 0, 1])).toBe('Sun Sat');
    expect(labelForFlags([0, 1, 1, 1, 1, 1, 1])).toBe('Mon Tue Wed Thu Fri Sat');
  });

  it('labels an all-zero calendar "No service"', () => {
    expect(labelForFlags([0, 0, 0, 0, 0, 0, 0])).toBe('No service');
  });
});

describe('formatYmdShort', () => {
  it('renders YYYYMMDD as a short month + day', () => {
    expect(formatYmdShort('20260101')).toBe('Jan 1');
    expect(formatYmdShort('20260630')).toBe('Jun 30');
    expect(formatYmdShort('20261231')).toBe('Dec 31');
  });

  it('passes through anything that is not YYYYMMDD', () => {
    expect(formatYmdShort('')).toBe('');
    expect(formatYmdShort('not-a-date')).toBe('not-a-date');
  });
});

describe('hashKey', () => {
  it('is deterministic and collision-free across the day patterns of a normal feed', () => {
    const keys = [WEEKDAY, SATURDAY, SUNDAY, DAILY, '0111111', '1111110'].map(
      (f) => `${f}|20260101|20261231`,
    );
    const hashes = keys.map(hashKey);
    expect(new Set(hashes).size).toBe(keys.length);
    expect(keys.map(hashKey)).toEqual(hashes);
  });
});
