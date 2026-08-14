import { useStore } from '../store';
import {
  fetchWorkingState,
  saveWorkingState,
  ConflictError,
} from '../services/projectsApi';
import { db } from './dexie';
import { repairRouteStops } from '../services/routeStopMigration';
import { loadingFeed } from '../store/history';
import {
  buildVariantsEnvelope,
  parseVariantsEnvelope,
  VARIANTS_ENVELOPE_KEY,
} from '../services/variantPersistence';

// Editor state that round-trips through the server snapshot. Notably excludes
// projectId and projectName: those are project-level metadata served by
// /api/projects/:id and re-applied by ServerEditorRoute on load. Including
// them in the snapshot caused the displayed name to diverge from the
// canonical project.name and re-marked dirty after reload.
const DATA_KEYS = [
  'agencies',
  'calendars',
  'calendarDates',
  'routes',
  'routeStops',
  'stops',
  'trips',
  'stopTimes',
  'shapes',
  'feedInfo',
  'fareAttributes',
  'fareRules',
  'fareAreas',
  'stopAreas',
  'fareNetworks',
  'routeNetworks',
  'timeframes',
  'riderCategories',
  'fareMedia',
  'fareProducts',
  'fareLegRules',
  'fareTransferRules',
  'frequencies',
  'levels',
  'pathways',
  'flexZones',
  // transfers.txt — transfer rules between routes/stops (timed connections,
  // minimum transfer times), edited from the Fares panel. A real feed entity
  // that the exporter writes but that was never wired into persistence, so it
  // was silently dropped on save/reload and leaked across feeds in-session
  // (#67). Persisting it here fixes both; it also rides the variant envelope
  // now, since variant snapshots are built from these DATA_KEYS.
  'transfers',
  'featureSettings',
  'dismissedValidations',
  // The feed's declared license (SPDX short identifier). Feed-state: the D1
  // `license_spdx` column is only the projection written at publish, so the
  // working-state snapshot is what preserves a license the user picked but
  // hasn't published yet. (An agency's `external_id` needs no key of its own —
  // it rides along inside the already-persisted `agencies` entity.)
  'licenseSpdx',
  // The Mobility Database source id this feed was imported from (issue #47's
  // switcher/dedup signal). Feed-state for the same reason as licenseSpdx: the
  // D1 `mdb_source_id` column is only projected at publish, so the working-state
  // snapshot is what carries import provenance from an anonymous draft, across
  // the sign-in migration, and into the first server publish.
  'mdbSourceId',
] as const;

type DataKey = (typeof DATA_KEYS)[number];

const versionCache = new Map<string, number>();

export function getCurrentWorkingStateVersion(projectId: string): number {
  return versionCache.get(projectId) ?? 0;
}

export function setCurrentWorkingStateVersion(projectId: string, version: number) {
  versionCache.set(projectId, version);
  useStore.getState().setWorkingStateVersion(version);
}

export function buildSnapshot(): Record<string, unknown> {
  const state = useStore.getState() as unknown as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const key of DATA_KEYS) {
    snapshot[key] = state[key];
  }
  return snapshot;
}

/** Pick just the feed DATA_KEYS out of an arbitrary snapshot object (drops the
 *  `__variants` envelope and any other non-feed keys) — the flat baseline feed. */
function pickDataKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of DATA_KEYS) out[key] = obj[key];
  return out;
}

/**
 * Build the full working-state snapshot to persist (#66 redesign).
 *
 * With no variants this is just buildSnapshot() — a flat, backward-compatible
 * blob. With variants active it makes the BASELINE canonical: the flat
 * top-level keys are always the baseline feed (never the live experiment), and
 * the variant layer rides in a `__variants` envelope (non-baseline variants
 * stored as diffs from baseline). The live store's edits to the active variant
 * are flushed into it first so nothing in-flight is dropped.
 */
