// Cookieless analytics beacon. Sends one POST per route change with the
// current pathname, a per-tab session id (sessionStorage), and the inbound
// `?ref=` referral tag captured once at session start.
//
// Failures are silent — analytics is best-effort and must never disrupt the
// user. `fetch(..., { keepalive: true })` lets the request complete even if
// the page is unloading, while still allowing us to set the X-GB-Client
// header that our CSRF middleware requires.

const SESSION_KEY = 'gb_track_session';
const REF_KEY = 'gb_track_ref';
const GCLID_KEY = 'gb_track_gclid';
const GBRAID_KEY = 'gb_track_gbraid';
const WBRAID_KEY = 'gb_track_wbraid';

function randomId(): string {
  // 16 bytes of entropy as hex — plenty for a session id.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function getSessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = randomId();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return randomId();
  }
}

function getRef(): string | null {
  try {
    return sessionStorage.getItem(REF_KEY);
  } catch {
    return null;
  }
}

function getStored(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

// On first call of the session, look for `?ref=...` in the current URL,
// persist it for the rest of the session, and strip it from the address bar
// so it doesn't leak into shared links.
export function captureRefFromUrl(): void {
  try {
    if (sessionStorage.getItem(REF_KEY) !== null) return;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('ref');
    if (!raw) return;
    const trimmed = raw.trim().slice(0, 128);
    if (!trimmed) return;
    sessionStorage.setItem(REF_KEY, trimmed);
    params.delete('ref');
    const qs = params.toString();
    const newUrl =
      window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
    window.history.replaceState(null, '', newUrl);
  } catch {
    // sessionStorage blocked or URL manipulation failed — ignore.
  }
}

// Capture one `?<param>=` click identifier into sessionStorage and strip it
// from the address bar. First-touch wins per identifier: if it's already
// stored, leave it — a user who arrived via an ad, browsed, and returned
// organically should still be credited to the original ad click. Returns true
// if it stripped a param (so the caller can push a single replaceState).
function captureParam(param: string, storageKey: string, params: URLSearchParams): boolean {
  if (sessionStorage.getItem(storageKey) !== null) return false;
  const raw = params.get(param);
  if (!raw) return false;
  const trimmed = raw.trim().slice(0, 256);
  if (!trimmed) return false;
  sessionStorage.setItem(storageKey, trimmed);
  params.delete(param);
  return true;
}

// Capture Google Ads' click identifiers — gclid, and the privacy-safe gbraid
// (iOS app→web) / wbraid (web→web under consent limits). Capturing only gclid
// dropped every iOS/consent-limited click (migration 0030); the Data Manager
// uploader accepts whichever one a session carries. Name kept (called from
// src/App.tsx) though it now covers all three.
export function captureGclidFromUrl(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    const stripped =
      [
        captureParam('gclid', GCLID_KEY, params),
        captureParam('gbraid', GBRAID_KEY, params),
        captureParam('wbraid', WBRAID_KEY, params),
      ].some(Boolean);
    if (!stripped) return;
    const qs = params.toString();
    const newUrl =
      window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
    window.history.replaceState(null, '', newUrl);
  } catch {
    // sessionStorage blocked or URL manipulation failed — ignore.
  }
}

// The Google Ads click identifiers captured for this session (gclid/gbraid/
// wbraid), first-touch, from sessionStorage. Forwarded by conversion forms —
// e.g. the signup form stamps them onto its POST so the server can emit a
// click-ID-attributed `sign_up` event (mirrors the demo-lead carry-through).
// Returns nulls when nothing was captured or storage is blocked.
export function getStoredClickIds(): {
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
} {
  return {
    gclid: getStored(GCLID_KEY),
    gbraid: getStored(GBRAID_KEY),
    wbraid: getStored(WBRAID_KEY),
  };
}

// Keep in sync with the zod enum in worker/events/routes.ts. demo_request is
// recorded server-side by the /book-demo lead-form SUBMIT (POST
// /api/demo-leads, worker/marketing/demoLead.ts) — it is listed for type parity
// only and has no client beacon call site. (Until 2026-07-13 it was written by
// GET /book-demo, i.e. on the redirect click, which is why prod holds a burst
// of crawler-generated rows from 2026-07-12/13.)
//
// ── Conversion kinds vs funnel kinds ───────────────────────────────────────
// The FIRST SIX kinds below are frozen: `feed_exported`, `paywall_view`,
// `demo_request` and `sign_up` (server-side) are Google Ads conversion kinds
// (worker/marketing/ads/oci.ts ALL_UPLOAD_KINDS) and `page_view` /
// `editor_loaded` / `cta_click` back the /admin/events dashboard. Don't change
// when they fire or what they mean.
//
// The kinds after them are the FIRST-RUN FUNNEL set (added 2026-08-08). They
// are purely additive telemetry for "what happens between opening the editor
// and hitting a paywall or exporting". They are deliberately NOT conversion
// kinds: the uploader only ever selects `kind IN (ALL_UPLOAD_KINDS)`, and
// events/routes.ts only stamps a hashed email on CONVERSION_KINDS, so nothing
// here can leak into the Ads upload path.
type TrackKind =
  | 'page_view'
  | 'editor_loaded'
  | 'feed_exported'
  | 'paywall_view'
  | 'cta_click'
  | 'demo_request'
  | 'feed_opened'
  | 'feed_import_failed'
  | 'feed_edited'
  | 'export_attempt'
  | 'export_failed'
  | 'gate_blocked';

