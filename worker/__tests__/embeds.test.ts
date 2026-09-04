// Smoke tests for the embeddable maps + schedules at
// feeds.*/<slug>/embed/route/<route_id> and /<slug>/embed/system-map.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  env as testEnv,
  gzip,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

async function loggedInClient(email: string): Promise<TestClient> {
  const user = await seedUser({ email });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return client;
}

interface SnapshotState {
  feedInfo: { feed_publisher_name: string; feed_start_date?: string; feed_end_date?: string };
  agencies: { agency_id: string; agency_name: string; agency_url: string; agency_timezone: string }[];
  routes: {
    route_id: string;
    agency_id: string;
    route_short_name: string;
    route_long_name: string;
    route_type: number;
    route_color: string;
    route_text_color: string;
  }[];
  stops: { stop_id: string; stop_name: string; stop_lat: number; stop_lon: number; location_type?: number }[];
  shapes: { shape_id: string; points: { shape_pt_lat: number; shape_pt_lon: number; shape_pt_sequence: number }[] }[];
  calendars: {
    service_id: string;
    monday: 0 | 1; tuesday: 0 | 1; wednesday: 0 | 1; thursday: 0 | 1; friday: 0 | 1;
    saturday: 0 | 1; sunday: 0 | 1;
    start_date: string; end_date: string;
  }[];
  calendarDates: { service_id: string; date: string; exception_type: 1 | 2 }[];
  trips: { trip_id: string; route_id: string; service_id: string; direction_id: 0 | 1; shape_id?: string; trip_headsign?: string }[];
  stopTimes: { trip_id: string; arrival_time: string; departure_time: string; stop_id: string; stop_sequence: number }[];
}

function makeFeedState(): SnapshotState {
  return {
    feedInfo: { feed_publisher_name: 'EmbedAgency', feed_start_date: '20260101', feed_end_date: '20261231' },
    agencies: [{ agency_id: 'a1', agency_name: 'Embed Agency', agency_url: 'https://x.test', agency_timezone: 'America/Denver' }],
    routes: [
      { route_id: 'R1', agency_id: 'a1', route_short_name: '1', route_long_name: 'Downtown', route_type: 3, route_color: '8e44ad', route_text_color: 'ffffff' },
    ],
    stops: [
      { stop_id: 's1', stop_name: 'Main & 1st', stop_lat: 45.6, stop_lon: -111.0 },
      { stop_id: 's2', stop_name: 'Main & 2nd', stop_lat: 45.61, stop_lon: -111.01 },
      { stop_id: 's3', stop_name: 'Main & 3rd', stop_lat: 45.62, stop_lon: -111.02 },
    ],
    shapes: [
      { shape_id: 'sh1', points: [
        { shape_pt_lat: 45.6, shape_pt_lon: -111.0, shape_pt_sequence: 1 },
        { shape_pt_lat: 45.62, shape_pt_lon: -111.02, shape_pt_sequence: 2 },
      ] },
    ],
    // Daily (so today's default service always has trips, regardless of
    // weekday) + a separate Saturday-only calendar so the per-route page
    // still demonstrates the multi-tab service selector.
    calendars: [
      { service_id: 'DAILY', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1, start_date: '20260101', end_date: '20261231' },
      { service_id: 'SAT', monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 1, sunday: 0, start_date: '20260101', end_date: '20261231' },
    ],
    calendarDates: [],
    trips: [
      { trip_id: 't1', route_id: 'R1', service_id: 'DAILY', direction_id: 0, shape_id: 'sh1', trip_headsign: 'Downtown' },
      { trip_id: 't2', route_id: 'R1', service_id: 'DAILY', direction_id: 0, shape_id: 'sh1', trip_headsign: 'Downtown' },
      { trip_id: 't3', route_id: 'R1', service_id: 'SAT', direction_id: 0, shape_id: 'sh1', trip_headsign: 'Downtown' },
    ],
    stopTimes: [
      { trip_id: 't1', arrival_time: '08:00:00', departure_time: '08:00:00', stop_id: 's1', stop_sequence: 1 },
      { trip_id: 't1', arrival_time: '08:05:00', departure_time: '08:05:00', stop_id: 's2', stop_sequence: 2 },
      { trip_id: 't1', arrival_time: '08:10:00', departure_time: '08:10:00', stop_id: 's3', stop_sequence: 3 },
      { trip_id: 't2', arrival_time: '08:30:00', departure_time: '08:30:00', stop_id: 's1', stop_sequence: 1 },
      { trip_id: 't2', arrival_time: '08:35:00', departure_time: '08:35:00', stop_id: 's2', stop_sequence: 2 },
      { trip_id: 't2', arrival_time: '08:40:00', departure_time: '08:40:00', stop_id: 's3', stop_sequence: 3 },
      // SAT trip, mirrors t1's times so schedule assertions pass when today
      // happens to be Saturday and the default profile picker lands on SAT.
      { trip_id: 't3', arrival_time: '08:00:00', departure_time: '08:00:00', stop_id: 's1', stop_sequence: 1 },
      { trip_id: 't3', arrival_time: '08:05:00', departure_time: '08:05:00', stop_id: 's2', stop_sequence: 2 },
      { trip_id: 't3', arrival_time: '08:10:00', departure_time: '08:10:00', stop_id: 's3', stop_sequence: 3 },
    ],
  };
}

/**
 * Weekday + Saturday variant of the fixture — no all-week calendar, so exactly
 * one of the two profiles is "today's" and the other can only be reached by an
 * explicit `?service=` pin. That asymmetry is what the service-selection tests
 * need; the default fixture's DAILY calendar overlaps SAT and can't prove it.
 *
 * The two profiles carry deliberately disjoint departure times so a rendered
 * page names which one was selected.
 */
