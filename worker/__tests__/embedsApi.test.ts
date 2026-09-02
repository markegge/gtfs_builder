// Tests for the read-only JSON API at feeds.*/<slug>/api/v1/...
// Mirrors the structure of embeds.test.ts (which covers the HTML embeds).

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

async function loggedInClient(email: string): Promise<{ client: TestClient; userId: string }> {
  const user = await seedUser({ email });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return { client, userId: user.id };
}

function makeFeedState() {
  return {
    feedInfo: { feed_publisher_name: 'ApiAgency', feed_start_date: '20260101', feed_end_date: '20261231' },
    agencies: [
      { agency_id: 'a1', agency_name: 'API Agency', agency_url: 'https://x.test', agency_timezone: 'America/Denver' },
    ],
    routes: [
      { route_id: 'R1', agency_id: 'a1', route_short_name: '1', route_long_name: 'Downtown', route_type: 3, route_color: '8e44ad', route_text_color: 'ffffff' },
      { route_id: 'R2', agency_id: 'a1', route_short_name: '2', route_long_name: 'Uptown', route_type: 3, route_color: '2980b9', route_text_color: 'ffffff' },
    ],
    stops: [
      { stop_id: 's1', stop_code: 'A1', stop_name: 'Main & 1st', stop_lat: 45.6, stop_lon: -111.0, wheelchair_boarding: 1 },
      { stop_id: 's2', stop_name: 'Main & 2nd', stop_lat: 45.61, stop_lon: -111.01 },
      { stop_id: 's3', stop_name: 'Main & 3rd', stop_lat: 45.62, stop_lon: -111.02 },
    ],
    shapes: [{ shape_id: 'sh1', points: [
      { shape_pt_lat: 45.6, shape_pt_lon: -111.0, shape_pt_sequence: 1 },
      { shape_pt_lat: 45.62, shape_pt_lon: -111.02, shape_pt_sequence: 2 },
    ] }],
    calendars: [
      { service_id: 'DAILY', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1, start_date: '20260101', end_date: '20261231' },
      { service_id: 'SAT', monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 1, sunday: 0, start_date: '20260101', end_date: '20261231' },
    ],
    calendarDates: [],
    trips: [
      { trip_id: 't1', route_id: 'R1', service_id: 'DAILY', direction_id: 0, shape_id: 'sh1', trip_headsign: 'Downtown' },
      { trip_id: 't2', route_id: 'R1', service_id: 'DAILY', direction_id: 1, shape_id: 'sh1', trip_headsign: 'Uptown' },
      { trip_id: 't3', route_id: 'R1', service_id: 'SAT', direction_id: 0, shape_id: 'sh1', trip_headsign: 'Downtown' },
      { trip_id: 't4', route_id: 'R2', service_id: 'DAILY', direction_id: 0, trip_headsign: 'Uptown' },
    ],
    stopTimes: [
      { trip_id: 't1', arrival_time: '08:00:00', departure_time: '08:00:00', stop_id: 's1', stop_sequence: 1 },
      { trip_id: 't1', arrival_time: '08:05:00', departure_time: '08:05:00', stop_id: 's2', stop_sequence: 2 },
      { trip_id: 't1', arrival_time: '08:10:00', departure_time: '08:10:00', stop_id: 's3', stop_sequence: 3 },
      { trip_id: 't2', arrival_time: '09:10:00', departure_time: '09:10:00', stop_id: 's3', stop_sequence: 1 },
      { trip_id: 't2', arrival_time: '09:15:00', departure_time: '09:15:00', stop_id: 's2', stop_sequence: 2 },
      { trip_id: 't2', arrival_time: '09:20:00', departure_time: '09:20:00', stop_id: 's1', stop_sequence: 3 },
      { trip_id: 't3', arrival_time: '10:00:00', departure_time: '10:00:00', stop_id: 's1', stop_sequence: 1 },
      { trip_id: 't4', arrival_time: '07:30:00', departure_time: '07:30:00', stop_id: 's1', stop_sequence: 1 },
    ],
  };
}

async function createPublishedProject(client: TestClient, name: string): Promise<{ slug: string }> {
  const proj = await client.json<{ id: string; slug: string }>(
    await client.post('/api/projects', { name }),
  );
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
  return { slug: proj.slug };
}