/** Where a feed in the editor came from. Shared vocabulary between
 *  `feed_opened` (it worked) and `feed_import_failed` (it didn't). */
export type FeedOrigin =
  | 'upload'        // .zip dropped or browsed in the Import dialog
  | 'url'           // pasted GTFS URL ("From URL" tab)
  | 'catalog'       // Mobility Database pick ("Search Catalog" tab)
  | 'myfeeds'       // one of the signed-in user's own feeds
  | 'deeplink'      // /import?url=… landing page
  | 'demo'          // /demo — the published svt-demo feed
  | 'merge'         // routes merged into an already-open feed (feed_opened only)
  | 'saved_project'; // /feeds/<slug> — an existing cloud project (feed_opened only)

/** How far an import got before it stopped producing a feed. */
export type ImportFailureStage =
  | 'fetch'           // couldn't retrieve the bytes (network, 4xx/5xx, proxy)
  | 'parse'           // got bytes, but they weren't a usable GTFS zip
  | 'empty'           // parsed fine, but there was nothing to import
  // The feed's stored data is GONE — the server has a working-state key on
  // file but its R2 blob is missing. Split out of `empty` deliberately: the two
  // were indistinguishable, so genuine data loss would have been filed under
  // "user picked one of their own empty feeds" and never investigated. This
  // label should have a count of zero forever; if it doesn't, something is
  // eating blobs and the worker logs an error on the same branch.
  | 'missing'
  | 'declined_large'; // user backed out at the large-feed confirmation gate

/** State of the feed at the moment the Export dialog opened. */
export type ExportAttemptState =
  | 'ready'               // export button is live
  | 'blocked_validation'; // validation errors block the GTFS export

/** Which export threw. */
export type ExportFormat = 'gtfs_zip' | 'geojson';

/** A non-paywall wall that stopped the user. Plan paywalls are NOT here — they
 *  already record their feature key as `paywall_view`'s label. */
export type BlockedGate =
  | 'save_signin'       // anonymous clicked Save → bounced to /login
  | 'feeds_signin'      // anonymous opened /feeds/<slug> → bounced to /login
  | 'assistant_signin'  // anonymous asked Ask GTFS·X → 401
  | 'assistant_quota';  // daily Ask GTFS·X message limit reached

function send(kind: TrackKind, opts?: { path?: string; label?: string | null }): void {
  try {
    const path =
      opts?.path ?? (typeof window !== 'undefined' ? window.location.pathname : '/');
    void fetch('/api/events/track', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GB-Client': 'web',
      },
      // ⚠️ DELIBERATE, AND DECIDED — do not "fix" this by attaching credentials.
      //
      // Omitting the session cookie is what keeps the beacon cookieless in
      // substance rather than only in name: /api/events/track never sees who
      // you are, so `c.var.user` is always undefined server-side and no event
      // row can be correlated with an account. public/privacy-policy §3.5
      // promises exactly that.
      //
      // What it costs, stated plainly: `paywall_view` and `feed_exported`
      // therefore resolve NO email, so those conversions upload to Google Ads
      // on their click id alone and never carry a hashed-email user identifier
      // (worker/marketing/ads/userIdentifiers.ts). The server-side branch that
      // would stamp one exists and is tested, but is unreachable from a real
      // browser. It also means such a row WITHOUT a click id has no identifier
      // at all, which is why those two kinds are permanently excluded from
      // EMAIL_ONLY_ELIGIBLE_KINDS in worker/marketing/ads/oci.ts.
      //
      // Reviewed 2026-08-08 and left as-is: correlating every page view with an
      // account is a bad trade against the cookieless design, and the upside is
      // near zero at current paid conversion volume (12 paid paywall views in
      // 30 days). Changing this is an owner decision with a privacy-policy
      // change attached, not a match-rate optimization.
      credentials: 'omit',
      keepalive: true,
      body: JSON.stringify({
        kind,
        path,
        ref: getRef(),
        sessionId: getSessionId(),
        label: opts?.label ?? null,
        gclid: getStored(GCLID_KEY),
        gbraid: getStored(GBRAID_KEY),
        wbraid: getStored(WBRAID_KEY),
      }),
    }).catch(() => {
      // Network errors are expected (e.g. offline, ad blocker) — silent.
    });
  } catch {
    // Defensive: never let a tracking error surface to the user.
  }
}