function makeWeekdaySaturdayState(): SnapshotState {
  const base = makeFeedState();
  return {
    ...base,
    calendars: [
      { service_id: 'WKDY', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231' },
      { service_id: 'SAT', monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 1, sunday: 0, start_date: '20260101', end_date: '20261231' },
    ],
    trips: [
      { trip_id: 'w1', route_id: 'R1', service_id: 'WKDY', direction_id: 0, shape_id: 'sh1', trip_headsign: 'Downtown' },
      { trip_id: 'x1', route_id: 'R1', service_id: 'SAT', direction_id: 0, shape_id: 'sh1', trip_headsign: 'Downtown' },
    ],
    stopTimes: [
      { trip_id: 'w1', arrival_time: '06:11:00', departure_time: '06:11:00', stop_id: 's1', stop_sequence: 1 },
      { trip_id: 'w1', arrival_time: '06:22:00', departure_time: '06:22:00', stop_id: 's2', stop_sequence: 2 },
      { trip_id: 'x1', arrival_time: '13:47:00', departure_time: '13:47:00', stop_id: 's1', stop_sequence: 1 },
      { trip_id: 'x1', arrival_time: '13:58:00', departure_time: '13:58:00', stop_id: 's2', stop_sequence: 2 },
    ],
  };
}

/** Departure times unique to each profile, as the schedule table renders them. */
const WEEKDAY_ONLY_TIME = '6:11a';
const SATURDAY_ONLY_TIME = '1:47p';

/**
 * Day-pattern variant: a Sat+Sun service, a Mon-through-Sat run, and a
 * Friday-only service — the three label shapes that decide what a rider reads
 * on the tab and what the snippet panel shows in its dropdown.
 */
function makeDayPatternState(): SnapshotState {
  const base = makeFeedState();
  return {
    ...base,
    calendars: [
      { service_id: 'WKND', monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 1, sunday: 1, start_date: '20260101', end_date: '20261231' },
      { service_id: 'MONSAT', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 0, start_date: '20260101', end_date: '20261231' },
      { service_id: 'FRIONLY', monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 1, saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231' },
    ],
    trips: [
      { trip_id: 'p1', route_id: 'R1', service_id: 'WKND', direction_id: 0, shape_id: 'sh1', trip_headsign: 'Downtown' },
      { trip_id: 'p2', route_id: 'R1', service_id: 'MONSAT', direction_id: 0, shape_id: 'sh1', trip_headsign: 'Downtown' },
      { trip_id: 'p3', route_id: 'R1', service_id: 'FRIONLY', direction_id: 0, shape_id: 'sh1', trip_headsign: 'Downtown' },
    ],
    stopTimes: [
      { trip_id: 'p1', arrival_time: '09:00:00', departure_time: '09:00:00', stop_id: 's1', stop_sequence: 1 },
      { trip_id: 'p2', arrival_time: '09:00:00', departure_time: '09:00:00', stop_id: 's1', stop_sequence: 1 },
      { trip_id: 'p3', arrival_time: '09:00:00', departure_time: '09:00:00', stop_id: 's1', stop_sequence: 1 },
    ],
  };
}

/**
 * A YYYYMMDD date `days` from now, read in the fixture agency's timezone
 * (America/Denver) — the same clock `todayInTimezone` uses. Relative rather
 * than hard-coded so an "expired" fixture stays expired, and a live one stays
 * live, however long after this was written the suite runs.
 */
function ymdFromNow(days: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(Date.now() + days * 86_400_000))
    .replace(/-/g, '');
}

/** YYYYMMDD → the YYYY-MM-DD an `<input type="date">` submits. */
function ymdToInput(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/** Weekday index (0 = Sunday) of a YYYYMMDD calendar date. */
function dowOf(ymd: string): number {
  return new Date(
    Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)),
  ).getUTCDay();
}

/**
 * The next date on or after today falling on weekday `dow` (0 = Sunday).
 *
 * The date-picker tests need to name a *known weekday* without hard-coding a
 * calendar date that would rot, and without asserting anything that only holds
 * on the day the suite happens to run.
 */
function nextDow(dow: number): string {
  for (let i = 0; i < 8; i++) {
    const ymd = ymdFromNow(i);
    if (dowOf(ymd) === dow) return ymd;
  }
  throw new Error(`no ${dow} within a week`);
}

/** Departure time unique to the expired seasonal pattern below. */
const SEASONAL_ONLY_TIME = '5:33p';
/** Departure time unique to the live all-week pattern below. */
const LIVE_ONLY_TIME = '9:09a';

/**
 * A live all-week pattern plus a seasonal Sat+Sun one that ended a month ago —
 * the `cat` (Columbia Area Transit) shape from issue #71, where a discontinued
 * Dog Mountain shuttle kept its own tab and full timetable.
 *
 * feed_end_date is deliberately a year out, so the feed-level
 * `renderExpiryWarning` stays silent and anything the page says about the
 * expired pattern has to come from the per-profile check.
 */
function makeExpiredSeasonalState(): SnapshotState {
  const base = makeFeedState();
  return {
    ...base,
    feedInfo: {
      feed_publisher_name: 'EmbedAgency',
      feed_start_date: ymdFromNow(-365),
      feed_end_date: ymdFromNow(365),
    },
    calendars: [
      { service_id: 'LIVE', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1, start_date: ymdFromNow(-365), end_date: ymdFromNow(365) },
      { service_id: 'SEASON', monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 1, sunday: 1, start_date: ymdFromNow(-120), end_date: ymdFromNow(-30) },
    ],
    calendarDates: [],
    trips: [
      { trip_id: 'lv1', route_id: 'R1', service_id: 'LIVE', direction_id: 0, shape_id: 'sh1', trip_headsign: 'Downtown' },
      { trip_id: 'sn1', route_id: 'R1', service_id: 'SEASON', direction_id: 0, shape_id: 'sh1', trip_headsign: 'Dog Mountain' },
    ],
    stopTimes: [
      { trip_id: 'lv1', arrival_time: '09:09:00', departure_time: '09:09:00', stop_id: 's1', stop_sequence: 1 },
      { trip_id: 'lv1', arrival_time: '09:19:00', departure_time: '09:19:00', stop_id: 's2', stop_sequence: 2 },
      { trip_id: 'sn1', arrival_time: '17:33:00', departure_time: '17:33:00', stop_id: 's1', stop_sequence: 1 },
      { trip_id: 'sn1', arrival_time: '17:43:00', departure_time: '17:43:00', stop_id: 's2', stop_sequence: 2 },
    ],
  };
}

/** Same two patterns, but both ended — nothing left to fall back to. */
function makeAllExpiredState(): SnapshotState {
  const base = makeExpiredSeasonalState();
  return {
    ...base,
    calendars: [
      { ...base.calendars[0], start_date: ymdFromNow(-365), end_date: ymdFromNow(-45) },
      base.calendars[1],
    ],
  };
}

/**
 * A feed whose *first-ranked* pattern is the expired one, on a day when nothing
 * at all is running: the live pattern is suppressed today by a
 * calendar_dates exception, so no profile intersects today's services and the
 * default falls through to profile order — which puts "Weekday" ahead of
 * "Daily". Without an expiry-aware default the rider opens on a schedule that
 * stopped running two months ago.
 *
 * The exception is what makes this day-independent: a fixture that relied on
 * "today is a Sunday" would prove nothing six days in seven.
 */
