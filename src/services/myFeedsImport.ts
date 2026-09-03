// "My feeds" import source — lists EVERY feed project the signed-in account can
// access (personal + each org) and resolves a selected one — published OR not —
// so the existing ImportDialog route/stop picker + merge pipeline can ingest it.
//
// v2 (this file): drops the published-only restriction. Instead of fetching a
// feed's published GTFS zip, we read its live working state (the same in-progress
// edit the editor loads on open) via fetchWorkingState and reshape it into the
// transient ImportData the picker already understands. One code path covers
// published and draft feeds, and it's always the latest data. Crucially this is
// a PURE transform — it never touches the editor store, so importing another
// project never clobbers or switches away from the project you have open.

import { backfillMissingRouteStops, backfillRouteStopShapeIds } from './routeStopMigration';
import {
  fetchWorkingState,
  listProjects,
  type ProjectSummary,
  type WorkingStateAbsence,
} from './projectsApi';
import type { ImportData } from './gtfsImport';
import type { RouteStop, StopTime, Trip } from '../types/gtfs';

/**
 * Gzipped working-state size at or below which a feed is *probably* empty.
 *
 * The canonical "empty shell" a fresh feed saves is 248–249 B gzipped (513 B of
 * JSON carrying only featureSettings); a bare `{}`-shaped blob is 123 B.
 *
 * This is a HINT, never a verdict. gzip is extremely effective on repetitive
 * route JSON — a synthetic 12-route feed compresses to 212 B, comfortably under
 * the empty shell — so size cannot prove a feed is empty and must never be used
 * to block one. Only `workingStateSize == null` (no blob at all, the fetch is
 * guaranteed to 404) is treated as certain.
 */
export const LIKELY_EMPTY_WORKING_STATE_BYTES = 260;

/**
 * How much confidence we have that picking this feed will yield nothing.
 *
 *   empty        — no working state exists at all. Certain: the fetch 404s.
 *   likely-empty — a blob exists but is small enough to probably be a shell.
 *                  Advisory only; the entry stays clickable.
 *   ok           — big enough to carry real content.
 */
export type MyFeedContent = 'empty' | 'likely-empty' | 'ok';

export function feedContentState(p: ProjectSummary): MyFeedContent {
  if (p.workingStateSize == null) return 'empty';
  if (p.workingStateSize <= LIKELY_EMPTY_WORKING_STATE_BYTES) return 'likely-empty';
  return 'ok';
}

export interface MyFeedItem {
  id: string;
  slug: string;
  name: string;
  /**
   * Whether the feed has a live canonical publication. Purely informational now
   * (shown as a published/draft label) — every feed is importable regardless,
   * since we import from the working state, not the published zip.
   */
  published: boolean;
  /** Last-edited timestamp (working state, falling back to project updatedAt). */
  updatedAt: number;
  thumbnailUrl: string | null;
  /**
   * Whether this feed has anything to import. ~25% of live feeds have nothing,
   * and the server sorts them most-recently-touched first — a never-saved feed
   * falls back to its creation time, which puts fresh empty shells at the TOP.
   * The entries most likely to be clicked were the ones guaranteed to fail.
   */
  content: MyFeedContent;
}

/** Shape a raw project summary into the importer's feed-list item. */
export function toMyFeedItem(p: ProjectSummary): MyFeedItem {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    published: p.published === true,
    updatedAt: p.workingStateUpdatedAt ?? p.updatedAt,
    thumbnailUrl: p.thumbnailUrl ?? null,
    // No new API surface needed: ProjectSummary already carries the size.
    content: feedContentState(p),
  };
}

/**
 * List the feeds in one workspace for the importer. `scope` is 'personal' or
 * 'org:<id>' (the same scope string MyFeedsSource derives from activeWorkspace),
 * so the server returns only feeds the caller can access — org-scoping is
 * enforced server-side. Both published and draft feeds are returned. Archived
 * feeds are excluded (importer default).
 */
