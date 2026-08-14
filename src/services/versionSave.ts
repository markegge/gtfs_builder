// "Save a version" — the whole operation, in one place.
//
// It used to be exactly one call: POST the store to /api/projects/:id/snapshots.
// That wrote an immutable snapshot and nothing else — not the working state,
// not markSaved(). The version then appeared in the list stamped with a
// timestamp, which reads like a save receipt, while the feed's LIVE state was
// untouched. Reopen the feed and you get a blank editor with the content
// sitting in a snapshot nobody told you about. 16 production feeds belonging to
// one customer were found in that state.
//
// So a version save is now two durable writes, and the ordering is load-bearing.
//
// ── Ordering: working state FIRST, version second, version aborted if the
//    working-state save didn't land ─────────────────────────────────────────
//
// The two failure states are not symmetric, and only one of them is the bug:
//
//   version written, working state stale  →  THE BUG. Content is invisible in
//       the product, the feed opens blank, and the user was just shown a
//       success. Unreachable by construction if the working state goes first
//       and a failure aborts the version.
//
//   working state written, version failed →  benign. The user's work is live in
//       the feed, exactly where they expect it; only the labelled restore point
//       is missing, and retrying costs one click. We report it plainly rather
//       than claiming success.
//
//   neither written                       →  nothing durable changed. The store
//       is still dirty, so the beforeunload guard, Save and Export all still
//       protect the work, and the error says so.
//
// The subtle case is the 409: saveProjectNow deliberately RESOLVES on an
// If-Match conflict (the ConflictDialog owns resolution) instead of throwing.
// Treating "it returned" as "it saved" would post the version against a stale
// working state — the original bug, reintroduced through a different door. That
// is why saveProjectNow reports a SaveOutcome and why we gate on it explicitly.
//
// Both writes now carry the SAME blob, from buildWorkingStateSnapshot(). The
// snapshot used to be built from its own hand-maintained key list that had
// drifted badly out of date (no Fares v2, frequencies, levels, pathways,
// transfers, dismissedValidations, licenseSpdx, mdbSourceId, and no `__variants`
// envelope) while carrying projectId/projectName, which the working state
// deliberately excludes. Since restoring a version writes the snapshot blob
// straight back over the working state, every one of those omissions was a
// silent wipe on restore.

import { useStore } from '../store';
import { runValidation } from './validation';
import { calculateSystemStats } from './costEstimation';
import { saveSnapshot, type ProjectSnapshot, type SnapshotSummary } from './projectsApi';
import {
  buildWorkingStateSnapshot,
  saveProjectNow,
  setCurrentWorkingStateVersion,
} from '../db/serverPersistence';

export type VersionSaveResult =
  | { ok: true; snapshot: ProjectSnapshot }
  /** The working-state save hit an If-Match conflict; no version was created. */
  | { ok: false; reason: 'conflict' };

export function buildSummary(state: ReturnType<typeof useStore.getState>): SnapshotSummary {
  const stats = calculateSystemStats(state);

  const serviceDays = new Set<string>();
  for (const cd of state.calendarDates) {
    serviceDays.add(`${cd.service_id}:${cd.date}`);
  }
  for (const c of state.calendars) {
    const active = [c.sunday, c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday].reduce<number>(
      (sum, v) => sum + (v ? 1 : 0),
      0,
    );
    serviceDays.add(`pattern:${c.service_id}:${active}`);
  }

  let feedStartDate: string | null = state.feedInfo?.feed_start_date ?? null;
  let feedEndDate: string | null = state.feedInfo?.feed_end_date ?? null;
  if (!feedStartDate || !feedEndDate) {
    let min: string | null = null;
    let max: string | null = null;
    for (const c of state.calendars) {
      if (c.start_date && (!min || c.start_date < min)) min = c.start_date;
      if (c.end_date && (!max || c.end_date > max)) max = c.end_date;
    }
    feedStartDate = feedStartDate || min;
    feedEndDate = feedEndDate || max;
  }

  return {
    routeCount: state.routes.length,
    stopCount: state.stops.length,
    tripCount: state.trips.length,
    serviceDayCount: serviceDays.size,
    feedStartDate,
    feedEndDate,
    revenueHoursWeekly: Math.round(stats.totalRevenueHoursWeekly * 10) / 10,
  };
}

/**
 * Save a labelled version of the feed AND persist the live working state.
 *
 * Throws on a failed working-state save (nothing durable was written, no
 * version was created) and on a failed snapshot POST (the working state DID
 * save — the message says so, because telling the user "save failed" when their
 * feed is safely saved is its own kind of lie).
 */
export async function saveVersionWithWorkingState(
  projectId: string,
  label: string,
): Promise<VersionSaveResult> {
  const state = useStore.getState();
  const messages = runValidation(state);
  const summary = buildSummary(state);

  // 1. The live feed. Must land before anything claims the feed is saved.
  const outcome = await saveProjectNow(projectId);
  if (outcome !== 'saved') return { ok: false, reason: 'conflict' };

  // 2. The immutable version — same bytes the working state just got, so a
  //    later restore round-trips losslessly.
  let res: Awaited<ReturnType<typeof saveSnapshot>>;
  try {
    res = await saveSnapshot(projectId, {
      label: label.trim() || undefined,
      summary,
      validationErrors: messages.filter((m) => m.severity === 'error').length,
      validationWarnings: messages.filter((m) => m.severity === 'warning').length,
      snapshot: buildWorkingStateSnapshot(),
    });
  } catch (err) {
    // The feed itself IS saved at this point. Saying "save failed" here would
    // be the mirror image of the bug we're fixing — an accurate-sounding
    // message that leaves the user with the wrong model of what's durable.
    const detail = err instanceof Error ? err.message : 'unknown error';
    throw new Error(`Your feed was saved, but the version wasn't created: ${detail}`, {
      cause: err,
    });
  }

  // Only sent when the server seeded the working state itself (it can't have,
  // on this path — step 1 already wrote it) — adopt it anyway so a client that
  // somehow got here with a stale token doesn't 409 on the next Save.
  if (typeof res.workingStateVersion === 'number') {
    setCurrentWorkingStateVersion(projectId, res.workingStateVersion);
  }

  return { ok: true, snapshot: res.snapshot };
}