export function trackPageview(path: string): void {
  send('page_view', { path });
}

// Fires once when the editor shell mounts — lets us count "editor sessions"
// (distinct session_ids with this event) separately from marketing-page visits.
export function trackEditorLoaded(): void {
  send('editor_loaded');
}

// Fires after a valid GTFS zip is downloaded — the "value delivered" proxy.
export function trackFeedExported(): void {
  send('feed_exported');
}

// Fires when a Pro/Agency paywall is shown; `feature` is the gated feature key.
export function trackPaywallView(feature: string): void {
  send('paywall_view', { label: feature });
}

// Fires when a marketing CTA is clicked; `name` identifies the specific CTA
// (e.g. 'pricing_fix_my_feed_click'). Lets us measure intent on inquiry flows.
export function trackCtaClick(name: string): void {
  send('cta_click', { label: name });
}

// ─── First-run funnel (2026-08-08) ─────────────────────────────────────────
//
// Everything below answers "where does a first-run editor session stop?".
// `editor_loaded` told us a session opened the editor and `paywall_view` /
// `feed_exported` told us it reached a wall or an export; the stretch between
// them was blank. Same privacy contract as the rest of this module: no
// credentials, no user id, no feed contents, no file names, no URLs, no free
// text — every label is drawn from the fixed enums above.

const EDITED_ONCE_KEY = 'gb_track_edited';

// Fallback for the once-per-session guards when sessionStorage is unavailable
// (private mode, storage blocked, non-browser test runners).
const memoryOnce = new Set<string>();

/** True the FIRST time it's called with `key` in this tab session, false
 *  after. sessionStorage-backed so a page reload — which keeps the beacon's
 *  session id — doesn't re-fire the event and double-count the session. */
function firstTimeThisSession(key: string): boolean {
  try {
    if (sessionStorage.getItem(key) !== null) return false;
    sessionStorage.setItem(key, '1');
    return true;
  } catch {
    if (memoryOnce.has(key)) return false;
    memoryOnce.add(key);
    return true;
  }
}

// Fires when a feed actually lands in the editor store — the "did they get
// something in front of them at all" signal. An editor session with
// `editor_loaded` but no `feed_opened` and no `feed_edited` landed and left.
export function trackFeedOpened(origin: FeedOrigin): void {
  send('feed_opened', { label: origin });
}

// Fires when an import attempt did NOT produce a feed. The label is
// `<origin>:<stage>` (e.g. `url:fetch`, `upload:parse`) so a query can group by
// either half: `WHERE label LIKE 'url:%'` or `WHERE label LIKE '%:parse'`.
// `declined_large` is a user choice, not an error — it's here because the
// funnel question is "did an import produce a feed", and it didn't.
export function trackFeedImportFailed(origin: FeedOrigin, stage: ImportFailureStage): void {
  send('feed_import_failed', { label: `${origin}:${stage}` });
}

// Fires ONCE per tab session, on the first undoable feed-data mutation
// (src/store/history.ts recordChange — the single choke point every edit goes
// through). `entity` is the top-level store key the edit touched, e.g. 'stops'.
// Deliberately once-only: this answers "did they edit or just look", and
// per-keystroke telemetry is explicitly not wanted.
export function trackFirstFeedEdit(entity: string): void {
  if (!firstTimeThisSession(EDITED_ONCE_KEY)) return;
  send('feed_edited', { label: entity });
}

// Fires when the Export dialog opens, with the feed's export-readiness at that
// moment. Paired with `feed_exported` (success) and `export_failed`, this turns
// "N exports happened" into "N tried, M were blocked by validation, K threw".
export function trackExportAttempt(state: ExportAttemptState): void {
  send('export_attempt', { label: state });
}

// Fires when an export threw. Until now an export that blew up was
// indistinguishable from one the user never attempted.
export function trackExportFailed(format: ExportFormat): void {
  send('export_failed', { label: format });
}

// Fires when a NON-paywall gate stopped the user. Plan paywalls keep using
// `paywall_view`, whose label already carries the feature key that triggered
// it — this covers the walls that fire no paywall at all, chiefly the
// sign-in wall an anonymous first-run user hits when they try to save.
export function trackGateBlocked(gate: BlockedGate): void {
  send('gate_blocked', { label: gate });
}
