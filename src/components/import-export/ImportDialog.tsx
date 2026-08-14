import React, { useState, useCallback } from 'react';
import { parseGtfsInWorker, inspectGtfsZip, loadImportIntoStore, mergeImportIntoStore, type ImportData } from '../../services/gtfsImport';
import { useStore } from '../../store';
import type { Route } from '../../types/gtfs';
import { CatalogSearch, type CatalogFeed } from './CatalogSearch';
import { MyFeedsSource } from './MyFeedsSource';
import { resolveMyFeedImportData, type MyFeedItem } from '../../services/myFeedsImport';
import type { WorkingStateAbsence } from '../../services/projectsApi';
import { persistImportedFeed } from '../../services/importPersist';
import { feedNeedsShapes } from '../../services/shapesFromStops';
import { detectRtapFeed } from '../../services/rtapDetect';
import { parseMdbSourceId } from '../../services/mdbSourceId';
import { ShapesFromStopsDialog } from '../shapes/ShapesFromStopsDialog';
import { trackFeedImportFailed, trackFeedOpened, type FeedOrigin } from '../../services/trackBeacon';

type ImportSource = 'upload' | 'url' | 'catalog' | 'myfeeds';

type ImportMode = 'replace' | 'merge';

/** Compute a [[west, south], [east, north]] bounding box covering all stops
 * and shape points in the imported feed. Returns null if no coordinates. */
function computeImportBounds(data: ImportData): [[number, number], [number, number]] | null {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  let any = false;
  for (const s of data.stops) {
    if (Number.isFinite(s.stop_lat) && Number.isFinite(s.stop_lon)) {
      minLat = Math.min(minLat, s.stop_lat);
      maxLat = Math.max(maxLat, s.stop_lat);
      minLon = Math.min(minLon, s.stop_lon);
      maxLon = Math.max(maxLon, s.stop_lon);
      any = true;
    }
  }
  for (const sh of data.shapes) {
    for (const p of sh.points) {
      if (Number.isFinite(p.shape_pt_lat) && Number.isFinite(p.shape_pt_lon)) {
        minLat = Math.min(minLat, p.shape_pt_lat);
        maxLat = Math.max(maxLat, p.shape_pt_lat);
        minLon = Math.min(minLon, p.shape_pt_lon);
        maxLon = Math.max(maxLon, p.shape_pt_lon);
        any = true;
      }
    }
  }
  return any ? [[minLon, minLat], [maxLon, maxLat]] : null;
}

function fitMapToImport(data: ImportData) {
  const bounds = computeImportBounds(data);
  if (!bounds) return;
  // Defer so the map has at least one tick to ingest the new route/stop
  // layers before animating — otherwise fitBounds can race against the
  // initial mount and appear to do nothing.
  setTimeout(() => window.__mapFitBounds?.(bounds), 100);
}

interface ImportDialogProps {
  onClose: () => void;
  /** Overrides the success-screen primary button. When set, the button runs
   * this handler (with a "Saving…" busy state) instead of merely closing —
   * used by the org dashboard to persist the freshly imported feed as an
   * org-owned project. Defaults to the editor's "Open in Editor" → onClose. */
  onComplete?: () => void | Promise<void>;
  completeLabel?: string;
  /** Seeds which source tab the dialog opens on. Defaults to 'upload' (today's
   * behavior). Set to 'myfeeds' to open straight on the "Routes from my feeds"
   * tab — used by the Routes-panel "Import from another feed" entry point so the
   * cross-feed route import is discoverable where users build routes. */
  initialSource?: 'upload' | 'myfeeds';
}

