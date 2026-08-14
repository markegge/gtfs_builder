// Unit tests for the importer's "My feeds" source service (v2):
//   - listing the user's feeds for a workspace scope (org-scoped), now
//     including UNPUBLISHED feeds — every feed is importable;
//   - reshaping a project's working-state snapshot into the transient
//     ImportData the picker consumes (workingStateToImportData); and
//   - resolving a feed (published or draft) via its working state without
//     touching the editor store (no clobbering the open project).
//
// fetch is fully stubbed, so the org-scoping assertion verifies the client
// forwards the workspace scope to the server (server-side scoping is covered by
// the worker tests).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listMyFeeds,
  resolveMyFeedImportData,
  toMyFeedItem,
  workingStateToImportData,
} from '../myFeedsImport';
import type { ProjectSummary } from '../projectsApi';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A 200 working-state response: raw JSON text body + the version header the
 * client reads (mirrors GET /api/projects/:id/working-state). */
function workingStateResponse(snapshot: unknown, version = 3): Response {
  return new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: { 'content-type': 'application/json', 'X-Working-State-Version': String(version) },
  });
}

function project(partial: Partial<ProjectSummary>): ProjectSummary {
  return {
    id: 'p1',
    slug: 'feed-1',
    name: 'Feed 1',
    description: null,
    ownerType: 'user',
    ownerId: 'u1',
    workingStateVersion: 1,
    workingStateSize: null,
    workingStateUpdatedAt: 1000,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 2,
    locked: false,
    ...partial,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toMyFeedItem', () => {
  it('labels a published feed as published', () => {
    const item = toMyFeedItem(project({ slug: 'pub', published: true }));
    expect(item.published).toBe(true);
  });

  it('labels an unpublished feed as draft but still produces an item', () => {
    const item = toMyFeedItem(project({ slug: 'draft', published: false }));
    expect(item.published).toBe(false);
    expect(item.id).toBe('p1');
    expect(item.slug).toBe('draft');
  });

  it('prefers the working-state timestamp for updatedAt', () => {
    const item = toMyFeedItem(project({ workingStateUpdatedAt: 9999, updatedAt: 2 }));
    expect(item.updatedAt).toBe(9999);
  });

  // ~25% of a typical account's live feeds have nothing in them, and the server
  // sorts never-saved feeds to the TOP (a null working_state_updated_at falls
  // back to creation time). The entries most likely to be clicked first were
  // exactly the ones guaranteed to fail — hence flagging them in the list.
  describe('empty-feed flag', () => {
    it("marks a never-saved feed 'empty' — the only case that is certain", () => {
      // No blob at all, so the working-state fetch is guaranteed to 404.
      expect(toMyFeedItem(project({ workingStateSize: null })).content).toBe('empty');
    });

    it("marks the canonical 248-byte shell only 'likely-empty', never 'empty'", () => {
      // Size is a hint, not proof: gzip squashes repetitive route JSON hard
      // enough that a real 12-route feed measured 212 B — BELOW the empty
      // shell. Blocking on this heuristic would hide real feeds, so it must
      // stay advisory. (Caught by the browser check, not by reasoning.)
      expect(toMyFeedItem(project({ workingStateSize: 248 })).content).toBe('likely-empty');
      expect(toMyFeedItem(project({ workingStateSize: 123 })).content).toBe('likely-empty');
    });

    it('leaves anything plausibly non-empty alone', () => {
      expect(toMyFeedItem(project({ workingStateSize: 323 })).content).toBe('ok');
      expect(toMyFeedItem(project({ workingStateSize: 598 })).content).toBe('ok');
    });
  });
});

describe('listMyFeeds', () => {
  it('requests the org scope and lists both published AND draft feeds', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        projects: [
          project({ id: 'o1', slug: 'org-pub', name: 'Org Pub', ownerType: 'org', ownerId: 'ORG1', published: true }),
          project({ id: 'o2', slug: 'org-draft', name: 'Org Draft', ownerType: 'org', ownerId: 'ORG1', published: false }),
        ],
        quota: { projects: { used: 2, limit: 99 }, warning: null },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const feeds = await listMyFeeds('org:ORG1');

    // The workspace scope is forwarded so the server returns only this org's feeds.
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('/api/projects');
    expect(calledUrl).toContain('scope=org%3AORG1');

    // Both the published and the draft feed are listed (v2 drops the
    // published-only restriction).
    expect(feeds.map((f) => f.id)).toEqual(['o1', 'o2']);
    expect(feeds.map((f) => f.published)).toEqual([true, false]);
  });

  it('omits the scope param for personal feeds', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ projects: [], quota: { projects: { used: 0, limit: 3 }, warning: null } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await listMyFeeds('personal');

    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('/api/projects');
    expect(calledUrl).not.toContain('scope=');
  });
});