export async function listMyFeeds(scope: string): Promise<MyFeedItem[]> {
  const res = await listProjects({ scope });
  return res.projects.map(toMyFeedItem);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Reshape a project's working-state snapshot (the JSON blob the editor saves /
 * loads) into the transient ImportData the ImportDialog route/stop picker +
 * mergeImportIntoStore pipeline consume. The snapshot's keys are the same entity
 * slices the editor persists, so this is a direct field map — missing keys
 * default to empty arrays (a partial/old blob can't leak undefined into the
 * picker), and `warnings` is empty because nothing was parsed.
 *
 * routeStops get the same shape_id backfill the editor's own load path applies
 * (backfillRouteStopShapeIds), so a feed saved before per-shape keying still
 * lines its stops up under the right route in the picker/merge.
 *
 * This does NOT mutate the editor store — the result is a throwaway structure
 * handed to the picker, keeping the currently-open project untouched.
 */
export function workingStateToImportData(snapshot: Record<string, unknown>): ImportData {
  const trips = asArray<Trip>(snapshot.trips);
  const stopTimes = asArray<StopTime>(snapshot.stopTimes);
  const routeStops = backfillMissingRouteStops(
    backfillRouteStopShapeIds(asArray<RouteStop>(snapshot.routeStops), trips),
    trips,
    stopTimes,
  );
  return {
    agencies: asArray(snapshot.agencies),
    calendars: asArray(snapshot.calendars),
    calendarDates: asArray(snapshot.calendarDates),
    routes: asArray(snapshot.routes),
    shapes: asArray(snapshot.shapes),
    stops: asArray(snapshot.stops),
    trips,
    stopTimes,
    feedInfo: (snapshot.feedInfo ?? null) as ImportData['feedInfo'],
    routeStops,
    fareAttributes: asArray(snapshot.fareAttributes),
    fareRules: asArray(snapshot.fareRules),
    transfers: asArray(snapshot.transfers),
    frequencies: asArray(snapshot.frequencies),
    levels: asArray(snapshot.levels),
    pathways: asArray(snapshot.pathways),
    fareAreas: asArray(snapshot.fareAreas),
    stopAreas: asArray(snapshot.stopAreas),
    fareNetworks: asArray(snapshot.fareNetworks),
    routeNetworks: asArray(snapshot.routeNetworks),
    timeframes: asArray(snapshot.timeframes),
    riderCategories: asArray(snapshot.riderCategories),
    fareMedia: asArray(snapshot.fareMedia),
    fareProducts: asArray(snapshot.fareProducts),
    fareLegRules: asArray(snapshot.fareLegRules),
    fareTransferRules: asArray(snapshot.fareTransferRules),
    flexZones: asArray(snapshot.flexZones),
    // An agency's `external_id` (its NTD ID) needs nothing here — it is a field
    // on the Agency entity, so it rides along inside `agencies` above.
    warnings: [],
  };
}

export interface MyFeedImportResolution {
  data: ImportData;
  /**
   * Set when the server had no working state to give us. `never_saved` is the
   * ordinary "brand-new feed" case; `blob_missing` is real data loss and must
   * NOT be reported to the user (or to telemetry) as an ordinary empty feed —
   * they looked identical before, which is why a lost blob would have been
   * invisible.
   */
  absent?: WorkingStateAbsence;
}

/**
 * Resolve a chosen feed (by project id) to the transient ImportData the picker
 * ingests, by fetching its working state. Org-scoping is enforced server-side on
 * the /working-state route, so this only succeeds for feeds the caller can
 * access. A brand-new project with no working state yet resolves to empty data.
 */
export async function resolveMyFeedImportData(
  projectId: string,
): Promise<MyFeedImportResolution> {
  const { snapshot, absent } = await fetchWorkingState(projectId);
  return { data: workingStateToImportData(snapshot ?? {}), absent };
}