export function buildWorkingStateSnapshot(): Record<string, unknown> {
  const st = useStore.getState();
  if (st.variants.length === 0) return buildSnapshot();

  // Flush the live store (the active variant's working copy) into its entry.
  if (st.activeVariantId) st.updateVariantSnapshot(st.activeVariantId, buildSnapshot());

  const variants = useStore.getState().variants;
  const baseline = variants.find((v) => v.baseline);
  // A variant set always carries a baseline; fall back to the live store only
  // defensively so we never write a broken (baseline-less) envelope.
  const baseSnap = baseline ? baseline.snapshot : buildSnapshot();
  const envelope = buildVariantsEnvelope(
    variants,
    useStore.getState().activeVariantId,
    baseSnap,
  );
  return { ...baseSnap, [VARIANTS_ENVELOPE_KEY]: envelope };
}

/**
 * Empty every entity slice the editor reads from. Use before loading a new
 * project so the previous one's routes/stops/calendars don't leak through.
 * Specifically guards two cases that were biting the create/delete flows:
 *   - a partial snapshot (missing key) — applySnapshotToStore's per-key
 *     guards would otherwise leave the old data untouched.
 *   - a brand-new project (null snapshot) — loadProjectFromServer needs to
 *     start clean rather than showing whatever feed was previously open.
 */
export function resetStoreEntities() {
  const state = useStore.getState();
  state.setAgencies([] as never);
  state.setCalendars([] as never);
  state.setCalendarDates([] as never);
  state.setRoutes([] as never);
  state.setRouteStops([] as never);
  state.setStops([] as never);
  state.setTrips([] as never);
  state.setStopTimes([] as never);
  state.setShapes([] as never);
  state.setFeedInfo(null as never);
  state.setFareAttributes([] as never);
  state.setFareRules([] as never);
  state.setFareAreas([] as never);
  state.setStopAreas([] as never);
  state.setFareNetworks([] as never);
  state.setRouteNetworks([] as never);
  state.setTimeframes([] as never);
  state.setRiderCategories([] as never);
  state.setFareMedia([] as never);
  state.setFareProducts([] as never);
  state.setFareLegRules([] as never);
  state.setFareTransferRules([] as never);
  state.setFrequencies([] as never);
  state.setLevels([] as never);
  state.setPathways([] as never);
  state.setFlexZones([] as never);
  // transfers.txt entities — cleared here so feed A's transfers can't survive
  // onto feed B opened in the same session (#67).
  state.setTransfers([] as never);
  state.setFeatureSettings({});
  state.setDismissedValidations([]);
  state.setLicenseSpdx(null);
  state.setMdbSourceId(null);
}

/**
 * Full "clean editor" reset for a feed boundary. Does everything
 * resetStoreEntities does, PLUS the transient view state that is not a feed
 * entity but still renders (or edits) per-feed: selection, any in-progress
 * drawing/editing, map mode, the per-feed visibility filters, and the derived
 * overlays (validation, coverage, access isochrone, walkshed profile, stop
 * analysis).
 *
 * Use this at EVERY point a feed is opened, replaced, created, or left —
 * server load, replace-import, create-new-feed, and leaving the read-only
 * /demo preview — so no in-memory geometry or editing buffer from the previous
 * feed can leak onto the next feed's map (#42). Resetting map mode to 'select'
 * with no editing ids also makes MapView's draw-sync effect deleteAll() the
 * imperative Mapbox Draw layer, so a half-drawn shape/zone can't survive either.
 */
