// Unit tests for the service-pattern expiry rule (issue #71), the thing that
// decides whether a rider is offered a schedule at all.
//
// The integration tests in embeds.test.ts prove the rendered page hides,
// reveals and warns. These pin the two edges of the rule itself, which a
// rendered page can't reach without a contrived feed: a calendar_dates.txt row
// that revives a pattern after its range ends, and a blank end_date.

import { describe, expect, it } from 'vitest';
import { expiredProfileIds, pickDefaultProfile } from '../embeds/services';
import { buildServiceProfiles } from '../../shared/serviceProfiles';
import type { CalendarDate } from '../embeds/types';

const TODAY = '20260902';

/** calendar.txt row builder — days as a 7-char sun..sat flag string. */
function cal(service_id: string, flags: string, start_date: string, end_date: string) {
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

describe('expiredProfileIds', () => {
  it('expires a pattern whose range ended before today', () => {
    const profiles = buildServiceProfiles([cal('OLD', WEEKDAY, '20260501', '20260607')]);
    expect(expiredProfileIds(profiles, [], TODAY)).toEqual(new Set([profiles[0].id]));
  });

  it('does not expire a pattern that ends today', () => {
    // A schedule in force for the rest of today is not a past schedule, and a
    // rider looking up this evening's departure needs it.
    const profiles = buildServiceProfiles([cal('LAST', WEEKDAY, '20260501', TODAY)]);
    expect(expiredProfileIds(profiles, [], TODAY).size).toBe(0);
  });

  it('does not expire a pattern a calendar_dates row revives on or after today', () => {
    // Legal GTFS: exception_type=1 adds service outside the calendar range, for
    // a holiday or a special event. Hiding it would take a schedule that runs
    // *today* off the page.
    const profiles = buildServiceProfiles([cal('SEASON', SATURDAY, '20260501', '20260607')]);
    const dates: CalendarDate[] = [{ service_id: 'SEASON', date: '20260920', exception_type: 1 }];
    expect(expiredProfileIds(profiles, dates, TODAY).size).toBe(0);
  });

  it('still expires it when the only exceptions are in the past, or are removals', () => {
    const profiles = buildServiceProfiles([cal('SEASON', SATURDAY, '20260501', '20260607')]);
    const dates: CalendarDate[] = [
      { service_id: 'SEASON', date: '20260530', exception_type: 1 },
      { service_id: 'SEASON', date: '20261225', exception_type: 2 },
    ];
    expect(expiredProfileIds(profiles, dates, TODAY)).toEqual(new Set([profiles[0].id]));
  });

  it('never expires a pattern with a blank or malformed end_date', () => {
    // An unbounded service is a publishing choice. Guessing at a date we can't
    // parse would hide a live schedule on the strength of a typo.
    const profiles = buildServiceProfiles([
      cal('OPEN', WEEKDAY, '20260101', ''),
      cal('JUNK', SATURDAY, '20260101', '2026-06-07'),
    ]);
    expect(expiredProfileIds(profiles, [], TODAY).size).toBe(0);
  });
});

describe('pickDefaultProfile', () => {
  const live = buildServiceProfiles([cal('LIVE', SATURDAY, '20260101', '20271231')])[0];
  const dead = buildServiceProfiles([cal('DEAD', WEEKDAY, '20260101', '20260607')])[0];

  it('skips an expired pattern when nothing is running today', () => {
    // Nothing intersects today, so the pick falls through to profile order —
    // and "Weekday" outranks "Saturday". Without the expiry set the rider opens
    // on a schedule that stopped months ago.
    const profiles = [dead, live];
    expect(pickDefaultProfile(profiles, new Set())?.id).toBe(dead.id);
    expect(pickDefaultProfile(profiles, new Set(), new Set([dead.id]))?.id).toBe(live.id);
  });

  it('still returns something when every pattern has expired', () => {
    const profiles = [dead];
    expect(pickDefaultProfile(profiles, new Set(), new Set([dead.id]))?.id).toBe(dead.id);
  });

  it('keeps preferring the pattern that actually runs today', () => {
    const profiles = [dead, live];
    expect(pickDefaultProfile(profiles, new Set(['LIVE']), new Set([dead.id]))?.id).toBe(live.id);
  });

  it('returns null for a feed with no profiles', () => {
    expect(pickDefaultProfile([], new Set())).toBeNull();
  });
});