describe('workingStateToImportData', () => {
  it('maps working-state entity slices into ImportData', () => {
    const data = workingStateToImportData({
      routes: [{ route_id: 'R1', route_short_name: '1' }],
      stops: [{ stop_id: 'S1', stop_name: 'Main', stop_lat: 1, stop_lon: 2 }],
      trips: [{ trip_id: 'T1', route_id: 'R1', service_id: 'WK' }],
      stopTimes: [{ trip_id: 'T1', stop_id: 'S1', stop_sequence: 1 }],
    });
    expect(data.routes.map((r) => r.route_id)).toEqual(['R1']);
    expect(data.stops).toHaveLength(1);
    expect(data.trips).toHaveLength(1);
    expect(data.stopTimes).toHaveLength(1);
  });

  it('defaults missing keys to empty arrays and warnings to []', () => {
    const data = workingStateToImportData({ routes: [{ route_id: 'A' }] });
    expect(data.routes).toHaveLength(1);
    expect(data.stops).toEqual([]);
    expect(data.fareProducts).toEqual([]);
    expect(data.agencies).toEqual([]);
    expect(data.warnings).toEqual([]);
    expect(data.feedInfo).toBeNull();
  });

  it('treats a non-array slice value as empty (a corrupt/old blob)', () => {
    const data = workingStateToImportData({ routes: 'nope' as unknown });
    expect(data.routes).toEqual([]);
  });

  it('backfills route-stop shape_id from trips (legacy single-shape feeds)', () => {
    const data = workingStateToImportData({
      routes: [{ route_id: 'R1' }],
      trips: [{ trip_id: 'T1', route_id: 'R1', service_id: 'WK', shape_id: 'SH1', direction_id: 0 }],
      routeStops: [{ route_id: 'R1', stop_id: 'S1', direction_id: 0, sequence: 0 }],
    });
    // The legacy route stop had no shape_id; it inherits the direction's shape.
    expect(data.routeStops[0].shape_id).toBe('SH1');
  });
});

describe('resolveMyFeedImportData', () => {
  it('resolves an unpublished project via its working state', async () => {
    const snapshot = {
      routes: [{ route_id: 'R1', route_short_name: '1' }],
      stops: [{ stop_id: 'S1', stop_name: 'Main', stop_lat: 1, stop_lon: 2 }],
      trips: [{ trip_id: 'T1', route_id: 'R1', service_id: 'WK' }],
      stopTimes: [{ trip_id: 'T1', stop_id: 'S1', stop_sequence: 1 }],
    };
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      workingStateResponse(snapshot, 5),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { data, absent } = await resolveMyFeedImportData('p-draft');

    // Hits the org-scoped working-state route (server enforces access).
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('/api/projects/p-draft/working-state');
    expect(data.routes.map((r) => r.route_id)).toEqual(['R1']);
    expect(data.stops).toHaveLength(1);
    // A 200 means the blob was there — nothing to flag.
    expect(absent).toBeUndefined();
  });

  it('does NOT mutate the editor store (the open project is untouched)', async () => {
    const { useStore } = await import('../../store');
    useStore.getState().setRoutes([{ route_id: 'CURRENT' } as never]);

    const fetchMock = vi.fn(async () => workingStateResponse({ routes: [{ route_id: 'OTHER' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const { data } = await resolveMyFeedImportData('p-other');

    // We parsed the OTHER project's data into a transient structure...
    expect(data.routes.map((r) => r.route_id)).toEqual(['OTHER']);
    // ...but the currently-open project's routes are unchanged (no clobber).
    expect(useStore.getState().routes.map((r) => r.route_id)).toEqual(['CURRENT']);
  });

  // Both 404s used to collapse into `{ snapshot: null }`, so an R2 blob that had
  // gone missing was indistinguishable from a brand-new feed — same telemetry
  // label, same reassuring "no routes to import yet" message to the user.
  describe('404 disambiguation', () => {
    function notFound(body: unknown): Response {
      return new Response(JSON.stringify(body), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    /** 404 on the working state, then the getProject follow-up. */
    function stub404(reason: string, detail: Partial<ProjectSummary> = {}) {
      let call = 0;
      return vi.fn(async () => {
        call += 1;
        return call === 1
          ? notFound({ error: 'not_found', reason, snapshotCount: 2 })
          : jsonResponse(project({ workingStateVersion: 3, ...detail }));
      });
    }

    it('reports a MISSING blob distinctly from a never-saved feed', async () => {
      vi.stubGlobal('fetch', stub404('blob_missing'));
      const { data, absent } = await resolveMyFeedImportData('p-lost');
      expect(absent).toBe('blob_missing');
      expect(data.routes).toEqual([]);
    });

    it('reports a never-saved feed as never_saved', async () => {
      vi.stubGlobal('fetch', stub404('never_saved'));
      const { absent } = await resolveMyFeedImportData('p-new');
      expect(absent).toBe('never_saved');
    });
  });
});