export function resetEditorState() {
  const state = useStore.getState();
  // Selection + in-progress drawing/editing.
  state.selectRoute(null);
  state.selectStop(null);
  state.selectTrip(null);
  state.setEditingStopId(null);
  state.setDrawingRouteId(null);
  state.setDrawingNewRoute(false);
  state.setEditingRouteId(null);
  state.setEditingShapeId(null);
  state.setEditingFlexZoneId(null);
  state.setFlexZoneDetailId(null);
  state.setMapMode('select');
  // Per-feed visibility filters reference ids of the outgoing feed's rows.
  useStore.setState((s) => {
    s.hiddenRouteIds = [];
    s.hiddenShapeIds = [];
  });
  // Derived overlays / analytics — recomputed per feed, never inherited.
  state.setValidationMessages([]);
  state.setCoverageData(null);
  state.setCoverageError(null);
  state.clearAccessIsochrone();
  state.setWalkshedProfiles(null);
  state.setIsProfilingWalksheds(false);
  state.setWalkshedProfileError(null);
  state.setStopAnalysisOverlay(null);
  // Session variant layer belongs to the OUTGOING feed — clear it at every feed
  // boundary so a variant set can't bleed onto the next feed (#66). The load
  // path rehydrates it right after (loadProjectFromServer), and the
  // variant-management callers that run through this reset mid-operation
  // (switchToVariant / deleteVariant / discardVariants, and the publish-preview
  // swap) pass { preserveVariants: true } to applySnapshotToStore, which
  // captures and restores the layer around this reset.
  state.setVariants([]);
  state.setActiveVariantId(null);
  // Feed entities last.
  resetStoreEntities();
}

export interface ApplySnapshotOptions {
  /**
   * Keep the in-memory variant layer across the apply. resetEditorState()
   * clears it as a feed boundary (#66); callers switching WITHIN a variant set
   * (switchToVariant / deleteVariant / discardVariants), the publish-preview
   * swap, and the load path's re-apply of the active variant set this so the
   * layer is captured before the reset and restored after.
   */
  preserveVariants?: boolean;
  /**
   * Leave the dirty flag exactly as it was instead of declaring the store
   * clean. An apply normally IS the "we just loaded what the server has" event,
   * hence the trailing markSaved(). But some callers use it as a TRANSIENT
   * swap — PublishPanel renders a past snapshot's ZIP by applying it, exporting,
   * then applying the live state back (renderSnapshotZip). Marking clean on the
   * way back out told the user their genuinely-unsaved work was saved and
   * disabled the Save button on it. Transient swaps must pass this.
   */
  keepDirty?: boolean;
}

export function applySnapshotToStore(
  snapshot: Record<string, unknown>,
  opts?: ApplySnapshotOptions,
) {
  // Loading a snapshot (server load, snapshot restore, variant switch) replaces
  // the whole feed — suppress undo capture and reset history so undo/redo can't
  // cross the boundary (#49).
  loadingFeed(() => applySnapshotToStoreInner(snapshot, opts));
}

