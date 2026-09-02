// Tests for the service-profile client (src/services/embedServicesApi.ts).
//
// The snake_case → camelCase mapping is the whole risk surface here: a typo in
// `route_ids` yields `routeIds: []`, which silently stops the snippet panel
// from applying a pin to any route. Nothing else would catch that.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchEmbedServiceProfiles } from '../embedServicesApi';

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchEmbedServiceProfiles', () => {
  it('requests /<slug>/api/v1/services on the feeds origin', async () => {
    const spy = stubFetch(200, { services: [] });
    await fetchEmbedServiceProfiles('https://feeds.gtfsx.com', 'my-agency');
    expect(spy).toHaveBeenCalledWith(
      'https://feeds.gtfsx.com/my-agency/api/v1/services',
      expect.anything(),
    );
  });

  it('tolerates a trailing slash on the origin and encodes the slug', async () => {
    const spy = stubFetch(200, { services: [] });
    await fetchEmbedServiceProfiles('https://feeds.gtfsx.com/', 'a b');
    expect(spy).toHaveBeenCalledWith(
      'https://feeds.gtfsx.com/a%20b/api/v1/services',
      expect.anything(),
    );
  });

  it('maps the wire shape onto the shared ServiceProfile fields', async () => {
    stubFetch(200, {
      services: [
        { id: 'svc-1rbulw', label: 'Weekday', service_ids: ['WKDY'], route_ids: ['R1', 'R2'] },
        { id: 'svc-1rnwq6', label: 'Saturday', service_ids: ['SAT'], route_ids: ['R1'] },
      ],
    });
    const profiles = await fetchEmbedServiceProfiles('https://feeds.gtfsx.com', 'my-agency');
    expect(profiles).toEqual([
      { id: 'svc-1rbulw', label: 'Weekday', serviceIds: ['WKDY'], routeIds: ['R1', 'R2'] },
      { id: 'svc-1rnwq6', label: 'Saturday', serviceIds: ['SAT'], routeIds: ['R1'] },
    ]);
  });

  it('preserves the server’s profile order', async () => {
    stubFetch(200, {
      services: [
        { id: 'b', label: 'Saturday', service_ids: [], route_ids: [] },
        { id: 'a', label: 'Daily', service_ids: [], route_ids: [] },
      ],
    });
    const profiles = await fetchEmbedServiceProfiles('https://feeds.gtfsx.com', 's');
    expect(profiles.map((p) => p.label)).toEqual(['Saturday', 'Daily']);
  });

  it('defaults missing id arrays to [] rather than undefined', async () => {
    stubFetch(200, { services: [{ id: 'svc-x', label: 'Weekday' }] });
    const profiles = await fetchEmbedServiceProfiles('https://feeds.gtfsx.com', 's');
    expect(profiles[0].serviceIds).toEqual([]);
    expect(profiles[0].routeIds).toEqual([]);
  });

  it('drops malformed entries instead of emitting a profile with no id', async () => {
    stubFetch(200, {
      services: [
        { label: 'No id here', service_ids: [], route_ids: [] },
        { id: 'svc-ok', label: 'Weekday', service_ids: [], route_ids: [] },
      ],
    });
    const profiles = await fetchEmbedServiceProfiles('https://feeds.gtfsx.com', 's');
    expect(profiles.map((p) => p.id)).toEqual(['svc-ok']);
  });

  it('returns [] when the feed publishes no services block', async () => {
    stubFetch(200, {});
    expect(await fetchEmbedServiceProfiles('https://feeds.gtfsx.com', 's')).toEqual([]);
  });

  it('throws on 403 (owner lacks the embeds entitlement) rather than reporting no patterns', async () => {
    stubFetch(403, { error: 'plan_required' });
    await expect(fetchEmbedServiceProfiles('https://feeds.gtfsx.com', 's')).rejects.toThrow('403');
  });

  it('throws on 404 (nothing published at this slug yet)', async () => {
    stubFetch(404, { error: 'not_found' });
    await expect(fetchEmbedServiceProfiles('https://feeds.gtfsx.com', 's')).rejects.toThrow('404');
  });
});