function makeExpiredDefaultState(): SnapshotState {
  const base = makeExpiredSeasonalState();
  return {
    ...base,
    calendars: [
      { service_id: 'OLDWK', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: ymdFromNow(-400), end_date: ymdFromNow(-60) },
      { service_id: 'LIVE', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1, start_date: ymdFromNow(-400), end_date: ymdFromNow(400) },
    ],
    calendarDates: [{ service_id: 'LIVE', date: ymdFromNow(0), exception_type: 2 }],
    trips: [
      { trip_id: 'ow1', route_id: 'R1', service_id: 'OLDWK', direction_id: 0, shape_id: 'sh1', trip_headsign: 'Downtown' },
      { trip_id: 'lv1', route_id: 'R1', service_id: 'LIVE', direction_id: 0, shape_id: 'sh1', trip_headsign: 'Downtown' },
    ],
    stopTimes: [
      { trip_id: 'ow1', arrival_time: '17:33:00', departure_time: '17:33:00', stop_id: 's1', stop_sequence: 1 },
      { trip_id: 'lv1', arrival_time: '09:09:00', departure_time: '09:09:00', stop_id: 's1', stop_sequence: 1 },
    ],
  };
}

/**
 * Weekday + Saturday over a range that always brackets today, for the date
 * picker (#73).
 *
 * The fixed 2026 range on `makeWeekdaySaturdayState` can't serve here: these
 * tests navigate to dates a year out, and a fixture whose calendar stops on a
 * hard-coded day would start reporting "outside the feed's range" for reasons
 * that have nothing to do with what's under test. Sunday is deliberately left
 * with no service at all — that's the "you picked a day nothing runs" case.
 */
function makeDatePickerState(): SnapshotState {
  const base = makeWeekdaySaturdayState();
  const start = ymdFromNow(-30);
  const end = ymdFromNow(300);
  return {
    ...base,
    feedInfo: { feed_publisher_name: 'EmbedAgency', feed_start_date: start, feed_end_date: end },
    calendars: base.calendars.map((c) => ({ ...c, start_date: start, end_date: end })),
  };
}