function applySnapshotToStoreInner(
  snapshot: Record<string, unknown>,
  opts?: ApplySnapshotOptions,
) {
  const state = useStore.getState();

  // Snapshot the variant layer before the reset when the caller is switching
  // WITHIN a variant set rather than crossing a feed boundary (#66).
  const preservedVariants = opts?.preserveVariants
    ? { variants: state.variants, activeVariantId: state.activeVariantId }
    : null;
  // Captured before the apply because every setter below marks the store dirty.
  const wasDirty = state.isDirty;

  // Clean-slate the editor first: selection, in-progress editing, map mode,
  // visibility filters, derived overlays, AND every entity slice. A partial
  // snapshot (missing a key) then can't leak the previous feed's rows, and no
  // stale geometry / editing buffer survives onto the new feed's map (#42).
  // The per-key Array.isArray guards below refill from whatever the snapshot
  // does carry.
  resetEditorState();

  const g = (k: DataKey) => snapshot[k];
  if (Array.isArray(g('agencies'))) state.setAgencies(g('agencies') as never);
  if (Array.isArray(g('calendars'))) state.setCalendars(g('calendars') as never);
  if (Array.isArray(g('calendarDates'))) state.setCalendarDates(g('calendarDates') as never);
  if (Array.isArray(g('routes'))) state.setRoutes(g('routes') as never);
  let repaired = false;
  if (Array.isArray(g('routeStops'))) {
    // Backfill shape_id on stops saved before per-shape keying — without this,
    // feeds created before today's route/shape change load with stops the
    // per-shape timetable + stops panel can't find (they show "Add stops to
    // this route first"). Shared with the local loader so they stay in sync.
    // Then cover any stop_times the pattern has no column for: route_stops were
    // derived from ONE canonical trip per direction, so a feed whose first trip
    // is a short-turn saved rows the timetable can neither show nor write.
    const fixed = repairRouteStops(
      g('routeStops') as never,
      (g('trips') ?? []) as never,
      (g('stopTimes') ?? []) as never,
    );
    repaired = fixed.repaired;
    state.setRouteStops(fixed.routeStops as never);
  }
  if (Array.isArray(g('stops'))) state.setStops(g('stops') as never);
  if (Array.isArray(g('trips'))) state.setTrips(g('trips') as never);
  if (Array.isArray(g('stopTimes'))) state.setStopTimes(g('stopTimes') as never);
  if (Array.isArray(g('shapes'))) state.setShapes(g('shapes') as never);
  if (g('feedInfo') !== undefined) state.setFeedInfo(g('feedInfo') as never);
  if (Array.isArray(g('fareAttributes'))) state.setFareAttributes(g('fareAttributes') as never);
  if (Array.isArray(g('fareRules'))) state.setFareRules(g('fareRules') as never);
  if (Array.isArray(g('fareAreas'))) state.setFareAreas(g('fareAreas') as never);
  if (Array.isArray(g('stopAreas'))) state.setStopAreas(g('stopAreas') as never);
  if (Array.isArray(g('fareNetworks'))) state.setFareNetworks(g('fareNetworks') as never);
  if (Array.isArray(g('routeNetworks'))) state.setRouteNetworks(g('routeNetworks') as never);
  if (Array.isArray(g('timeframes'))) state.setTimeframes(g('timeframes') as never);
  if (Array.isArray(g('riderCategories'))) state.setRiderCategories(g('riderCategories') as never);
  if (Array.isArray(g('fareMedia'))) state.setFareMedia(g('fareMedia') as never);
  if (Array.isArray(g('fareProducts'))) state.setFareProducts(g('fareProducts') as never);
  if (Array.isArray(g('fareLegRules'))) state.setFareLegRules(g('fareLegRules') as never);
  if (Array.isArray(g('fareTransferRules'))) state.setFareTransferRules(g('fareTransferRules') as never);
  if (Array.isArray(g('frequencies'))) state.setFrequencies(g('frequencies') as never);
  if (Array.isArray(g('levels'))) state.setLevels(g('levels') as never);
  if (Array.isArray(g('pathways'))) state.setPathways(g('pathways') as never);
  if (Array.isArray(g('flexZones'))) state.setFlexZones(g('flexZones') as never);
  // transfers.txt (#67). resetEditorState() above already cleared this to [], so
  // an old snapshot without the key correctly loads as empty transfers rather
  // than undefined-crashing or leaking the previous feed's transfers.
  if (Array.isArray(g('transfers'))) state.setTransfers(g('transfers') as never);
  if (g('featureSettings') && typeof g('featureSettings') === 'object') {
    state.setFeatureSettings(g('featureSettings') as never);
  }
  // Per-feed dismissed validation rules. resetEditorState() above already
  // cleared this to [], so an absent key correctly leaves a fresh feed showing
  // every rule (no cross-feed leak).
  if (Array.isArray(g('dismissedValidations'))) {
    state.setDismissedValidations(g('dismissedValidations') as never);
  }
  // resetEditorState() above already cleared this to null, so an absent or
  // explicitly-null key correctly leaves a fresh/cleared feed rather than
  // leaking the previous project's license.
  if (typeof g('licenseSpdx') === 'string') state.setLicenseSpdx(g('licenseSpdx') as string);
  // Same story as licenseSpdx: resetEditorState() cleared this to null, so an
  // absent/null key correctly leaves the feed with no import provenance rather
  // than leaking the previous project's mdb_source_id.
  if (typeof g('mdbSourceId') === 'number') state.setMdbSourceId(g('mdbSourceId') as number);
  // Older saved blobs may still carry a `visibilitySets` key (the removed
  // "Scenarios" feature). It's intentionally ignored here — unknown keys are
  // harmless and never re-applied. The `__variants` envelope key is likewise
  // not a DATA_KEY, so it's ignored here and rehydrated by loadProjectFromServer.

  // Restore the variant layer for within-set callers (see preserveVariants):
  // the reset above cleared it, but a variant switch / the load path's active
  // re-apply must keep the set intact.
  if (preservedVariants) {
    state.setVariants(preservedVariants.variants);
    state.setActiveVariantId(preservedVariants.activeVariantId);
  }

  state.markSaved();
  // A transient swap (publish-preview export) must not claim the user's
  // in-flight work is saved just because it round-tripped the store.
  if (opts?.keepDirty && wasDirty) state.markDirty();
  // A repaired route_stop pattern is a real, unsaved difference from what the
  // server holds. Assert it AFTER markSaved() so the editor offers to persist
  // the repair — otherwise the server keeps serving the broken pattern and
  // every session re-repairs it in memory, forever.
  if (repaired) state.markDirty();
}

