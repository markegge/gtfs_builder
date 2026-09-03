// First-run funnel beacons (2026-08-08). Asserts the exact payloads the six
// new helpers put on the wire, the once-per-session dedupe on `feed_edited`,
// and — most importantly — that the beacon's locked privacy properties are
// unchanged: credentials: 'omit', no user id, no free text.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  trackExportAttempt,
  trackExportFailed,
  trackFeedImportFailed,
  trackFeedOpened,
  trackFirstFeedEdit,
  trackGateBlocked,
  trackPaywallView,
} from '../trackBeacon';

interface TrackBody {
  kind: string;
  path: string;
  ref: string | null;
  sessionId: string;
  label: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
}

/** Minimal in-memory sessionStorage. trackBeacon reaches for the real one for
 *  its session id and its once-per-session guards; installing a controllable
 *  fake lets a test start a "new tab session" by clearing it. */
function fakeSessionStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    _map: map,
  };
}

let store: ReturnType<typeof fakeSessionStorage>;
let fetchMock: ReturnType<typeof vi.fn>;

const calls = (): { url: string; init: RequestInit }[] =>
  fetchMock.mock.calls.map(([url, init]) => ({ url: url as string, init: init as RequestInit }));

const bodies = (): TrackBody[] =>
  calls().map((c) => JSON.parse(c.init.body as string) as TrackBody);

beforeEach(() => {
  store = fakeSessionStorage();
  vi.stubGlobal('sessionStorage', store);
  fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('first-run funnel beacons', () => {
  it('posts feed_opened with the origin as its label', () => {
    trackFeedOpened('demo');
    expect(bodies()).toEqual([
      expect.objectContaining({ kind: 'feed_opened', label: 'demo' }),
    ]);
  });

  it('encodes a failed import as <origin>:<stage>', () => {
    trackFeedImportFailed('url', 'fetch');
    trackFeedImportFailed('upload', 'parse');
    trackFeedImportFailed('catalog', 'declined_large');
    expect(bodies().map((b) => [b.kind, b.label])).toEqual([
      ['feed_import_failed', 'url:fetch'],
      ['feed_import_failed', 'upload:parse'],
      ['feed_import_failed', 'catalog:declined_large'],
    ]);
  });

  // `empty` (the feed genuinely has no routes) and `missing` (its stored blob
  // is GONE) used to be the same label, which meant real data loss was filed
  // under "user picked one of their own empty feeds" and never looked at.
  it('separates a lost blob from a merely empty feed', () => {
    trackFeedImportFailed('myfeeds', 'empty');
    trackFeedImportFailed('myfeeds', 'missing');
    // Opening a saved feed to a blank canvas is a FAILURE, not a feed_opened.
    trackFeedImportFailed('saved_project', 'empty');
    trackFeedImportFailed('saved_project', 'missing');
    expect(bodies().map((b) => b.label)).toEqual([
      'myfeeds:empty',
      'myfeeds:missing',
      'saved_project:empty',
      'saved_project:missing',
    ]);
  });

  it('sends feed_edited at most once per tab session', () => {
    trackFirstFeedEdit('stops');
    trackFirstFeedEdit('routes');
    trackFirstFeedEdit('stopTimes');
    expect(bodies()).toEqual([
      expect.objectContaining({ kind: 'feed_edited', label: 'stops' }),
    ]);
  });

  it('sends feed_edited again in a fresh tab session', () => {
    trackFirstFeedEdit('stops');
    store.clear(); // new tab → new session id, guard reset
    trackFirstFeedEdit('shapes');
    expect(bodies().map((b) => b.label)).toEqual(['stops', 'shapes']);
  });

  it('records both halves of an export attempt', () => {
    trackExportAttempt('blocked_validation');
    trackExportFailed('gtfs_zip');
    expect(bodies().map((b) => [b.kind, b.label])).toEqual([
      ['export_attempt', 'blocked_validation'],
      ['export_failed', 'gtfs_zip'],
    ]);
  });

  it('records which non-paywall wall stopped the user', () => {
    trackGateBlocked('save_signin');
    trackGateBlocked('assistant_signin');
    expect(bodies().map((b) => b.label)).toEqual(['save_signin', 'assistant_signin']);
  });

  it('leaves paywall_view untouched — its label is still the triggering feature', () => {
    trackPaywallView('analysis_basic');
    expect(bodies()).toEqual([
      expect.objectContaining({ kind: 'paywall_view', label: 'analysis_basic' }),
    ]);
  });

  it('shares one session id across the whole funnel, so drop-off is joinable', () => {
    trackFeedOpened('upload');
    trackFirstFeedEdit('stops');
    trackExportAttempt('ready');
    trackGateBlocked('save_signin');
    const ids = new Set(bodies().map((b) => b.sessionId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it('stays cookieless: credentials omitted, no user field, no free text', () => {
    trackFeedOpened('catalog');
    trackFeedImportFailed('myfeeds', 'empty');
    trackGateBlocked('assistant_quota');

    for (const { url, init } of calls()) {
      expect(url).toBe('/api/events/track');
      // The locked design decision — see trackBeacon.ts:credentials.
      expect(init.credentials).toBe('omit');
      expect(init.keepalive).toBe(true);
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      // Exactly the beacon's established field set — nothing new, in particular
      // no user id / email / feed name / URL.
      expect(Object.keys(body).sort()).toEqual(
        ['gbraid', 'gclid', 'kind', 'label', 'path', 'ref', 'sessionId', 'wbraid'],
      );
    }
  });

  it('every funnel label is a short enum token, never user-supplied text', () => {
    trackFeedOpened('saved_project');
    trackFeedImportFailed('deeplink', 'parse');
    trackFirstFeedEdit('calendarDates');
    trackExportAttempt('ready');
    trackExportFailed('geojson');
    trackGateBlocked('feeds_signin');
    for (const b of bodies()) {
      expect(b.label).toMatch(/^[a-zA-Z_]+(:[a-z_]+)?$/);
      expect(b.label!.length).toBeLessThanOrEqual(128);
    }
  });

  it('never throws or rejects when the network is down', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('offline')));
    expect(() => trackFeedOpened('demo')).not.toThrow();
    // Give the rejected promise a tick to surface as unhandled if uncaught.
    await new Promise((r) => setTimeout(r, 0));
  });
});