export function ImportDialog({ onClose, onComplete, completeLabel, initialSource = 'upload' }: ImportDialogProps) {
  // Only signed-in users have feeds of their own to import from, so the
  // "My feeds" source tab is gated on an authenticated session.
  const currentUser = useStore((s) => s.currentUser);
  const [source, setSource] = useState<ImportSource>(initialSource);
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);
  // Live parse phase from the worker (e.g. "Parsing stop times…"), shown in
  // place of a static "Parsing…" so large feeds don't look frozen.
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');

  // After parsing
  const [parsedData, setParsedData] = useState<ImportData | null>(null);
  const [fileName, setFileName] = useState('');
  // The "Import from another feed" entry point (initialSource 'myfeeds') is
  // always a route import, so default straight to merge and skip the
  // replace-vs-merge choice on the options screen (below).
  const [mode, setMode] = useState<ImportMode>(initialSource === 'myfeeds' ? 'merge' : 'replace');
  const [selectedRouteIds, setSelectedRouteIds] = useState<Set<string>>(new Set());

  // Warnings from parsing
  const [importWarnings, setImportWarnings] = useState<string[]>([]);

  // Large-feed confirmation gate. Set by the pre-flight size check before the
  // (expensive, main-thread-blocking) parse so the user can back out instead
  // of hanging/crashing the tab.
  const [pendingLarge, setPendingLarge] = useState<
    { file: File; info: Awaited<ReturnType<typeof inspectGtfsZip>>; sourceUrl: string | null; mdbSourceId: number | null; origin: FeedOrigin } | null
  >(null);

  // Success state
  const [importedCounts, setImportedCounts] = useState<{
    routes: number; stops: number; trips: number;
  } | null>(null);

  // "No shapes" offer on the success screen (RTAP feeds and similar). "Not
  // now" just hides the callout for this screen — the same recipe stays
  // reachable later from the Validation panel, so nothing is lost.
  const [shapesOfferDismissed, setShapesOfferDismissed] = useState(false);
  const [showShapesDialog, setShowShapesDialog] = useState(false);
  // Where this import actually came from, when we know it: the pasted URL for
  // the "From URL" source, or the catalog feed's producer/hosted URL for
  // "Search Catalog". null for a plain ZIP upload or a "My feeds" import
  // (nothing external to point at). This is detectRtapFeed's primary signal —
  // a feed fetched from rapid.nationalrtap.org is RTAP-provenanced regardless
  // of what its bytes say; a bare upload of the exact same bytes is not
  // knowable as RTAP at all, and the copy is written to admit that honestly.
  const [importSourceUrl, setImportSourceUrl] = useState<string | null>(null);
  // Mobility Database source id when this import came from an MDB catalog pick
  // (null otherwise). Stashed like importSourceUrl — it's provenance about THIS
  // import action, not a property of the parsed feed — and applied to the store
  // only on a full REPLACE (see doReplaceImport). A merge pulls a few routes
  // into a different feed, so it must NOT claim the base feed is that MDB source
  // (issue #47). Threaded as an explicit arg into doReplaceImport as well, so
  // the auto-import-on-empty-project path doesn't read stale state.
  const [importMdbSourceId, setImportMdbSourceId] = useState<number | null>(null);
  // Which source tab produced the feed now sitting on the options screen.
  // Stashed like importSourceUrl — it's provenance about THIS import action —
  // so the deferred "Replace project" / "Import selected routes" buttons can
  // label their analytics event with the origin the feed actually came from
  // rather than whichever tab happens to be selected when they're clicked.
  const [importOrigin, setImportOrigin] = useState<FeedOrigin>('upload');

  // Async completion state (only used when onComplete is provided).
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  // Persisting a replace-import to a server-backed feed. `persistError` being
  // set means the feed is in the editor but NOT on the server — the store is
  // deliberately left dirty in that case, so the success screen has to say so
  // rather than showing an unqualified tick.
  const [persisting, setPersisting] = useState(false);
  const [persistError, setPersistError] = useState<string | null>(null);

  const handleComplete = useCallback(async () => {
    if (!onComplete) {
      onClose();
      return;
    }
    setCompleteError(null);
    setCompleting(true);
    try {
      await onComplete();
    } catch (e) {
      setCompleteError(e instanceof Error ? e.message : 'Could not save feed');
      setCompleting(false);
    }
  }, [onComplete, onClose]);

  /** Wholesale replace the current project with the imported feed. Matches
   * the first-time-import flow: clear all existing state, load the new feed,
   * rename the project, pan/zoom the map to the new routes, and surface the
   * success screen.
   *
   * On a SERVER-BACKED feed this also persists the result to the server, and
   * that is not a nicety — it is the root cause of the stranded-feed bug.
   *
   * This used to end in a bare `markSaved()` ("an import is a load, not an
   * edit"), which is true for an anonymous draft — IndexedDB autosave has it —
   * and false for a cloud feed, where `setupAutoSave` returns early and NOTHING
   * had reached the server. The editor then showed "Saved" with the Save button
   * DISABLED (TopBar gates it on `!isDirty && activeServerProjectId`) over a
   * server that still held the 248-byte empty shell, and `beforeunload` stayed
   * silent because the store was clean. The user was told their work was saved
   * and had the control they'd have used to save it taken away — which is how
   * 18 feeds ended up with their content only in a later "Save a version".
   *
   * So: persist first, and only claim clean when the PUT returns. If it doesn't
   * (conflict, network, quota, 4xx) the store stays dirty — Save re-enables,
   * the unload guard re-arms, and the success screen says so out loud. Never
   * clean without a durable write. */
  const doReplaceImport = useCallback(async (data: ImportData, name: string, mdbSourceId: number | null = null, origin: FeedOrigin = 'upload') => {
    loadImportIntoStore(data);
    useStore.getState().setProjectName(name);
    // Stamp Mobility Database import provenance AFTER loadImportIntoStore, which
    // resets editor state (clearing any previous feed's mdbSourceId). Only a
    // genuine MDB catalog import sets it — non-MDB replaces leave it cleared —
    // and it rides the working-state snapshot to feed_project.mdb_source_id at
    // publish (issue #47). Passed as an explicit arg so the empty-project
    // auto-import can't read a stale importMdbSourceId from state.
    if (mdbSourceId != null) useStore.getState().setMdbSourceId(mdbSourceId);
    fitMapToImport(data);

    // A feed is now in front of the user — the first-run funnel's "they got
    // something loaded" signal. Origin only; no file name, URL, or contents.
    trackFeedOpened(origin);
    setImportedCounts({
      routes: data.routes.length,
      stops: data.stops.length,
      trips: data.trips.length,
    });

    setPersistError(null);
    setPersisting(true);
    try {
      // `onComplete` means the dialog is in create-a-new-feed mode (MyFeedsPage /
      // OrgSettingsPage): the project doesn't exist yet and the caller does the
      // create + first save itself, so there is nothing here to write to — and
      // writing would push this feed into whichever project is still attached.
      const result = await persistImportedFeed({ creatingNewFeed: !!onComplete });
      if (result.kind === 'conflict') {
        setPersistError(
          'This feed changed somewhere else, so the import has not been saved.',
        );
      } else if (result.kind === 'failed') {
        setPersistError(`Saving to your feed failed: ${result.message}.`);
      }
    } finally {
      setPersisting(false);
    }
  }, [onComplete]);

  /** Hand a fully-resolved feed (from any source — zip parse or a "My feeds"
   * working-state fetch) to the import UI: surface warnings, then either
   * replace immediately (empty project) or open the route-picker so the user
   * chooses what to merge into the current project. Never mutates the store
   * itself except via doReplaceImport's explicit replace.
   *
   * `sourceUrl` is where this feed is actually known to have come from (the
   * pasted URL / catalog producer URL), or null for a plain upload / "My
   * feeds" import where there's nothing external to point at. Stashed in
   * component state here (rather than threaded through ImportData) because
   * it's provenance about THIS import action, not a property of the parsed
   * feed itself — it survives untouched whether we replace immediately or the
   * user lands on the mode-selection screen first. */
  const presentImportData = useCallback(async (data: ImportData, name: string, sourceUrl: string | null = null, mdbSourceId: number | null = null, origin: FeedOrigin = 'upload') => {
    setImportWarnings(data.warnings);
    setImportSourceUrl(sourceUrl);
    setImportMdbSourceId(mdbSourceId);
    setImportOrigin(origin);
    // If the project is empty, skip the options screen and import immediately —
    // there is nothing to merge into, so the choice is moot.
    //
    // EXCEPT for the "import from another feed" flow, whose whole purpose is
    // taking a SUBSET of another feed's routes. Skipping the picker there
    // silently imported the entire source feed, and a blank workspace is
    // exactly when you're most likely to be cherry-picking into it.
    if (useStore.getState().routes.length === 0 && origin !== 'myfeeds') {
      await doReplaceImport(data, name, mdbSourceId, origin);
      return;
    }
    setParsedData(data);
    setFileName(name);
    // Select all routes by default
    setSelectedRouteIds(new Set(data.routes.map((r) => r.route_id)));
  }, [doReplaceImport]);

  // The actual (expensive) parse. Always reached via parseFile so every entry
  // point — upload, URL, catalog — goes through the size pre-flight first.
  const runParse = useCallback(async (file: File, sourceUrl: string | null = null, mdbSourceId: number | null = null, origin: FeedOrigin = 'upload') => {
    setParsing(true);
    setProgress(null);
    setError(null);
    try {
      const data = await parseGtfsInWorker(file, ({ phase, rows }) =>
        setProgress(rows ? `${phase} ${rows.toLocaleString()} rows` : phase),
      );
      const name = file.name.replace(/\.zip$/i, '');
      await presentImportData(data, name, sourceUrl, mdbSourceId, origin);
    } catch (e: unknown) {
      // We fetched (or were handed) bytes and they weren't a usable GTFS zip.
      // Only the stage is recorded — never the parser's message, which can
      // quote file names and row contents.
      trackFeedImportFailed(origin, 'parse');
      setError(e instanceof Error ? e.message : 'Failed to parse GTFS feed');
    } finally {
      setParsing(false);
      setProgress(null);
    }
  }, [presentImportData]);

  const parseFile = useCallback(async (file: File, sourceUrl: string | null = null, mdbSourceId: number | null = null, origin: FeedOrigin = 'upload') => {
    setError(null);
    // Cheap pre-flight: if stop_times is large, gate behind a confirmation
    // instead of charging into a parse that can hang or crash the tab. If the
    // inspection itself fails, fall through and let the real parse surface it.
    try {
      const info = await inspectGtfsZip(file);
      if (info.isLarge) {
        setPendingLarge({ file, info, sourceUrl, mdbSourceId, origin });
        return;
      }
    } catch {
      /* ignore — proceed to the normal parse path */
    }
    await runParse(file, sourceUrl, mdbSourceId, origin);
  }, [runParse]);

  const proceedWithLarge = useCallback(() => {
    if (!pendingLarge) return;
    const { file, sourceUrl, mdbSourceId, origin } = pendingLarge;
    setPendingLarge(null);
    runParse(file, sourceUrl, mdbSourceId, origin);
  }, [pendingLarge, runParse]);

  const cancelLarge = useCallback(() => {
    // Backing out of the size gate isn't an error, but it is an import that
    // produced no feed — which is the funnel question.
    if (pendingLarge) trackFeedImportFailed(pendingLarge.origin, 'declined_large');
    setPendingLarge(null);
    setError(null);
  }, [pendingLarge]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) parseFile(file);
  }, [parseFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) parseFile(file);
  }, [parseFile]);

  const handleCatalogSelect = useCallback(async (feed: CatalogFeed, fileNameStem: string) => {
    const url = feed.latest_dataset?.hosted_url;
    // Everything up to (and including) the proxy download is the "fetch" stage;
    // parse failures are recorded by runParse itself, so this only wraps the
    // retrieval. Rethrown unchanged — CatalogSearch owns the error UI.
    if (!url) {
      trackFeedImportFailed('catalog', 'fetch');
      throw new Error('Feed has no dataset URL.');
    }
    const proxied = `${window.location.origin}/_import/proxy?url=${encodeURIComponent(url)}`;
    setError(null);
    let blob: Blob;
    try {
      const r = await fetch(proxied);
      if (!r.ok) throw new Error(`Download failed: ${r.status} ${await r.text()}`);
      blob = await r.blob();
    } catch (e) {
      trackFeedImportFailed('catalog', 'fetch');
      throw e;
    }
    const file = new File([blob], `${fileNameStem}.zip`, { type: 'application/zip' });
    // Prefer the producer's own URL (where the feed was actually published) for
    // RTAP provenance detection — an RTAP-built feed catalogued by Mobility
    // Database is still DOWNLOADED from MDB's own storage, not
    // rapid.nationalrtap.org, so hosted_url alone would never match. Fall back
    // to hosted_url if there's no producer URL; worse case it just doesn't
    // match nationalrtap.org, same as passing nothing at all.
    //
    // feed.id is the Mobility Database id (`mdb-<n>`); carry its numeric source
    // id as switcher provenance (issue #47). parseMdbSourceId returns null for
    // anything that isn't a clean MDB id, so we never guess.
    await parseFile(file, feed.source_info?.producer_url ?? url, parseMdbSourceId(feed.id), 'catalog');
  }, [parseFile]);

  // "My feeds" import: resolve the selected feed — published OR draft — from its
  // live working state (the same in-progress edit the editor loads on open),
  // then run the SAME route/stop picker → merge/replace pipeline as every other
  // source. We reshape the working state into the transient ImportData the
  // picker consumes WITHOUT touching the editor store, so importing another
  // project never clobbers or switches away from the one currently open.
  // Org-scoping is enforced server-side on the /working-state route.
  const handleMyFeedSelect = useCallback(async (feed: MyFeedItem) => {
    setError(null);
    let data: ImportData;
    let absent: WorkingStateAbsence | undefined;
    try {
      ({ data, absent } = await resolveMyFeedImportData(feed.id));
    } catch (e) {
      trackFeedImportFailed('myfeeds', 'fetch');
      throw e;
    }
    // Data loss, not an empty feed. The server has a working-state key on file
    // for this project but the blob is gone. Both cases used to arrive here as
    // an indistinguishable 404 and both told the user the reassuring "no routes
    // to import yet" — so a lost blob would never have been reported.
    if (absent === 'blob_missing') {
      trackFeedImportFailed('myfeeds', 'missing');
      throw new Error(
        "We couldn't load that feed's saved data — it may need to be restored from a saved version. Please contact support if this persists.",
      );
    }
    if (data.routes.length === 0) {
      trackFeedImportFailed('myfeeds', 'empty');
      throw new Error('That feed has no routes to import yet.');
    }
    // No external URL for an internal project reference.
    await presentImportData(data, feed.name || feed.slug, null, null, 'myfeeds');
  }, [presentImportData]);

  const handleUrlFetch = useCallback(async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) {
      setError('Paste a GTFS feed URL first.');
      return;
    }
    setError(null);
    setParsing(true);
    try {
      const res = await fetch(
        `/api/import/fetch?url=${encodeURIComponent(trimmed)}`,
        { method: 'GET', headers: { 'X-GB-Client': 'web' }, credentials: 'omit' },
      );
      if (!res.ok) {
        const ct = res.headers.get('content-type') || '';
        let message = `Import failed (${res.status}).`;
        if (ct.includes('application/json')) {
          try {
            const payload = (await res.json()) as { message?: string };
            if (payload?.message) message = payload.message;
          } catch {
            // fall through with default message
          }
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const stem =
        trimmed.split('/').pop()?.replace(/\.zip$/i, '') || 'imported-feed';
      const file = new File([blob], `${stem}.zip`, { type: 'application/zip' });
      // The URL the user pasted IS the feed's actual source — the strongest
      // provenance signal we have.
      await parseFile(file, trimmed, null, 'url');
    } catch (e) {
      // Only retrieval failures reach here — parseFile swallows parse errors
      // and records them itself. The pasted URL is deliberately NOT logged.
      trackFeedImportFailed('url', 'fetch');
      setError((e as Error).message || 'Failed to fetch feed.');
    } finally {
      setParsing(false);
    }
  }, [urlInput, parseFile]);

  const toggleRoute = (routeId: string) => {
    setSelectedRouteIds((prev) => {
      const next = new Set(prev);
      if (next.has(routeId)) next.delete(routeId);
      else next.add(routeId);
      return next;
    });
  };

  const handleImport = async () => {
    if (!parsedData) return;

    if (mode === 'replace') {
      await doReplaceImport(parsedData, fileName, importMdbSourceId, importOrigin);
    } else {
      if (selectedRouteIds.size === 0) return;
      mergeImportIntoStore(parsedData, selectedRouteIds);
      // A merge lands routes in an already-open feed. Labelled 'merge' rather
      // than the source tab so it can't be mistaken for a first-run "the user
      // finally got a feed loaded" event. Note a merge is undoable, so it also
      // trips the `feed_edited` beacon via history.recordChange.
      trackFeedOpened('merge');
      // Count stops/trips for selected routes
      const selTripIds = new Set(
        parsedData.trips
          .filter((t) => selectedRouteIds.has(t.route_id))
          .map((t) => t.trip_id),
      );
      const selStopIds = new Set(
        parsedData.stopTimes
          .filter((st) => selTripIds.has(st.trip_id))
          .map((st) => st.stop_id),
      );
      // Fit the map to the subset of stops + shapes for the merged routes
      // so the user isn't left looking at the wrong metro.
      const selShapeIds = new Set(
        parsedData.trips
          .filter((t) => selectedRouteIds.has(t.route_id) && t.shape_id)
          .map((t) => t.shape_id as string),
      );
      const subset: ImportData = {
        ...parsedData,
        stops: parsedData.stops.filter((s) => selStopIds.has(s.stop_id)),
        shapes: parsedData.shapes.filter((sh) => selShapeIds.has(sh.shape_id)),
      };
      fitMapToImport(subset);
      setImportedCounts({
        routes: selectedRouteIds.size,
        stops: selStopIds.size,
        trips: selTripIds.size,
      });
    }
  };

  const routeLabel = (r: Route) =>
    [r.route_short_name, r.route_long_name].filter(Boolean).join(' — ') || r.route_id;

  // ── Success screen ─────────────────────────────────────────────────────────
  if (importedCounts) {
    // Read the just-landed feed back from the store to decide whether to
    // offer the shapes-from-stops recipe. feedNeedsShapes looks at the whole
    // current project (not just what this import contributed) — consistent
    // with generateShapesFromStops itself, which repairs every shapeless
    // pattern in the store.
    const storeState = useStore.getState();
    const needsShapes = feedNeedsShapes(
      storeState.trips, storeState.stopTimes, storeState.stops, storeState.shapes,
    );
    // RTAP detection is copy-only flavor, so prefer the just-parsed feed's own
    // feed_info/agency rows (parsedData) when we have them — merge mode never
    // writes the imported feed's metadata into the store, only its routes. The
    // "project was empty" fast-import path skips parsedData entirely, so fall
    // back to the store, which a full replace populated from this same feed.
    // importSourceUrl has no store fallback (it's provenance about this import
    // action, not a store field) — it's stashed in state at import time (see
    // presentImportData) for exactly this read.
    const rtap = detectRtapFeed(
      parsedData?.feedInfo ?? storeState.feedInfo,
      parsedData?.agencies ?? storeState.agencies,
      importSourceUrl,
    );

    return (
      <>
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={completing || persisting ? undefined : onClose}>
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-teal-light rounded-lg flex items-center justify-center text-xl">✓</div>
              <h3 className="font-heading font-bold text-lg text-dark-brown">
                {mode === 'merge' ? 'Routes Added' : 'Import Successful'}
              </h3>
            </div>
            {persisting && (
              <div className="bg-cream border border-sand rounded-lg px-3 py-2 mb-4 text-sm text-warm-gray">
                Saving to your feed…
              </div>
            )}
            {/* The feed IS in the editor but did NOT reach the server. The store
                is left dirty on purpose, so Save is enabled and the unload guard
                is armed — say that plainly instead of showing an unqualified
                tick, which is the lie that stranded 18 feeds. */}
            {persistError && (
              <div className="bg-gold-light border border-amber-200 rounded-lg px-3 py-2 mb-4 text-sm text-amber-700">
                <strong>Not saved to your feed yet.</strong> {persistError} Your changes are still
                here in the editor — press <strong>Save</strong> in the toolbar.
              </div>
            )}
            {importWarnings.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4 text-xs text-amber-700">
                {importWarnings.map((w, i) => <p key={i}>{w}</p>)}
              </div>
            )}
            <div className="flex flex-col gap-2 mb-4">
              {([['Routes', importedCounts.routes], ['Stops', importedCounts.stops], ['Trips', importedCounts.trips]] as [string, number][]).map(
                ([label, count]) => (
                  <div key={label} className="flex justify-between px-3 py-2 bg-cream rounded-lg text-sm">
                    <span>{label}</span>
                    <span className="font-semibold">{count}</span>
                  </div>
                ),
              )}
            </div>
            {needsShapes && !shapesOfferDismissed && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-base">🛣️</span>
                  <p className="font-heading font-bold text-sm text-dark-brown">No route geometry in this feed</p>
                </div>
                <p className="text-xs text-amber-700 leading-relaxed">
                  {/* Lead with the observed fact in every case; the RTAP line is
                      additional color, worded to match how sure we actually are.
                      High confidence = fetched from a nationalrtap.org URL, or an
                      explicit "National RTAP" self-mention in the feed's own
                      metadata — either way it's fine to name RTAP outright. Low
                      confidence is a bare "rtap"/"gtfs builder" string mention,
                      which is common enough as a false positive that it's phrased
                      as a likeness, never an assertion. A plain ZIP upload with
                      no self-identifying string makes NO RTAP claim at all — we
                      genuinely can't tell RTAP provenance from bytes alone (see
                      rtapDetect.ts's TODO for why the content fingerprint we
                      tried first was abandoned). */}
                  {rtap.isRtap && rtap.confidence === 'high' && (
                    <>This looks like a National RTAP GTFS Builder feed: that tool ships shapes.txt empty by default. </>
                  )}
                  {rtap.isRtap && rtap.confidence === 'low' && (
                    <>This has some of the hallmarks of a spreadsheet-based GTFS Builder export (the kind National RTAP provides), which often ships shapes.txt empty rather than leaving it out. </>
                  )}
                  This feed has no usable route geometry, so trip planners will draw straight lines
                  between stops instead of following the streets. GTFS·X can generate route geometry by
                  snapping each route's stop sequence to the road network.
                </p>
                <div className="flex gap-2 mt-2.5">
                  <button
                    onClick={() => setShowShapesDialog(true)}
                    className="flex-1 px-3 py-2 bg-coral text-white rounded-lg font-heading font-bold text-xs hover:bg-[#d4603a] transition-colors"
                  >
                    Generate shapes from stops
                  </button>
                  <button
                    onClick={() => setShapesOfferDismissed(true)}
                    className="px-3 py-2 text-xs text-amber-700 hover:text-dark-brown transition-colors"
                  >
                    Not now
                  </button>
                </div>
                <p className="text-[11px] text-amber-700/80 mt-1.5">
                  You can run this later from the Validation panel too.
                </p>
              </div>
            )}
            {completeError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4 text-sm text-red-700">
                {completeError}
              </div>
            )}
            <button
              onClick={handleComplete}
              disabled={completing || persisting}
              className="w-full px-4 py-2.5 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {completing || persisting ? 'Saving…' : onComplete ? (completeLabel ?? 'Save feed') : 'Open in Editor'}
            </button>
          </div>
        </div>
        {/* Rendered as a sibling, not nested inside the overlay above, so its
            own backdrop click doesn't bubble into this screen's onClose. */}
        {showShapesDialog && (
          <ShapesFromStopsDialog
            rtapConfidence={rtap.isRtap ? rtap.confidence : undefined}
            onClose={() => setShowShapesDialog(false)}
          />
        )}
      </>
    );
  }

  // ── Large-feed warning gate ────────────────────────────────────────────────
  if (pendingLarge) {
    // Combined heavy-table footprint (stop_times + shapes) — what actually
    // strains memory — rounded for display.
    const mb = Math.round(
      (pendingLarge.info.stopTimesBytes + pendingLarge.info.shapesBytes) / (1024 * 1024),
    );
    const rows = pendingLarge.info.estimatedRows;
    return (
      <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={parsing ? undefined : onClose}>
        <div className="bg-white rounded-2xl shadow-xl max-w-md w-full mx-4 p-6" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-amber-100 rounded-lg flex items-center justify-center text-xl">⚠️</div>
            <h3 className="font-heading font-bold text-lg text-dark-brown">This feed is very large</h3>
          </div>
          <p className="text-sm text-warm-gray leading-relaxed mb-2">
            Its schedule data is about{' '}
            <span className="font-semibold text-dark-brown">~{rows.toLocaleString()} stop-time rows</span>{' '}
            (≈{mb} MB uncompressed). The browser-based editor holds the entire feed
            in memory, so feeds this size may load slowly or crash the tab.
          </p>
          <p className="text-sm text-warm-gray leading-relaxed mb-5">
            Consider a smaller or single-agency feed. You can still try to load it.
          </p>
          <div className="flex gap-2">
            <button
              onClick={cancelLarge}
              className="flex-1 px-4 py-2.5 border border-sand text-warm-gray rounded-lg font-heading font-bold text-sm hover:text-dark-brown hover:border-coral transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={proceedWithLarge}
              className="flex-1 px-4 py-2.5 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors"
            >
              Try anyway
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Step 2: Mode + route selection ────────────────────────────────────────
  if (parsedData) {
    const hasExistingRoutes = useStore.getState().routes.length > 0;

    return (
      <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
        <div className="bg-white rounded-2xl shadow-xl max-w-md w-full mx-4 p-6" onClick={(e) => e.stopPropagation()}>
          <h3 className="font-heading font-bold text-lg text-dark-brown mb-1">
            {initialSource === 'myfeeds' ? 'Import routes' : 'Import Options'}
          </h3>
          <p className="text-xs text-warm-gray mb-4">{fileName}.zip — {parsedData.routes.length} route{parsedData.routes.length !== 1 ? 's' : ''}</p>

          {importWarnings.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4 text-xs text-amber-700">
              {importWarnings.map((w, i) => <p key={i}>{w}</p>)}
            </div>
          )}

          {/* Mode selection. Hidden for the "Import from another feed" flow —
              that entry is always a route merge, so we skip the replace-vs-merge
              choice and go straight to the route picker. */}
          {initialSource !== 'myfeeds' && (
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => {
                if (!parsedData) return;
                setMode('replace');
                void doReplaceImport(parsedData, fileName, importMdbSourceId, importOrigin);
              }}
              className="flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors bg-white text-warm-gray border-sand hover:border-coral hover:text-dark-brown"
            >
              Replace project
            </button>
            <button
              onClick={() => setMode('merge')}
              disabled={!hasExistingRoutes}
              className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors
                ${mode === 'merge'
                  ? 'bg-coral text-white border-coral'
                  : 'bg-white text-warm-gray border-sand hover:border-coral hover:text-dark-brown'
                }
                disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              Import selected routes
            </button>
          </div>
          )}

          {/* Route list (merge mode) */}
          {mode === 'merge' && (
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-dark-brown uppercase tracking-wide">Select routes to import</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSelectedRouteIds(new Set(parsedData.routes.map((r) => r.route_id)))}
                    className="text-[11px] text-coral hover:underline"
                  >
                    All
                  </button>
                  <button
                    onClick={() => setSelectedRouteIds(new Set())}
                    className="text-[11px] text-warm-gray hover:underline"
                  >
                    None
                  </button>
                </div>
              </div>
              <div className="flex flex-col gap-1 max-h-52 overflow-y-auto border border-sand rounded-lg p-2">
                {parsedData.routes.map((r) => (
                  <label
                    key={r.route_id}
                    className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-cream cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedRouteIds.has(r.route_id)}
                      onChange={() => toggleRoute(r.route_id)}
                      className="accent-coral"
                    />
                    <span
                      className="inline-block w-3 h-3 rounded-sm shrink-0"
                      style={{ backgroundColor: `#${r.route_color || '888888'}` }}
                    />
                    <span className="text-sm text-dark-brown truncate">{routeLabel(r)}</span>
                  </label>
                ))}
              </div>
              {selectedRouteIds.size === 0 && (
                <p className="text-xs text-amber-600 mt-1">Select at least one route.</p>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => { setParsedData(null); setError(null); }}
              className="px-4 py-2 text-sm text-warm-gray hover:text-dark-brown"
            >
              ← Back
            </button>
            {mode === 'merge' && (
              <button
                onClick={handleImport}
                disabled={selectedRouteIds.size === 0}
                className="flex-1 px-4 py-2.5 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {`Import ${selectedRouteIds.size} route${selectedRouteIds.size !== 1 ? 's' : ''}`}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Step 1: Drop zone OR catalog search ────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full mx-4 p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-3">
          {useStore.getState().routes.length > 0 ? 'Import GTFS feed or routes' : 'Import GTFS feed'}
        </h3>

        {/* Source switcher */}
        <div className="flex gap-1 p-1 bg-cream rounded-lg mb-4">
          <button
            onClick={() => setSource('upload')}
            className={`flex-1 px-3 py-1.5 rounded-md text-sm font-semibold transition-colors
              ${source === 'upload' ? 'bg-white text-dark-brown shadow-sm' : 'text-warm-gray hover:text-dark-brown'}`}
          >
            Upload File
          </button>
          <button
            onClick={() => setSource('url')}
            className={`flex-1 px-3 py-1.5 rounded-md text-sm font-semibold transition-colors
              ${source === 'url' ? 'bg-white text-dark-brown shadow-sm' : 'text-warm-gray hover:text-dark-brown'}`}
          >
            From URL
          </button>
          <button
            onClick={() => setSource('catalog')}
            className={`flex-1 px-3 py-1.5 rounded-md text-sm font-semibold transition-colors
              ${source === 'catalog' ? 'bg-white text-dark-brown shadow-sm' : 'text-warm-gray hover:text-dark-brown'}`}
          >
            Search Catalog
          </button>
          {currentUser && (
            <button
              onClick={() => setSource('myfeeds')}
              className={`flex-1 px-3 py-1.5 rounded-md text-sm font-semibold transition-colors
                ${source === 'myfeeds' ? 'bg-white text-dark-brown shadow-sm' : 'text-warm-gray hover:text-dark-brown'}`}
            >
              Routes from my feeds
            </button>
          )}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {source === 'upload' && (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={`border-3 border-dashed rounded-2xl p-12 text-center transition-colors cursor-pointer
              ${dragging ? 'border-coral bg-coral-light' : 'border-sand bg-cream hover:border-coral hover:bg-coral-light'}`}
          >
            {parsing ? (
              <p className="text-warm-gray">{progress ?? 'Parsing…'}</p>
            ) : (
              <>
                <div className="text-5xl mb-4">🚌</div>
                <p className="font-heading font-bold text-dark-brown mb-2">Drop your GTFS feed here</p>
                <p className="text-warm-gray text-sm mb-4">Upload a .zip file to start editing</p>
                <label className="inline-flex items-center gap-2 px-4 py-2 bg-coral text-white rounded-lg font-heading font-bold text-sm cursor-pointer hover:bg-[#d4603a] transition-colors">
                  Browse Files
                  <input type="file" accept=".zip" className="hidden" onChange={handleFileInput} />
                </label>
              </>
            )}
          </div>
        )}

        {source === 'url' && (
          <div className="border border-sand rounded-2xl p-6">
            <label className="block text-xs font-semibold text-warm-gray uppercase tracking-wide mb-2">
              Public GTFS feed URL
            </label>
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !parsing) {
                  e.preventDefault();
                  handleUrlFetch();
                }
              }}
              disabled={parsing}
              placeholder="https://example.org/gtfs"
              className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white text-dark-brown focus:outline-none focus:border-coral disabled:opacity-50"
            />
            <p className="mt-2 text-xs text-warm-gray leading-relaxed">
              Paste a direct link to a GTFS feed — the URL doesn't need to end in <code className="font-mono">.zip</code>. Up to 100 MB; HTTPS preferred.
              Don't have a URL? Try <button onClick={() => setSource('catalog')} className="text-coral hover:underline">Search Catalog</button> to browse Mobility Database.
            </p>
            <button
              onClick={handleUrlFetch}
              disabled={parsing || !urlInput.trim()}
              className="mt-4 w-full px-4 py-2.5 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {parsing ? (progress ?? 'Fetching…') : 'Fetch feed'}
            </button>
          </div>
        )}

        {source === 'catalog' && (
          parsing ? (
            <div className="border border-sand rounded-lg p-12 text-center text-warm-gray">{progress ?? 'Parsing feed…'}</div>
          ) : (
            <CatalogSearch onSelect={handleCatalogSelect} />
          )
        )}

        {source === 'myfeeds' && (
          parsing ? (
            <div className="border border-sand rounded-lg p-12 text-center text-warm-gray">{progress ?? 'Parsing feed…'}</div>
          ) : (
            <MyFeedsSource onSelect={handleMyFeedSelect} />
          )
        )}

        <div className="flex justify-between mt-4">
          <button onClick={onClose} className="px-4 py-2 text-sm text-warm-gray hover:text-dark-brown">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