/**
 * Drop a project's locally-cached working state from IndexedDB. Use after
 * server-side delete so a future autosave or reload doesn't resurrect the
 * removed feed; also use from the create-new-feed flow to make sure the
 * fresh editor starts from a clean local snapshot.
 *
 * Cheap and idempotent — Dexie .delete() on a missing key is a no-op.
 * Failures are swallowed: this is a cleanup, not a critical path, and a
 * stuck IndexedDB shouldn't keep the user from creating or deleting.
 */
export async function wipeLocalProject(projectId: string): Promise<void> {
  try {
    await Promise.all([
      db.projects.delete(projectId),
      db.projectData.delete(projectId),
      db.projectBulk.delete(projectId),
    ]);
  } catch (err) {
    console.warn('[wipeLocalProject] failed', { projectId, err });
  }
}

/**
 * Does the live store hold anything a user would recognise as their feed?
 * Deliberately routes/stops/trips only: agencies and featureSettings are
 * present in the canonical 248-byte "empty shell" blob, so counting them would
 * make every empty feed look populated.
 */
function storeHasFeedContent(): boolean {
  const st = useStore.getState();
  return st.routes.length > 0 || st.stops.length > 0 || st.trips.length > 0;
}

export async function loadProjectFromServer(projectId: string): Promise<void> {
  const { snapshot, version, absent, snapshotCount } = await fetchWorkingState(projectId);
  setCurrentWorkingStateVersion(projectId, version);
  const snap = snapshot ?? {};
  // Apply the flat top-level feed (the baseline), or an empty object for
  // brand-new projects. Going through applySnapshotToStore means the new
  // project always gets the full reset — selection, validation, coverage,
  // hidden-route filters, AND the variant layer (cleared here, rehydrated next).
  applySnapshotToStore(snap);

  // #66 redesign — rehydrate the variant layer from the `__variants` envelope.
  // Non-baseline variants are rebuilt as FULL independent snapshots by
  // overlaying their stored diff onto the baseline feed. Baseline-moved
  // semantics: because they're reconstructed as full, independent snapshots and
  // re-diffed against the then-current baseline on every save, editing the
  // baseline later never silently rewrites an existing variant — a variant
  // keeps the feed state it forked from (snapshot-fallback, not live-rebase).
  // This also means we never apply a diff against a baseline it wasn't computed
  // against: the stored diff and its baseline always travel together in the blob.
  const baseFlat = pickDataKeys(snap);
  const parsed = parseVariantsEnvelope(snap, baseFlat);
  if (parsed) {
    const st = useStore.getState();
    st.setVariants(parsed.variants);
    st.setActiveVariantId(parsed.activeVariantId);
    // Restore the live store to whatever variant was active at save time. The
    // baseline is already live from the apply above, so only re-apply when a
    // non-baseline variant was active. preserveVariants keeps the layer we just
    // set from being cleared by this apply's reset.
    const active = parsed.variants.find((v) => v.id === parsed.activeVariantId);
    if (active && !active.baseline) {
      applySnapshotToStore(active.snapshot, { preserveVariants: true });
    }
    // The applies above leave the store dirty only when they REPAIRED something
    // (see applySnapshotToStoreInner). Preserve that across this markSaved(),
    // or a feed with an orphaned pattern and a variant layer would silently go
    // back to looking clean and could never persist the repair.
    const repaired = useStore.getState().isDirty;
    useStore.getState().markSaved();
    if (repaired) useStore.getState().markDirty();
  }

  // Never open a feed to a SILENT blank canvas.
  //
  // `snapshot ?? {}` above happily applies nothing at all, which is correct for
  // a brand-new feed and alarming for anything else. Two cases are alarming:
  //   - the feed has saved versions but its live state carries no feed content
  //     (16 prod feeds were in exactly this state — "Save a version" wrote the
  //     version and left the working state behind);
  //   - the working-state blob the server has on file has gone missing.
  // Everything else — a feed nobody has saved yet — stays quiet.
  const versions = snapshotCount ?? 0;
  const emptyAndRecoverable = !storeHasFeedContent() && (versions > 0 || absent === 'blob_missing');
  useStore.getState().setEmptyWorkingState(
    emptyAndRecoverable
      ? { snapshotCount: versions, reason: absent === 'blob_missing' ? 'blob_missing' : 'no_content' }
      : null,
  );
}