describe('JSON API (feeds.*/<slug>/api/v1)', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('GET /<slug>/api/v1 returns a discovery document with feed metadata + endpoint links', async () => {
    const { client } = await loggedInClient('api1@example.com');
    const { slug } = await createPublishedProject(client, 'ApiIndex');

    const res = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=3600');
    expect(res.headers.get('ETag')).toBeTruthy();

    const body = await res.json() as {
      feed: { slug: string; agency_name: string; counts: { routes: number; stops: number } };
      endpoints: Record<string, string>;
    };
    expect(body.feed.slug).toBe(slug);
    expect(body.feed.agency_name).toBe('API Agency');
    expect(body.feed.counts.routes).toBe(2);
    expect(body.feed.counts.stops).toBe(3);
    expect(body.endpoints.routes).toContain('/api/v1/routes');
    expect(body.endpoints.stop_schedule).toContain('/stops/{stop_id}/schedule');
  });

  it('GET /<slug>/api/v1/agencies returns the agencies', async () => {
    const { client } = await loggedInClient('api2@example.com');
    const { slug } = await createPublishedProject(client, 'ApiAgencies');
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/agencies`);
    expect(res.status).toBe(200);
    const body = await res.json() as { agencies: { agency_id: string; agency_name: string; agency_timezone: string }[] };
    expect(body.agencies).toHaveLength(1);
    expect(body.agencies[0].agency_name).toBe('API Agency');
    expect(body.agencies[0].agency_timezone).toBe('America/Denver');
  });

  it('GET /<slug>/api/v1/routes returns route summaries with trip counts', async () => {
    const { client } = await loggedInClient('api3@example.com');
    const { slug } = await createPublishedProject(client, 'ApiRoutes');
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/routes`);
    expect(res.status).toBe(200);
    const body = await res.json() as { routes: { route_id: string; route_long_name: string; trip_count: number }[] };
    expect(body.routes).toHaveLength(2);
    const r1 = body.routes.find((r) => r.route_id === 'R1');
    expect(r1?.route_long_name).toBe('Downtown');
    expect(r1?.trip_count).toBe(3); // t1, t2, t3
    const r2 = body.routes.find((r) => r.route_id === 'R2');
    expect(r2?.trip_count).toBe(1); // t4
  });

  it("GET /<slug>/api/v1/routes/<id> returns the route, its trips, and served stops", async () => {
    const { client } = await loggedInClient('api4@example.com');
    const { slug } = await createPublishedProject(client, 'ApiRoute');
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/routes/R1`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      route: { route_id: string; route_short_name: string };
      trips: { trip_id: string; direction_id: number }[];
      stops: { stop_id: string; stop_name: string }[];
    };
    expect(body.route.route_id).toBe('R1');
    expect(body.trips.map((t) => t.trip_id).sort()).toEqual(['t1', 't2', 't3']);
    // Served stops, in line order taken from the longest trip (t1: s1,s2,s3).
    expect(body.stops.map((s) => s.stop_id)).toEqual(['s1', 's2', 's3']);
    expect(body.stops[0].stop_name).toBe('Main & 1st');
  });

  it('GET /<slug>/api/v1/routes/<unknown> returns 404 JSON', async () => {
    const { client } = await loggedInClient('api5@example.com');
    const { slug } = await createPublishedProject(client, 'ApiRouteMiss');
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/routes/no-such`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('GET /<slug>/api/v1/stops returns stop summaries', async () => {
    const { client } = await loggedInClient('api6@example.com');
    const { slug } = await createPublishedProject(client, 'ApiStops');
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/stops`);
    expect(res.status).toBe(200);
    const body = await res.json() as { stops: { stop_id: string; stop_code: string | null; wheelchair_boarding: number }[] };
    expect(body.stops).toHaveLength(3);
    const s1 = body.stops.find((s) => s.stop_id === 's1');
    expect(s1?.stop_code).toBe('A1');
    expect(s1?.wheelchair_boarding).toBe(1);
    const s2 = body.stops.find((s) => s.stop_id === 's2');
    expect(s2?.stop_code).toBeNull();
  });

  it('GET /<slug>/api/v1/stops/<id> returns the stop and routes serving it', async () => {
    const { client } = await loggedInClient('api7@example.com');
    const { slug } = await createPublishedProject(client, 'ApiStop');
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/stops/s1`);
    expect(res.status).toBe(200);
    const body = await res.json() as { stop: { stop_id: string }; routes: { route_id: string }[] };
    expect(body.stop.stop_id).toBe('s1');
    // s1 is served by R1 (t1/t2/t3) and R2 (t4).
    expect(body.routes.map((r) => r.route_id).sort()).toEqual(['R1', 'R2']);
  });

  it('GET /<slug>/api/v1/stops/<id>/schedule returns departures grouped by service', async () => {
    const { client } = await loggedInClient('api8@example.com');
    const { slug } = await createPublishedProject(client, 'ApiSchedule');
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/stops/s1/schedule`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      stop: { stop_id: string };
      services: { service_id: string; departures: { departure_time: string; route_id: string; trip_id: string }[] }[];
    };
    expect(body.stop.stop_id).toBe('s1');
    const daily = body.services.find((s) => s.service_id === 'DAILY');
    expect(daily).toBeTruthy();
    // s1 DAILY departures: t4 @07:30, t1 @08:00, t2 @09:20 — sorted by time.
    expect(daily?.departures.map((d) => d.departure_time)).toEqual(['07:30:00', '08:00:00', '09:20:00']);
    const sat = body.services.find((s) => s.service_id === 'SAT');
    expect(sat?.departures.map((d) => d.trip_id)).toEqual(['t3']);
  });

  it('supports conditional requests via ETag (304)', async () => {
    const { client } = await loggedInClient('api9@example.com');
    const { slug } = await createPublishedProject(client, 'ApiEtag');
    const first = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/routes`);
    expect(first.status).toBe(200);
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();
    const second = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/routes`, {
      headers: { 'If-None-Match': etag as string },
    });
    expect(second.status).toBe(304);
  });

  it('OPTIONS preflight returns 204 with CORS headers', async () => {
    const { client } = await loggedInClient('api10@example.com');
    const { slug } = await createPublishedProject(client, 'ApiPreflight');
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/routes`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });

  it('returns 404 for an unpublished / unknown slug', async () => {
    const res = await SELF.fetch('http://feeds.example.com/no-such-slug/api/v1/routes');
    expect(res.status).toBe(404);
  });

  // ─── /services — the service-profile catalogue ──────────────────────────────
  //
  // This is what makes a `?service=` pin discoverable. Before it existed the id
  // was surfaced nowhere: an integrator had to open the live embed, click a
  // service-day tab, and copy the value out of the address bar.

  it('GET /<slug>/api/v1/services enumerates the feed’s service profiles', async () => {
    const { client } = await loggedInClient('api-svc1@example.com');
    const { slug } = await createPublishedProject(client, 'ApiServices');
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/services`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');

    const body = await res.json() as {
      services: { id: string; label: string; service_ids: string[]; route_ids: string[] }[];
    };
    // Ordered Weekday → Saturday → Sunday → Daily → other.
    expect(body.services.map((s) => s.label)).toEqual(['Saturday', 'Daily']);
    for (const s of body.services) {
      expect(s.id).toMatch(/^svc-[0-9a-z]+$/);
    }
    const sat = body.services.find((s) => s.label === 'Saturday');
    expect(sat?.service_ids).toEqual(['SAT']);
    const daily = body.services.find((s) => s.label === 'Daily');
    expect(daily?.service_ids).toEqual(['DAILY']);
  });

  it('reports which routes each service profile actually runs on', async () => {
    const { client } = await loggedInClient('api-svc2@example.com');
    const { slug } = await createPublishedProject(client, 'ApiServiceRoutes');
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/services`);
    const body = await res.json() as { services: { label: string; route_ids: string[] }[] };
    // DAILY runs on R1 (t1/t2) and R2 (t4); SAT only on R1 (t3).
    expect(body.services.find((s) => s.label === 'Daily')?.route_ids).toEqual(['R1', 'R2']);
    expect(body.services.find((s) => s.label === 'Saturday')?.route_ids).toEqual(['R1']);
  });

  it('lists /services in the discovery document', async () => {
    const { client } = await loggedInClient('api-svc3@example.com');
    const { slug } = await createPublishedProject(client, 'ApiServiceDiscovery');
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1`);
    const body = await res.json() as { endpoints: Record<string, string> };
    expect(body.endpoints.services).toContain('/api/v1/services');
  });

  it('serves /services with the same cache + conditional-request profile as the rest of the API', async () => {
    const { client } = await loggedInClient('api-svc4@example.com');
    const { slug } = await createPublishedProject(client, 'ApiServiceEtag');
    const first = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/services`);
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toContain('s-maxage=3600');
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();
    const second = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/services`, {
      headers: { 'If-None-Match': etag as string },
    });
    expect(second.status).toBe(304);
  });

  it('gates /services behind the embeds entitlement like every other endpoint', async () => {
    const { client, userId } = await loggedInClient('api-svc-free@example.com');
    const { slug } = await createPublishedProject(client, 'ApiServiceFree');
    await testEnv.DB.prepare('UPDATE user SET plan = ? WHERE id = ?').bind('free', userId).run();
    const res = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/services`);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('plan_required');
  });

  it('returns 403 when the feed owner lacks the embeds entitlement', async () => {
    // Publish as a paid user (publishing itself is Agency+), then downgrade the
    // owner to free in the DB. The JSON API resolves the owner plan live at
    // serve time, so the now-free owner's data is gated off.
    const { client, userId } = await loggedInClient('api-free@example.com');
    const { slug } = await createPublishedProject(client, 'ApiFree');
    await testEnv.DB.prepare('UPDATE user SET plan = ? WHERE id = ?').bind('free', userId).run();

    const res = await SELF.fetch(`http://feeds.example.com/${slug}/api/v1/routes`);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('plan_required');
  });
});
