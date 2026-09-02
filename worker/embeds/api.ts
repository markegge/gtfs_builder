// ─── Read-only JSON API ──────────────────────────────────────────────────────
//
// Served under  feeds.*/<slug>/api/v1/...  — a clean, RESTful, read-only view
// of a published feed's canonical snapshot, for integrators who want the data
// without parsing the GTFS .zip themselves.
//
// Like the HTML embeds, this reads ONLY from the canonical published snapshot
// (loadEmbedFeed), is read-only, edge-cached, version-id (snapshot) ETagged,
// and CORS-open (`Access-Control-Allow-Origin: *`) so any browser/tool can call
// it cross-origin. It is gated behind the same `embeds` Planner+ entitlement: an
// owner whose plan lacks `embeds` serves 403 here (the JSON API is a paid
// integrator surface), mirroring the EmbedPanel paywall.
//
// Endpoints (all GET/HEAD, JSON):
//   /<slug>/api/v1                          discovery: feed metadata + endpoint links
//   /<slug>/api/v1/agencies                 all agencies
//   /<slug>/api/v1/routes                   all routes (summary: id, names, type, color, #trips)
//   /<slug>/api/v1/routes/<route_id>        one route + its trips and the stops it serves
//   /<slug>/api/v1/stops                    all stops (id, code, name, lat/lon, accessibility)
//   /<slug>/api/v1/stops/<stop_id>          one stop + the routes that serve it
//   /<slug>/api/v1/stops/<stop_id>/schedule that stop's scheduled departures, grouped by service
//   /<slug>/api/v1/services                 the feed's service profiles + their `?service=` ids
//
// No write surface, no auth tokens — published feeds are public data.

import type { Env } from '../env';
import { loadEmbedFeed } from './loader';
import { planHasFeature } from '../billing/plans';
import { buildServiceProfiles } from './services';
import type { LoadedEmbedFeed, Route, Stop, Trip, StopTime } from './types';

export const API_VERSION = 'v1';