/**
 * What a save attempt actually did. `saveProjectNow` resolves rather than
 * throwing on an If-Match conflict (the ConflictDialog owns that flow), which
 * means "it returned" is NOT the same as "the server has your work" — a caller
 * that chains another durable write onto a save has to be able to tell the
 * difference, or it reproduces the very bug this contract exists to prevent.
 */
export type SaveOutcome = 'saved' | 'conflict';

/**
 * One-shot save of the current store state to the server. Throws on network
 * failure or unexpected error; on If-Match conflict, dispatches the
 * `gb:working-state-conflict` event (so the existing ConflictDialog handles
 * resolution) and resolves with 'conflict' — NOT 'saved'.
 */
export async function saveProjectNow(projectId: string): Promise<SaveOutcome> {
  // #66 redesign: persist the BASELINE feed at top level plus the variant layer
  // (as diffs) in the envelope — never the active experiment into the feed slot.
  // (Supersedes the stopgap's snapshotOverride Save gate: Save is now always
  // lossless, so the gate dialog was removed.)
  const snapshot = buildWorkingStateSnapshot();
  const ifMatch = getCurrentWorkingStateVersion(projectId);
  try {
    const { workingStateVersion } = await saveWorkingState(projectId, snapshot, ifMatch);
    setCurrentWorkingStateVersion(projectId, workingStateVersion);
    useStore.getState().markSaved();
    // The live feed now matches what's in front of the user, so a stale
    // "this feed's live state is empty" warning must go.
    useStore.getState().setEmptyWorkingState(null);
    return 'saved';
  } catch (err) {
    if (err instanceof ConflictError) {
      window.dispatchEvent(
        new CustomEvent('gb:working-state-conflict', {
          detail: { projectId, currentVersion: err.currentVersion },
        }),
      );
      return 'conflict';
    }
    throw err;
  }
}

/**
 * Used by the conflict dialog's "Keep mine" path: refresh the cached
 * If-Match version to the server's latest, then save again so the user's
 * local state overwrites the remote.
 */
export async function forceSaveWithLatest(projectId: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'GET',
    credentials: 'include',
    headers: { 'X-GB-Client': 'web' },
  });
  if (res.ok) {
    const body = (await res.json()) as { workingStateVersion: number };
    setCurrentWorkingStateVersion(projectId, body.workingStateVersion);
  }
  await saveProjectNow(projectId);
}
