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
    // Service-day tab labels (multiple profiles → tabs visible).
    expect(html).toContain('Daily');
    expect(html).toContain('Saturday');
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

  it('renders a service-day tab per profile for a weekday + saturday feed', async () => {
    const client = await loggedInClient('emb-svc-tabs@example.com');
    const { slug } = await createPublishedProject(client, 'EmbedSvcTabs', makeWeekdaySaturdayState());

    const res = await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1`);
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
    // Still a usable page: tabs render so the rider can pick a real one.
    expect(html).toContain('class="service-tabs"');
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
});