// One regex per resource. `[^/?#]+` for ids so url-encoded ids round-trip.
const API_INDEX_RE = /^\/([a-z0-9][a-z0-9-]*)\/api\/v1\/?$/;
const API_AGENCIES_RE = /^\/([a-z0-9][a-z0-9-]*)\/api\/v1\/agencies\/?$/;
const API_ROUTES_RE = /^\/([a-z0-9][a-z0-9-]*)\/api\/v1\/routes\/?$/;
const API_ROUTE_RE = /^\/([a-z0-9][a-z0-9-]*)\/api\/v1\/routes\/([^/?#]+)\/?$/;
const API_STOPS_RE = /^\/([a-z0-9][a-z0-9-]*)\/api\/v1\/stops\/?$/;
const API_STOP_RE = /^\/([a-z0-9][a-z0-9-]*)\/api\/v1\/stops\/([^/?#]+)\/?$/;
const API_STOP_SCHEDULE_RE = /^\/([a-z0-9][a-z0-9-]*)\/api\/v1\/stops\/([^/?#]+)\/schedule\/?$/;
const API_SERVICES_RE = /^\/([a-z0-9][a-z0-9-]*)\/api\/v1\/services\/?$/;

/** True for any path this module handles, so feedsHandler can route to it. */
export function isApiPath(pathname: string): boolean {
  return /^\/[a-z0-9][a-z0-9-]*\/api\/v1(\/|$)/.test(pathname);
}

/**
 * Dispatch a feeds origin `<slug>/api/v1/...` request. Returns a JSON Response
 * (or 304 / 404 / 403). Assumes the caller already confirmed the method is
 * GET or HEAD.
 */
export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  let m: RegExpMatchArray | null;

  if ((m = path.match(API_INDEX_RE))) return serve(request, env, m[1], (f) => apiIndex(f, env));
  if ((m = path.match(API_AGENCIES_RE))) return serve(request, env, m[1], apiAgencies);
  if ((m = path.match(API_ROUTES_RE))) return serve(request, env, m[1], apiRoutes);
  if ((m = path.match(API_ROUTE_RE))) {
    const routeId = decodeURIComponent(m[2]);
    return serve(request, env, m[1], (f) => apiRoute(f, routeId), `route-${m![2]}`);
  }
  if ((m = path.match(API_SERVICES_RE))) return serve(request, env, m[1], apiServices, 'services');
  if ((m = path.match(API_STOPS_RE))) return serve(request, env, m[1], apiStops);
  if ((m = path.match(API_STOP_SCHEDULE_RE))) {
    const stopId = decodeURIComponent(m[2]);
    return serve(request, env, m[1], (f) => apiStopSchedule(f, stopId), `stop-${m![2]}-schedule`);
  }
  if ((m = path.match(API_STOP_RE))) {
    const stopId = decodeURIComponent(m[2]);
    return serve(request, env, m[1], (f) => apiStop(f, stopId), `stop-${m![2]}`);
  }

  return apiError(404, 'not_found', 'No such API endpoint.');
}

// ─── Plumbing: load, gate, ETag, cache, serialise ────────────────────────────

type Builder = (feed: LoadedEmbedFeed) => unknown | null;

/**
 * Shared request flow for every endpoint: load the published snapshot, gate on
 * the owner's `embeds` entitlement, compute a snapshot-derived ETag (honoring
 * conditional requests), build the body, and serialise with the embed cache +
 * CORS conventions. `builder` returns `null` to signal a 404 (e.g. unknown
 * route/stop id).
 */
async function serve(
  request: Request,
  env: Env,
  slug: string,
  builder: Builder,
  etagSuffix?: string,
): Promise<Response> {
  const feed = await loadEmbedFeed(env, slug);
  if (!feed) return apiError(404, 'not_found', 'No feed published here.');

  // Same paywall as the HTML EmbedPanel — the JSON API is a paid integrator
  // surface. Owners without `embeds` (free tier) get a 403, not their data.
  if (!planHasFeature(feed.ownerPlan, 'embeds')) {
    return apiError(403, 'plan_required', 'The JSON API requires the Planner plan or higher.');
  }

  const etag = `"${feed.snapshotId}${etagSuffix ? `-${etagSuffix}` : '-api'}"`;
  if (etagMatches(request.headers.get('If-None-Match'), etag)) {
    return new Response(null, { status: 304, headers: jsonHeaders(etag, feed.publishedAt) });
  }

  const body = builder(feed);
  if (body === null || body === undefined) {
    return apiError(404, 'not_found', 'Resource not found in this feed.');
  }

  const headers = jsonHeaders(etag, feed.publishedAt);
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function jsonHeaders(etag: string, publishedAt: number): Headers {
  const h = new Headers();
  h.set('Content-Type', 'application/json; charset=utf-8');
  h.set('ETag', etag);
  h.set('Last-Modified', new Date(publishedAt).toUTCString());
  // Same edge-cache profile as the HTML embeds: short browser TTL, longer at the
  // edge; republish bumps the snapshot id which changes the ETag.
  h.set('Cache-Control', 'public, max-age=300, s-maxage=3600');
  // Integrator surface — readable cross-origin from any browser/tool.
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  h.set('X-Content-Type-Options', 'nosniff');
  return h;
}

function apiError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const tags = ifNoneMatch.split(',').map((s) => s.trim().replace(/^W\//, ''));
  return tags.includes(etag) || tags.includes('*');
}

// ─── Endpoint builders ───────────────────────────────────────────────────────

/** GET /<slug>/api/v1 — discovery document: feed metadata + endpoint links. */
function apiIndex(feed: LoadedEmbedFeed, env: Env) {
  const base = `${(env.FEEDS_ORIGIN || '').replace(/\/$/, '')}/${feed.slug}/api/${API_VERSION}`;
  const agency = feed.state.agencies[0];
  return {
    feed: {
      slug: feed.slug,
      name: feed.projectName,
      agency_name: agency?.agency_name ?? null,
      timezone: agency?.agency_timezone ?? null,
      snapshot_id: feed.snapshotId,
      published_at: new Date(feed.publishedAt).toISOString(),
      feed_start_date: feed.state.feedInfo?.feed_start_date ?? null,
      feed_end_date: feed.state.feedInfo?.feed_end_date ?? null,
      counts: {
        agencies: feed.state.agencies.length,
        routes: feed.state.routes.length,
        stops: feed.state.stops.length,
        trips: feed.state.trips.length,
      },
    },
    endpoints: {
      agencies: `${base}/agencies`,
      routes: `${base}/routes`,
      route: `${base}/routes/{route_id}`,
      stops: `${base}/stops`,
      stop: `${base}/stops/{stop_id}`,
      stop_schedule: `${base}/stops/{stop_id}/schedule`,
      services: `${base}/services`,
    },
  };
}

/**
 * GET /<slug>/api/v1/services — the feed's service profiles.
 *
 * A profile is the group of calendar.txt rows sharing a day pattern AND a date
 * range: what a rider sees as a "Weekday" / "Saturday" / "Weekday (Jun 1–Aug 31)"
 * tab. Its `id` is the value the embed pages accept as `?service=<id>` (and the
 * `<gtfs-route-map>` / `<gtfs-schedule>` `service=` attribute) to pin a pattern
 * instead of auto-selecting today's.
 *
 * Computed from the SAME published snapshot the embeds render, by the same
 * `buildServiceProfiles`. That matters: an id derived from anything else (live
 * editor state, a second hash implementation) would stop matching the moment
 * the two drifted, and the embed would silently fall back to today's service.
 *
 * Deliberately carries no "which profile is active today" field — the response
 * is edge-cached against a snapshot-derived ETag, so anything time-dependent
 * would be served stale. Today's profile is resolved per-request by the embed.
 *
 * `route_ids` lists the routes that actually have a trip on the profile, so a
 * caller can offer only the patterns that mean something for a given route.
 * Services referenced only via calendar_dates.txt (no calendar.txt row) form no
 * profile and so appear here on no route.
 */
function apiServices(feed: LoadedEmbedFeed) {
  const profiles = buildServiceProfiles(feed.state.calendars);

  const routesByService = new Map<string, Set<string>>();
  for (const t of feed.state.trips) {
    let set = routesByService.get(t.service_id);
    if (!set) {
      set = new Set<string>();
      routesByService.set(t.service_id, set);
    }
    set.add(t.route_id);
  }

  // Present route_ids in the same order as /routes rather than trip order.
  const routeOrder = new Map<string, number>(
    feed.state.routes.slice().sort(byRouteName).map((r, i) => [r.route_id, i]),
  );
  const rank = (id: string) => routeOrder.get(id) ?? Number.MAX_SAFE_INTEGER;

  return {
    services: profiles.map((p) => {
      const routeIds = new Set<string>();
      for (const serviceId of p.serviceIds) {
        for (const routeId of routesByService.get(serviceId) ?? []) routeIds.add(routeId);
      }
      return {
        id: p.id,
        label: p.label,
        service_ids: p.serviceIds,
        route_ids: Array.from(routeIds).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)),
      };
    }),
  };
}

/** GET /<slug>/api/v1/agencies */
function apiAgencies(feed: LoadedEmbedFeed) {
  return {
    agencies: feed.state.agencies.map((a) => ({
      agency_id: a.agency_id,
      agency_name: a.agency_name,
      agency_url: a.agency_url ?? null,
      agency_timezone: a.agency_timezone,
      agency_lang: a.agency_lang ?? null,
      agency_phone: a.agency_phone ?? null,
    })),
  };
}

/** GET /<slug>/api/v1/routes — summary list. */
function apiRoutes(feed: LoadedEmbedFeed) {
  const tripCounts = new Map<string, number>();
  for (const t of feed.state.trips) {
    tripCounts.set(t.route_id, (tripCounts.get(t.route_id) ?? 0) + 1);
  }
  const routes = feed.state.routes
    .slice()
    .sort(byRouteName)
    .map((r) => ({ ...routeSummary(r), trip_count: tripCounts.get(r.route_id) ?? 0 }));
  return { routes };
}

/** GET /<slug>/api/v1/routes/<route_id> — route + its trips and served stops. */
function apiRoute(feed: LoadedEmbedFeed, routeId: string) {
  const route = feed.state.routes.find((r) => r.route_id === routeId);
  if (!route) return null;

  const trips = feed.state.trips.filter((t) => t.route_id === routeId);
  const tripIds = new Set(trips.map((t) => t.trip_id));

  // Stops served by this route, in a representative stop_sequence order taken
  // from the trip with the most stops (so the list reads like a line itinerary).
  const stopTimesByTrip = groupStopTimes(feed.state.stopTimes, tripIds);
  let longestTripId: string | null = null;
  let longestLen = -1;
  for (const [tripId, times] of stopTimesByTrip) {
    if (times.length > longestLen) {
      longestLen = times.length;
      longestTripId = tripId;
    }
  }
  const orderedStopIds: string[] = [];
  const seenStops = new Set<string>();
  if (longestTripId) {
    for (const st of stopTimesByTrip.get(longestTripId) ?? []) {
      if (!seenStops.has(st.stop_id)) {
        seenStops.add(st.stop_id);
        orderedStopIds.push(st.stop_id);
      }
    }
  }
  // Any stop served by another trip but not the longest one — append it.
  for (const times of stopTimesByTrip.values()) {
    for (const st of times) {
      if (!seenStops.has(st.stop_id)) {
        seenStops.add(st.stop_id);
        orderedStopIds.push(st.stop_id);
      }
    }
  }
  const stopsById = new Map<string, Stop>(feed.state.stops.map((s) => [s.stop_id, s]));
  const stops = orderedStopIds
    .map((id) => stopsById.get(id))
    .filter((s): s is Stop => !!s)
    .map(stopSummary);

  return {
    route: routeSummary(route),
    trips: trips.map(tripSummary).sort((a, b) => {
      if (a.direction_id !== b.direction_id) return a.direction_id - b.direction_id;
      return a.trip_id.localeCompare(b.trip_id);
    }),
    stops,
  };
}

/** GET /<slug>/api/v1/stops — summary list. */
function apiStops(feed: LoadedEmbedFeed) {
  const stops = feed.state.stops
    .slice()
    .sort((a, b) => (a.stop_name || a.stop_id).localeCompare(b.stop_name || b.stop_id))
    .map(stopSummary);
  return { stops };
}

/** GET /<slug>/api/v1/stops/<stop_id> — stop + routes serving it. */
function apiStop(feed: LoadedEmbedFeed, stopId: string) {
  const stop = feed.state.stops.find((s) => s.stop_id === stopId);
  if (!stop) return null;

  const routeById = new Map<string, Route>(feed.state.routes.map((r) => [r.route_id, r]));
  const tripById = new Map<string, Trip>(feed.state.trips.map((t) => [t.trip_id, t]));
  const routeIds = new Set<string>();
  for (const st of feed.state.stopTimes) {
    if (st.stop_id !== stopId) continue;
    const trip = tripById.get(st.trip_id);
    if (trip) routeIds.add(trip.route_id);
  }
  const routes = Array.from(routeIds)
    .map((id) => routeById.get(id))
    .filter((r): r is Route => !!r)
    .sort(byRouteName)
    .map(routeSummary);

  return { stop: stopSummary(stop), routes };
}

/** GET /<slug>/api/v1/stops/<stop_id>/schedule — departures grouped by service. */
function apiStopSchedule(feed: LoadedEmbedFeed, stopId: string) {
  const stop = feed.state.stops.find((s) => s.stop_id === stopId);
  if (!stop) return null;

  const routeById = new Map<string, Route>(feed.state.routes.map((r) => [r.route_id, r]));
  const tripById = new Map<string, Trip>(feed.state.trips.map((t) => [t.trip_id, t]));

  // service_id → list of departures at this stop.
  type Dep = {
    service_id: string;
    arrival_time: string;
    departure_time: string;
    route_id: string;
    route_short_name: string;
    trip_id: string;
    trip_headsign: string | null;
    stop_sequence: number;
  };
  const deps: Dep[] = [];
  for (const st of feed.state.stopTimes) {
    if (st.stop_id !== stopId) continue;
    const trip = tripById.get(st.trip_id);
    if (!trip) continue;
    const route = routeById.get(trip.route_id);
    deps.push({
      service_id: trip.service_id,
      arrival_time: st.arrival_time,
      departure_time: st.departure_time,
      route_id: trip.route_id,
      route_short_name: route?.route_short_name ?? '',
      trip_id: trip.trip_id,
      trip_headsign: trip.trip_headsign ?? null,
      stop_sequence: st.stop_sequence,
    });
  }

  const byService = new Map<string, Dep[]>();
  for (const d of deps) {
    let arr = byService.get(d.service_id);
    if (!arr) {
      arr = [];
      byService.set(d.service_id, arr);
    }
    arr.push(d);
  }
  const services = Array.from(byService.entries())
    .map(([serviceId, list]) => ({
      service_id: serviceId,
      departures: list
        .slice()
        .sort((a, b) => gtfsTimeToSeconds(a.departure_time) - gtfsTimeToSeconds(b.departure_time))
        .map((d) => ({
          arrival_time: d.arrival_time,
          departure_time: d.departure_time,
          route_id: d.route_id,
          route_short_name: d.route_short_name,
          trip_id: d.trip_id,
          trip_headsign: d.trip_headsign,
          stop_sequence: d.stop_sequence,
        })),
    }))
    .sort((a, b) => a.service_id.localeCompare(b.service_id));

  return {
    stop: stopSummary(stop),
    services,
  };
}

// ─── Shaping helpers ─────────────────────────────────────────────────────────

function routeSummary(r: Route) {
  return {
    route_id: r.route_id,
    agency_id: r.agency_id ?? null,
    route_short_name: r.route_short_name ?? '',
    route_long_name: r.route_long_name ?? '',
    route_desc: r.route_desc ?? null,
    route_type: r.route_type,
    route_color: r.route_color ?? null,
    route_text_color: r.route_text_color ?? null,
  };
}

function stopSummary(s: Stop) {
  return {
    stop_id: s.stop_id,
    stop_code: s.stop_code ?? null,
    stop_name: s.stop_name,
    stop_lat: s.stop_lat,
    stop_lon: s.stop_lon,
    location_type: s.location_type ?? 0,
    wheelchair_boarding: s.wheelchair_boarding ?? 0,
  };
}

function tripSummary(t: Trip) {
  return {
    trip_id: t.trip_id,
    service_id: t.service_id,
    direction_id: (t.direction_id ?? 0) as 0 | 1,
    trip_headsign: t.trip_headsign ?? null,
    shape_id: t.shape_id ?? null,
  };
}

function byRouteName(a: Route, b: Route): number {
  const an = a.route_short_name || a.route_id;
  const bn = b.route_short_name || b.route_id;
  return an.localeCompare(bn, undefined, { numeric: true });
}

function groupStopTimes(stopTimes: StopTime[], tripIds: Set<string>): Map<string, StopTime[]> {
  const byTrip = new Map<string, StopTime[]>();
  for (const st of stopTimes) {
    if (!tripIds.has(st.trip_id)) continue;
    let arr = byTrip.get(st.trip_id);
    if (!arr) {
      arr = [];
      byTrip.set(st.trip_id, arr);
    }
    arr.push(st);
  }
  for (const arr of byTrip.values()) arr.sort((a, b) => a.stop_sequence - b.stop_sequence);
  return byTrip;
}

function gtfsTimeToSeconds(t: string): number {
  const m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec((t || '').trim());
  if (!m) return Number.MAX_SAFE_INTEGER;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0);
}
