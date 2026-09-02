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