async function createPublishedProject(
  client: TestClient,
  name: string,
  state: SnapshotState = makeFeedState(),
): Promise<{ slug: string }> {
  const proj = await client.json<{ id: string; slug: string }>(
    await client.post('/api/projects', { name }),
  );

  const stateBuf = await gzip(JSON.stringify(state));
  const snapshotForm = new FormData();
  snapshotForm.append('state', new Blob([stateBuf], { type: 'application/json' }), 'state.json.gz');
  snapshotForm.append('meta', JSON.stringify({ summary: {}, validationErrors: 0, validationWarnings: 0 }));
  const snapshot = await client.json<{ snapshot: { id: string } }>(
    await client.post(`/api/projects/${proj.id}/snapshots`, undefined, { body: snapshotForm }),
  );

  const publishForm = new FormData();
  publishForm.append('meta', JSON.stringify({ snapshotId: snapshot.snapshot.id }));
  publishForm.append('zip', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' }), 'gtfs.zip');
  await client.post(`/api/projects/${proj.id}/publish`, undefined, { body: publishForm });

  return { slug: proj.slug };
}

describe('embed routes', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('GET /<slug>/embed/system-map renders an HTML page with route list', async () => {
    const client = await loggedInClient('emb1@example.com');
    const { slug } = await createPublishedProject(client, 'EmbedSys');

    const res = await SELF.fetch(`http://feeds.example.com/${slug}/embed/system-map`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Content-Security-Policy')).toContain('frame-ancestors *');
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    const html = await res.text();
    expect(html).toContain('Embed Agency');
    expect(html).toContain('System map');
    // Route list should include the only route.
    expect(html).toContain('Downtown');
    // Map container present.
    expect(html).toContain('id="gtfs-embed-map"');
  });

  it('GET /<slug>/embed/route/<id> renders schedule + map for that route', async () => {
    const client = await loggedInClient('emb2@example.com');
    const { slug } = await createPublishedProject(client, 'EmbedRoute');

    const res = await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Downtown');
    // Schedule table should have stop names.
    expect(html).toContain('Main &amp; 1st');
    expect(html).toContain('Main &amp; 2nd');
    expect(html).toContain('Main &amp; 3rd');
    // Trip times appear (12-hour format). 8:00a appears in both DAILY's
    // t1 and SAT's t3, so this passes whichever profile is the default
    // for today.
    expect(html).toContain('8:00a');
    expect(html).toContain('8:05a');
    // The rider's service-selection control. This asserted the service-day tab
    // labels until #73 replaced the tab row with the date picker; which pattern
    // the banner happens to name depends on the weekday the suite runs, so the
    // control itself is what's stable to assert here.
    expect(html).toContain('class="date-picker"');
  });

  it('GET /<slug>/embed/route/<id>?view=map renders only the map (no schedule table)', async () => {
    const client = await loggedInClient('emb-vm@example.com');
    const { slug } = await createPublishedProject(client, 'EmbedRouteMapView');

    const res = await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1?view=map`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Map container present, route name in the header.
    expect(html).toContain('id="gtfs-embed-map"');
    expect(html).toContain('Downtown');
    // No schedule grid in the map-only view.
    expect(html).not.toContain('table class="schedule"');
    expect(html).not.toContain('class="service-tabs"');
  });

  it('GET /<slug>/embed/route/<id>?view=schedule renders only the schedule (no map)', async () => {
    const client = await loggedInClient('emb-vs@example.com');
    const { slug } = await createPublishedProject(client, 'EmbedRouteSchedView');

    const res = await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1?view=schedule`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Schedule grid present.
    expect(html).toContain('Main &amp; 1st');
    expect(html).toContain('8:00a');
    // No map container in the schedule-only view.
    expect(html).not.toContain('id="gtfs-embed-map"');
  });

  // ─── Service-pattern selection (?service=<profile_id>) ─────────────────────
  //
  // The `service` param pins a service pattern instead of auto-selecting
  // today's. It is what the embed snippet panel's service picker bakes into a
  // copied iframe, and what the <gtfs-schedule service="…"> attribute maps to.
  //
  // Every one of these tests uses the weekday+saturday fixture, where exactly
  // one profile is ever "today's" — so a pin that silently fails shows up as
  // the wrong departure times rather than passing by coincidence.

  /** The profile catalogue as an integrator (and the snippet panel) sees it. */
  async function serviceProfiles(slug: string): Promise<{ id: string; label: string }[]> {
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/services`);
    expect(res.status).toBe(200);
    const body = await res.json() as { services: { id: string; label: string }[] };
    return body.services;
  }

  /**
   * Which profile the embed picks with no pin — depends on the day the suite
   * runs, so every assertion below is phrased relative to it rather than
   * hard-coding "Saturday".
   */
  async function todaysProfile(slug: string): Promise<{ label: string; time: string; otherLabel: string; otherTime: string }> {
    const html = await (await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1`)).text();
    const isSaturday = html.includes(SATURDAY_ONLY_TIME);
    return isSaturday
      ? { label: 'Saturday', time: SATURDAY_ONLY_TIME, otherLabel: 'Weekday', otherTime: WEEKDAY_ONLY_TIME }
      : { label: 'Weekday', time: WEEKDAY_ONLY_TIME, otherLabel: 'Saturday', otherTime: SATURDAY_ONLY_TIME };
  }

  it('renders a service-day tab per profile under ?show_services=1', async () => {
    const client = await loggedInClient('emb-svc-tabs@example.com');
    const { slug } = await createPublishedProject(client, 'EmbedSvcTabs', makeWeekdaySaturdayState());

    // Behind the reveal since #73 — the tab row is no longer the rider's
    // control, but it still has to be correct for anyone who asks for it.
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1?show_services=1`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="service-tabs"');
    expect(html).toContain('Weekday');
    expect(html).toContain('Saturday');
    // Each tab links to its own profile id, and exactly one is active.
    const profiles = await serviceProfiles(slug);
    expect(profiles.map((p) => p.label)).toEqual(['Weekday', 'Saturday']);
    for (const p of profiles) expect(html).toContain(`service=${p.id}`);
    expect(html.match(/class="active"/g) ?? []).toHaveLength(1);
  });

  it('?service=<id> pins the profile that is NOT today’s', async () => {
    const client = await loggedInClient('emb-svc-pin@example.com');
    const { slug } = await createPublishedProject(client, 'EmbedSvcPin', makeWeekdaySaturdayState());

    const today = await todaysProfile(slug);
    const profiles = await serviceProfiles(slug);
    const target = profiles.find((p) => p.label === today.otherLabel);
    expect(target).toBeTruthy();

    const res = await SELF.fetch(
      `http://feeds.example.com/${slug}/embed/route/R1?service=${encodeURIComponent(target!.id)}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The pinned profile's departures render…
    expect(html).toContain(today.otherTime);
    // …and today's do not. Without the pin this page shows the opposite pair,
    // so a silently-ignored `service` param fails here rather than passing.
    expect(html).not.toContain(today.time);
  });

  it('falls back to today’s service for an unknown ?service= instead of erroring', async () => {
    const client = await loggedInClient('emb-svc-bad@example.com');
    const { slug } = await createPublishedProject(client, 'EmbedSvcBad', makeWeekdaySaturdayState());

    const today = await todaysProfile(slug);
    const res = await SELF.fetch(
      `http://feeds.example.com/${slug}/embed/route/R1?service=svc-not-a-real-profile`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(today.time);
    expect(html).not.toContain(today.otherTime);
    // Still a usable page: the date picker renders so the rider can get to
    // another day's schedule. (Was the tab row before #73 hid it by default.)
    expect(html).toContain('class="date-picker"');
  });

  it('folds the service pin into the ETag so variants cache separately', async () => {
    const client = await loggedInClient('emb-svc-etag@example.com');
    const { slug } = await createPublishedProject(client, 'EmbedSvcEtag', makeWeekdaySaturdayState());

    const profiles = await serviceProfiles(slug);
    expect(profiles).toHaveLength(2);
    const base = `http://feeds.example.com/${slug}/embed/route/R1`;

    const auto = await SELF.fetch(base);
    const first = await SELF.fetch(`${base}?service=${profiles[0].id}`);
    const second = await SELF.fetch(`${base}?service=${profiles[1].id}`);
    const autoTag = auto.headers.get('ETag');
    const firstTag = first.headers.get('ETag');
    const secondTag = second.headers.get('ETag');
    expect(autoTag).toBeTruthy();
    expect(firstTag).toBeTruthy();
    expect(firstTag).not.toBe(secondTag);
    expect(firstTag).not.toBe(autoTag);
    expect(secondTag).not.toBe(autoTag);

    // Same pin revalidates to 304…
    const same = await SELF.fetch(`${base}?service=${profiles[0].id}`, {
      headers: { 'If-None-Match': firstTag as string },
    });
    expect(same.status).toBe(304);

    // …but the other pin must NOT, or an edge cache would hand a rider the
    // wrong service pattern's schedule.
    const cross = await SELF.fetch(`${base}?service=${profiles[1].id}`, {
      headers: { 'If-None-Match': firstTag as string },
    });
    expect(cross.status).toBe(200);
    expect(await cross.text()).toContain(
      profiles[1].label === 'Saturday' ? SATURDAY_ONLY_TIME : WEEKDAY_ONLY_TIME,
    );
  });

  it('labels service-day tabs by day pattern, not by joining day abbreviations', async () => {
    const client = await loggedInClient('emb-svc-labels@example.com');
    const { slug } = await createPublishedProject(client, 'EmbedSvcLabels', makeDayPatternState());

    const res = await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1?show_services=1`);
    expect(res.status).toBe(200);
    const html = await res.text();

    // Asserted as tab text (`>Label</a>`) rather than a bare substring: "Fri"
    // also appears inside the today-banner's "Friday" one day in seven.
    expect(html).toContain('>Weekend</a>');
    expect(html).toContain('>Mon–Sat</a>');
    expect(html).toContain('>Fri</a>');
    // The strings these replace, which is what riders see today.
    expect(html).not.toContain('>Sun Sat</a>');
    expect(html).not.toContain('>Mon Tue Wed Thu Fri Sat</a>');
  });

  it('publishes the same labels to the snippet panel’s dropdown', async () => {
    const client = await loggedInClient('emb-svc-labels-api@example.com');
    const { slug } = await createPublishedProject(client, 'EmbedSvcLabelsApi', makeDayPatternState());

    // All three fall into "other" and sort alphabetically there — the
    // pre-existing rule, deliberately unchanged by the relabelling.
    const profiles = await serviceProfiles(slug);
    expect(profiles.map((p) => p.label)).toEqual(['Fri', 'Mon–Sat', 'Weekend']);
  });

  // ─── Expired service patterns (issue #71) ──────────────────────────────────
  //
  // A pattern whose calendar.txt date range has already ended is not a schedule
  // any more, but the embed rendered it as one: a clickable tab backed by a
  // full timetable, with nothing to say the service is over. `renderExpiryWarning`
  // never caught it — it reads feed_info.feed_end_date, which on the reported
  // feed was still a year out.
  //
  // Riders don't see expired patterns; operators still do (see the API test at
  // the end of this block). Every fixture here keeps feed_end_date in the future
  // so the feed-level warning stays silent and the per-profile check is what's
  // under test.
  describe('expired service patterns', () => {
    /** The catalogue as an integrator sees it, including the expiry fields. */
    async function servicesApi(slug: string) {
      const res = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/services`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        services: { id: string; label: string; end_date?: string; expired?: boolean }[];
      };
      return body.services;
    }

    it('hides an expired pattern from the rider’s tabs, and says it did', async () => {
      const client = await loggedInClient('emb-exp-hide@example.com');
      const { slug } = await createPublishedProject(client, 'EmbedExpHide', makeExpiredSeasonalState());

      const html = await (
        await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1`)
      ).text();

      // The live pattern's timetable is what a rider gets; the ended one is
      // gone from the page entirely.
      expect(html).toContain(LIVE_ONLY_TIME);
      expect(html).not.toContain('Weekend');
      expect(html).not.toContain(SEASONAL_ONLY_TIME);
      // Since #73 there is no tab row on the default page at all, so there is
      // no dropped tab to explain — the note that used to say so would now be
      // describing a row the rider can't see either way.
      expect(html).not.toContain('class="service-tabs"');
      expect(html).not.toContain('Past service patterns are hidden');

      // Ask for the tab row and the asymmetry is intact: the ended pattern is
      // still withheld, and the page says so and offers the way to see it.
      // Dropping a tab silently would be its own small lie. (No `service-tabs`
      // nav here — with the ended pattern withheld only one is left, and there
      // is nothing to switch between; the note carries the explanation.)
      const tabs = await (
        await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1?show_services=1`)
      ).text();
      expect(tabs).not.toContain(SEASONAL_ONLY_TIME);
      expect(tabs).toContain('Past service patterns are hidden');
      expect(tabs).toContain('show_expired=1');
    });

    it('?show_expired=1 brings the expired pattern back, marked as ended', async () => {
      const client = await loggedInClient('emb-exp-show@example.com');
      const { slug } = await createPublishedProject(client, 'EmbedExpShow', makeExpiredSeasonalState());

      const html = await (
        await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1?show_expired=1`)
      ).text();

      expect(html).toContain('Weekend (ended)');
      expect(html).toContain('>Daily</a>');
      // Nothing left to hide, so the note retires with it.
      expect(html).not.toContain('Past service patterns are hidden');
    });

    it('shows every pattern, plus a warning, when all of them have expired', async () => {
      const client = await loggedInClient('emb-exp-all@example.com');
      const { slug } = await createPublishedProject(client, 'EmbedExpAll', makeAllExpiredState());

      const html = await (
        await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1`)
      ).text();

      // Hiding everything would leave a rider with an empty page, so the
      // fallback pattern's timetable still renders — and carries the notice.
      expect(html).toContain('This schedule ended on');
      expect(html).not.toContain('Past service patterns are hidden');
      // The feed as a whole has NOT expired, so the feed-level banner is silent
      // and this warning is the only thing telling the rider.
      expect(html).not.toContain('Schedule expired');

      // Nothing is suppressed from the tab row either, once it's asked for:
      // when every pattern has ended there is no live one to prefer.
      const tabs = await (
        await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1?show_services=1`)
      ).text();
      expect(tabs).toContain('Daily (ended)');
      expect(tabs).toContain('Weekend (ended)');
      expect(tabs).not.toContain('Past service patterns are hidden');
    });

    it('honours an explicit ?service= pin at an expired pattern, with the warning', async () => {
      const client = await loggedInClient('emb-exp-pin@example.com');
      const { slug } = await createPublishedProject(client, 'EmbedExpPin', makeExpiredSeasonalState());

      const profiles = await servicesApi(slug);
      const seasonal = profiles.find((p) => p.label === 'Weekend');
      expect(seasonal).toBeTruthy();

      const html = await (
        await SELF.fetch(
          `http://feeds.example.com/${slug}/embed/route/R1?service=${encodeURIComponent(seasonal!.id)}`,
        )
      ).text();

      // Someone has this URL pinned in a page: render what they asked for
      // rather than silently substituting today's service…
      expect(html).toContain(SEASONAL_ONLY_TIME);
      expect(html).not.toContain(LIVE_ONLY_TIME);
      // …and tell them it's over.
      expect(html).toContain('This schedule ended on');

      // The selected pattern's tab is visible and marked once the row is asked
      // for — a selected tab missing from its own row reads as a broken page.
      const tabs = await (
        await SELF.fetch(
          `http://feeds.example.com/${slug}/embed/route/R1?service=${encodeURIComponent(seasonal!.id)}&show_services=1`,
        )
      ).text();
      expect(tabs).toContain('Weekend (ended)');
    });

    it('picks a live pattern as the default even when an expired one sorts first', async () => {
      const client = await loggedInClient('emb-exp-default@example.com');
      const { slug } = await createPublishedProject(client, 'EmbedExpDefault', makeExpiredDefaultState());

      const html = await (
        await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1`)
      ).text();

      // The live pattern's departures, not the two-month-dead one's.
      expect(html).toContain(LIVE_ONLY_TIME);
      expect(html).not.toContain(SEASONAL_ONLY_TIME);
      expect(html).not.toContain('This schedule ended on');
    });

    it('publishes expired patterns to the operator API instead of hiding them', async () => {
      const client = await loggedInClient('emb-exp-api@example.com');
      const { slug } = await createPublishedProject(client, 'EmbedExpApi', makeExpiredSeasonalState());

      const profiles = await servicesApi(slug);
      // Deliberately asymmetric with the embed above: an agency pinning a
      // seasonal pattern needs to see it before its season, and needs to be
      // able to tell why one vanished from the rider page.
      expect(profiles.map((p) => p.label)).toEqual(['Daily', 'Weekend']);
      const live = profiles.find((p) => p.label === 'Daily');
      const seasonal = profiles.find((p) => p.label === 'Weekend');
      expect(live?.expired).toBe(false);
      expect(seasonal?.expired).toBe(true);
      // …and the date it was judged on, so the picker can label it.
      expect(seasonal?.end_date).toBe(ymdFromNow(-30));
      expect(live?.end_date).toBe(ymdFromNow(365));
    });

    it('caches the hidden and shown variants apart', async () => {
      const client = await loggedInClient('emb-exp-etag@example.com');
      const { slug } = await createPublishedProject(client, 'EmbedExpEtag', makeExpiredSeasonalState());
      const base = `http://feeds.example.com/${slug}/embed/route/R1`;

      const hidden = await SELF.fetch(base);
      const shown = await SELF.fetch(`${base}?show_expired=1`);
      const hiddenTag = hidden.headers.get('ETag');
      expect(hiddenTag).toBeTruthy();
      expect(shown.headers.get('ETag')).not.toBe(hiddenTag);

      // An edge cache holding the hidden variant must not answer the shown one.
      const cross = await SELF.fetch(`${base}?show_expired=1`, {
        headers: { 'If-None-Match': hiddenTag as string },
      });
      expect(cross.status).toBe(200);
      expect(await cross.text()).toContain('Weekend (ended)');
    });

    it('localizes the hidden-pattern note and the ended warning (es)', async () => {
      const client = await loggedInClient('emb-exp-i18n@example.com');
      const { slug } = await createPublishedProject(client, 'EmbedExpI18n', makeAllExpiredState());

      const html = await (
        await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1?lang=es&show_services=1`)
      ).text();
      expect(html).toContain('Este horario finalizó el');
      expect(html).toContain('(finalizado)');
      expect(html).not.toContain('This schedule ended on');
    });
  });

  // ─── Rider date picker (?date=, issue #73) ─────────────────────────────────
  //
  // The date picker replaced the service-day tabs as the rider's way to reach a
  // pattern that isn't today's. The tabs are gone from the page by default;
  // `?date=` is what selects a pattern now, and it is *navigation state a rider
  // sets*, never something an agency bakes into a snippet — see the
  // embedOptions test asserting the snippet builder can't emit one.
  describe('date picker', () => {
    const R1 = (slug: string) => `http://feeds.example.com/${slug}/embed/route/R1`;
    const get = async (u: string) => (await SELF.fetch(u)).text();

    async function pickerProject(email: string, name: string) {
      const client = await loggedInClient(email);
      return createPublishedProject(client, name, makeDatePickerState());
    }

    it('defaults to today’s service, with no date in the URL and the picker on today', async () => {
      const { slug } = await pickerProject('emb-dp-default@example.com', 'EmbedDpDefault');

      const res = await SELF.fetch(R1(slug));
      expect(res.status).toBe(200);
      const html = await res.text();

      // Whichever weekday the suite runs on, the cold page shows that day's
      // pattern — Sunday has no service in this fixture, so it shows neither.
      const dow = dowOf(ymdFromNow(0));
      if (dow === 0) expect(html).toContain('No service today');
      else if (dow === 6) expect(html).toContain(SATURDAY_ONLY_TIME);
      else expect(html).toContain(WEEKDAY_ONLY_TIME);

      // The picker is present and pointed at today, and the page it renders is
      // reachable without any date param at all.
      expect(html).toContain('class="date-picker"');
      expect(html).toContain(`value="${ymdToInput(ymdFromNow(0))}"`);
      expect(html).toContain('<strong>Today is');
    });

    it('?date= selects the pattern for that date, not today’s', async () => {
      const { slug } = await pickerProject('emb-dp-select@example.com', 'EmbedDpSelect');

      // Asserted in both directions in one test on purpose: today can only be
      // one weekday, so a build that ignores `date` and renders today's pattern
      // fails one of these two halves whichever day it runs.
      const sat = await get(`${R1(slug)}?date=${ymdToInput(nextDow(6))}`);
      expect(sat).toContain(SATURDAY_ONLY_TIME);
      expect(sat).not.toContain(WEEKDAY_ONLY_TIME);

      const wed = await get(`${R1(slug)}?date=${ymdToInput(nextDow(3))}`);
      expect(wed).toContain(WEEKDAY_ONLY_TIME);
      expect(wed).not.toContain(SATURDAY_ONLY_TIME);
    });

    it('names the selected day instead of claiming it is today', async () => {
      const { slug } = await pickerProject('emb-dp-banner@example.com', 'EmbedDpBanner');

      // A page headed "Today is …" over next week's timetable is worse than no
      // heading, so the lead clause has to follow the date.
      const wed = nextDow(3);
      const other = dowOf(ymdFromNow(0)) === 3 ? nextDow(4) : wed;
      const html = await get(`${R1(slug)}?date=${ymdToInput(other)}`);
      expect(html).not.toContain('<strong>Today is');
      expect(html).toContain(`value="${ymdToInput(other)}"`);
    });

    it('does not render the service-day tabs by default', async () => {
      const { slug } = await pickerProject('emb-dp-notabs@example.com', 'EmbedDpNoTabs');

      const html = await get(R1(slug));
      // The whole point of the picker: one control, not two.
      expect(html).not.toContain('class="service-tabs"');
      expect(html).toContain('class="date-picker"');
    });

    it('?show_services=1 puts the tab row back for diagnosis', async () => {
      const { slug } = await pickerProject('emb-dp-showtabs@example.com', 'EmbedDpShowTabs');

      const html = await get(`${R1(slug)}?show_services=1`);
      expect(html).toContain('class="service-tabs"');
      expect(html).toContain('>Weekday</a>');
      expect(html).toContain('>Saturday</a>');
    });

    it('explains a date this route does not run, and offers the next one', async () => {
      const { slug } = await pickerProject('emb-dp-noservice@example.com', 'EmbedDpNoService');

      // Sunday: inside the feed's range, but nothing runs.
      const html = await get(`${R1(slug)}?date=${ymdToInput(nextDow(0))}`);
      expect(html).toContain('No service on this date');
      // Not an unexplained empty table, and not some other day's timetable
      // rendered under a "no service" banner.
      expect(html).not.toContain('table class="schedule"');
      expect(html).not.toContain(WEEKDAY_ONLY_TIME);
      expect(html).not.toContain(SATURDAY_ONLY_TIME);
      // A dead end with a date picker on it is still a dead end — Monday runs.
      expect(html).toContain('Next service');
      expect(html).toContain(`date=${ymdToInput(nextDow(1))}`);
      // In range, so the coverage sentence stays out of the way.
      expect(html).not.toContain('This schedule covers');
    });

    it('tells a date outside the feed’s calendar apart from a day with no service', async () => {
      const { slug } = await pickerProject('emb-dp-range@example.com', 'EmbedDpRange');

      // 400 days out — past this fixture's calendar end at +300. "The bus
      // doesn't run then" would be a claim nobody can make.
      const html = await get(`${R1(slug)}?date=${ymdToInput(ymdFromNow(400))}`);
      expect(html).toContain('This schedule covers');
      expect(html).not.toContain('table class="schedule"');
      // Nothing ahead of it, so no next-service link to offer.
      expect(html).not.toContain('Next service');
    });

    it('bounds the input to the feed’s calendar range', async () => {
      const { slug } = await pickerProject('emb-dp-bounds@example.com', 'EmbedDpBounds');

      const html = await get(R1(slug));
      expect(html).toContain(`min="${ymdToInput(ymdFromNow(-30))}"`);
      expect(html).toContain(`max="${ymdToInput(ymdFromNow(300))}"`);
    });

    it('falls back to today for a date that isn’t one, instead of erroring', async () => {
      const { slug } = await pickerProject('emb-dp-bad@example.com', 'EmbedDpBad');

      // Syntactically fine, doesn't exist. Date.UTC would roll it into March.
      const res = await SELF.fetch(`${R1(slug)}?date=2026-02-30`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`value="${ymdToInput(ymdFromNow(0))}"`);
      expect(html).toContain('<strong>Today is');
      expect(html).not.toContain('No service on this date');
    });

    it('lets an explicit date outrank a pinned ?service=', async () => {
      const { slug } = await pickerProject('emb-dp-precedence@example.com', 'EmbedDpPrecedence');

      const profiles = await serviceProfiles(slug);
      const saturday = profiles.find((p) => p.label === 'Saturday');
      expect(saturday).toBeTruthy();

      // The pin is where the page starts; the date is what the rider did next.
      // Honouring the pin here would make the picker a control that does nothing.
      const html = await get(
        `${R1(slug)}?service=${encodeURIComponent(saturday!.id)}&date=${ymdToInput(nextDow(3))}`,
      );
      expect(html).toContain(WEEKDAY_ONLY_TIME);
      expect(html).not.toContain(SATURDAY_ONLY_TIME);
    });

    it('drops the service pin when a date is submitted, and carries the theme', async () => {
      const { slug } = await pickerProject('emb-dp-form@example.com', 'EmbedDpForm');

      const profiles = await serviceProfiles(slug);
      const html = await get(
        `${R1(slug)}?service=${encodeURIComponent(profiles[0].id)}&lang=es&theme=dark`,
      );
      expect(html).toContain('class="date-picker"');
      // A GET form replaces the query with exactly its own fields, so the
      // hidden-input list IS the definition of what survives picking a date.
      expect(html).toContain('name="lang"');
      expect(html).toContain('name="theme"');
      expect(html).not.toContain('name="service"');
    });

    it('folds the selected date into the ETag so dates cache apart', async () => {
      const { slug } = await pickerProject('emb-dp-etag@example.com', 'EmbedDpEtag');

      const sat = await SELF.fetch(`${R1(slug)}?date=${ymdToInput(nextDow(6))}`);
      const wed = await SELF.fetch(`${R1(slug)}?date=${ymdToInput(nextDow(3))}`);
      const satTag = sat.headers.get('ETag');
      expect(satTag).toBeTruthy();
      expect(wed.headers.get('ETag')).not.toBe(satTag);

      // An edge cache holding Saturday must not answer Wednesday — that would
      // hand a rider a timetable for a day they didn't ask about.
      const cross = await SELF.fetch(`${R1(slug)}?date=${ymdToInput(nextDow(3))}`, {
        headers: { 'If-None-Match': satTag as string },
      });
      expect(cross.status).toBe(200);
      expect(await cross.text()).toContain(WEEKDAY_ONLY_TIME);
    });

    it('localizes the picker and the no-service answer (es)', async () => {
      const { slug } = await pickerProject('emb-dp-i18n@example.com', 'EmbedDpI18n');

      const html = await get(`${R1(slug)}?date=${ymdToInput(nextDow(0))}&lang=es`);
      expect(html).toContain('Sin servicio en esta fecha');
      expect(html).toContain('Próximo servicio');
      expect(html).toContain('Ver el horario de una fecha');
      expect(html).not.toContain('No service on this date');
    });
  });

  it('GET /widgets.js serves the web-component loader (origin-level, no slug)', async () => {
    const res = await SELF.fetch('http://feeds.example.com/widgets.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('javascript');
    // Cross-origin by design — the host page lives anywhere.
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const js = await res.text();
    // Registers all four custom elements.
    expect(js).toContain("defineWidget('gtfs-system-map')");
    expect(js).toContain("defineWidget('gtfs-route-map')");
    expect(js).toContain("defineWidget('gtfs-schedule')");
    expect(js).toContain("defineWidget('gtfs-stop')");
    // The map/schedule widgets request the sectioned views.
    expect(js).toContain('?view=map');
    expect(js).toContain('?view=schedule');
    // No origin placeholder left unresolved.
    expect(js).not.toContain('__ORIGIN__');
  });

  it('GET /widgets.js supports conditional requests via ETag', async () => {
    const first = await SELF.fetch('http://feeds.example.com/widgets.js');
    expect(first.status).toBe(200);
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();
    const second = await SELF.fetch('http://feeds.example.com/widgets.js', {
      headers: { 'If-None-Match': etag as string },
    });
    expect(second.status).toBe(304);
  });

  it('GET /<slug>/embed/route/<unknown> returns 404', async () => {
    const client = await loggedInClient('emb3@example.com');
    const { slug } = await createPublishedProject(client, 'EmbedMiss');
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/no-such-route`);
    expect(res.status).toBe(404);
  });

  it('GET /<bad-slug>/embed/system-map returns 404', async () => {
    const res = await SELF.fetch('http://feeds.example.com/no-such-slug/embed/system-map');
    expect(res.status).toBe(404);
  });

  it('GET /<slug>/embed/stop/<id> renders the per-stop departures page', async () => {
    const client = await loggedInClient('emb4@example.com');
    const { slug } = await createPublishedProject(client, 'EmbedStop');
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/embed/stop/s1`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Main &amp; 1st');
    expect(body).toContain('Departures today');
    expect(body).toContain('Routes that serve this stop');
    expect(body).toContain('8:00a');
  });

  it('GET /<slug>/ renders the mini-site landing page (indexable)', async () => {
    const client = await loggedInClient('emb5@example.com');
    const { slug } = await createPublishedProject(client, 'EmbedLanding');
    const res = await SELF.fetch(`http://feeds.example.com/${slug}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Embed Agency');
    // Landing page should NOT be noindex.
    expect(body).not.toContain('name="robots" content="noindex"');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('Org logo upload + public read + embed render round-trip', async () => {
    const client = await loggedInClient('emb-logo@example.com');
    // Create an org and a project owned by it.
    const orgRes = await client.json<{ organization: { id: string; slug: string } }>(
      await client.post('/api/orgs', { slug: 'logo-org', name: 'Logo Org' }),
    );
    await testEnv.DB.prepare('UPDATE organization SET plan = ? WHERE id = ?')
      .bind('agency', orgRes.organization.id)
      .run();
    const proj = await client.json<{ id: string; slug: string }>(
      await client.post('/api/projects', {
        name: 'LogoEmbed',
        owner: { type: 'org', id: orgRes.organization.id },
      }),
    );

    // Upload a tiny PNG.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      // IHDR (1x1)
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
      // IDAT
      0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54,
      0x08, 0x99, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33,
      // IEND
      0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'logo.png');
    const upload = await client.post(`/api/orgs/${orgRes.organization.id}/logo`, undefined, { body: form });
    expect(upload.status).toBe(200);
    const uploadJson = await upload.json() as { organization: { brandLogoUpdatedAt: number } };
    expect(uploadJson.organization.brandLogoUpdatedAt).toBeGreaterThan(0);

    // Public read endpoint serves the bytes.
    const logoRes = await SELF.fetch(`http://feeds.example.com/_/orgs/${orgRes.organization.id}/logo`);
    expect(logoRes.status).toBe(200);
    expect(logoRes.headers.get('Content-Type')).toBe('image/png');
    expect(logoRes.headers.get('Access-Control-Allow-Origin')).toBe('*');

    // Publish so the embed has data, then verify the embed HTML embeds the logo.
    const stateBuf = await gzip(JSON.stringify(makeFeedState()));
    const snapshotForm = new FormData();
    snapshotForm.append('state', new Blob([stateBuf], { type: 'application/json' }), 'state.json.gz');
    snapshotForm.append('meta', JSON.stringify({ summary: {}, validationErrors: 0, validationWarnings: 0 }));
    const snapshot = await client.json<{ snapshot: { id: string } }>(
      await client.post(`/api/projects/${proj.id}/snapshots`, undefined, { body: snapshotForm }),
    );
    const publishForm = new FormData();
    publishForm.append('meta', JSON.stringify({ snapshotId: snapshot.snapshot.id }));
    publishForm.append('zip', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' }), 'gtfs.zip');
    await client.post(`/api/projects/${proj.id}/publish`, undefined, { body: publishForm });

    const landingRes = await SELF.fetch(`http://feeds.example.com/${proj.slug}`);
    expect(landingRes.status).toBe(200);
    const landingHtml = await landingRes.text();
    expect(landingHtml).toContain(`/_/orgs/${orgRes.organization.id}/logo`);
    expect(landingHtml).toContain('class="brand-logo"');
  });

  it('PATCH /api/projects/:id supports brandPrimaryColor and the embed picks it up', async () => {
    const client = await loggedInClient('emb6@example.com');
    const proj = await client.json<{ id: string; slug: string }>(
      await client.post('/api/projects', { name: 'Brand' }),
    );
    // Set a brand color.
    const updated = await client.json<{ brandPrimaryColor: string | null }>(
      await client.patch(`/api/projects/${proj.id}`, { brandPrimaryColor: 'a32d5e' }),
    );
    expect(updated.brandPrimaryColor).toBe('a32d5e');

    // Publish so the embed has something to render.
    const stateBuf = await gzip(JSON.stringify(makeFeedState()));
    const snapshotForm = new FormData();
    snapshotForm.append('state', new Blob([stateBuf], { type: 'application/json' }), 'state.json.gz');
    snapshotForm.append('meta', JSON.stringify({ summary: {}, validationErrors: 0, validationWarnings: 0 }));
    const snapshot = await client.json<{ snapshot: { id: string } }>(
      await client.post(`/api/projects/${proj.id}/snapshots`, undefined, { body: snapshotForm }),
    );
    const publishForm = new FormData();
    publishForm.append('meta', JSON.stringify({ snapshotId: snapshot.snapshot.id }));
    publishForm.append('zip', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' }), 'gtfs.zip');
    await client.post(`/api/projects/${proj.id}/publish`, undefined, { body: publishForm });

    const res = await SELF.fetch(`http://feeds.example.com/${proj.slug}/embed/system-map`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('--brand: #a32d5e');
  });

  // ─── Back-navigation out of the system map (issue #72) ─────────────────────
  //
  // The system map links to route pages, and its stop popups link to stop
  // pages, neither with a `target` — so the click navigates *inside* the host's
  // iframe. Both destinations need a visible way back or the rider is stranded
  // with only the browser back button, which on mobile is no affordance at all.
  describe('back link to the system map', () => {
    it('route embed links back to the system map', async () => {
      const client = await loggedInClient('emb-back1@example.com');
      const { slug } = await createPublishedProject(client, 'EmbedBackRoute');

      const html = await (
        await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1`)
      ).text();
      expect(html).toContain(`href="/${slug}/embed/system-map?lang=en"`);
      // The arrow is decorative — the accessible name is the visible text.
      expect(html).toContain('<span class="arrow" aria-hidden="true">←</span>All routes');
    });

    it('stop embed links back to the system map (reachable from a map stop popup)', async () => {
      const client = await loggedInClient('emb-back2@example.com');
      const { slug } = await createPublishedProject(client, 'EmbedBackStop');

      const html = await (
        await SELF.fetch(`http://feeds.example.com/${slug}/embed/stop/s1`)
      ).text();
      expect(html).toContain(`href="/${slug}/embed/system-map?lang=en"`);
      expect(html).toContain('<span class="arrow" aria-hidden="true">←</span>All routes');
    });

    it('localizes the label and keeps the language on the destination (es)', async () => {
      const client = await loggedInClient('emb-back3@example.com');
      const { slug } = await createPublishedProject(client, 'EmbedBackEs');

      const html = await (
        await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1?lang=es`)
      ).text();
      expect(html).toContain('Todas las rutas');
      expect(html).not.toContain('All routes');
      // Language survives the hop, so the rider doesn't land on an English map.
      expect(html).toContain(`href="/${slug}/embed/system-map?lang=es"`);
    });

    it('carries the theme across so the destination keeps the host look (fr, dark, accent)', async () => {
      const client = await loggedInClient('emb-back4@example.com');
      const { slug } = await createPublishedProject(client, 'EmbedBackTheme');

      const html = await (
        await SELF.fetch(
          `http://feeds.example.com/${slug}/embed/route/R1?lang=fr&theme=dark&accent=0055aa`,
        )
      ).text();
      expect(html).toContain('Toutes les lignes');
      expect(html).toContain(
        `href="/${slug}/embed/system-map?accent=0055aa&amp;theme=dark&amp;lang=fr"`,
      );
    });

    it('the system map does not link to itself', async () => {
      const client = await loggedInClient('emb-back5@example.com');
      const { slug } = await createPublishedProject(client, 'EmbedBackSelf');

      const html = await (
        await SELF.fetch(`http://feeds.example.com/${slug}/embed/system-map`)
      ).text();
      expect(html).not.toContain('class="embed-nav"');
      expect(html).not.toContain(`href="/${slug}/embed/system-map`);
      // The forward direction is untouched — it still links out to routes.
      expect(html).toContain(`href="/${slug}/embed/route/R1"`);
    });

    it('the mini-site landing page keeps its own navigation (no back link)', async () => {
      const client = await loggedInClient('emb-back6@example.com');
      const { slug } = await createPublishedProject(client, 'EmbedBackLanding');

      const html = await (await SELF.fetch(`http://feeds.example.com/${slug}`)).text();
      expect(html).not.toContain('class="embed-nav"');
    });

    it('sectioned widget views stay chrome-free', async () => {
      const client = await loggedInClient('emb-back7@example.com');
      const { slug } = await createPublishedProject(client, 'EmbedBackViews');

      const mapView = await (
        await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1?view=map`)
      ).text();
      const schedView = await (
        await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1?view=schedule`)
      ).text();
      expect(mapView).not.toContain('class="embed-nav"');
      expect(schedView).not.toContain('class="embed-nav"');
    });

    it('leaves the ETag scheme intact — the href is a pure function of the cache key', async () => {
      const client = await loggedInClient('emb-back8@example.com');
      const { slug } = await createPublishedProject(client, 'EmbedBackEtag');

      const first = await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1`);
      const etag = first.headers.get('ETag');
      expect(etag).toBeTruthy();

      const repeat = await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1`, {
        headers: { 'If-None-Match': etag as string },
      });
      expect(repeat.status).toBe(304);

      // A different language renders a different back-link href, and is a
      // different ETag variant — so it can never be served from the `en` key.
      const es = await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1?lang=es`, {
        headers: { 'If-None-Match': etag as string },
      });
      expect(es.status).toBe(200);
      expect(es.headers.get('ETag')).not.toBe(etag);
    });
  });
});
