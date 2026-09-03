// Never open a feed to a SILENT blank canvas.
//
// loadProjectFromServer does `const snap = snapshot ?? {}` and applies it, which
// is correct for a brand-new feed and alarming for anything else. 16 production
// feeds opened as an empty editor with no banner, no error, and no hint that a
// saved version held the content — and feed_opened('saved_project') still fired,
// so the funnel counted it as a success.
//
// The distinction these tests pin down: "new feed, nothing saved yet" must stay
// quiet; "this feed has saved versions but its live state is empty" must not.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Route } from '../../types/gtfs';

const fetchWorkingState = vi.fn();
vi.mock('../../services/projectsApi', () => ({
  fetchWorkingState: (...args: unknown[]) => fetchWorkingState(...args),
  saveWorkingState: vi.fn(),
  ConflictError: class ConflictError extends Error {
    currentVersion = 0;
  },
}));

const { useStore } = await import('../../store');
const { loadProjectFromServer, resetStoreEntities } = await import('../serverPersistence');

const ROUTE: Route = {
  route_id: 'R1',
  route_short_name: '1',
  route_long_name: 'Main',
  route_type: 3,
} as Route;

beforeEach(() => {
  resetStoreEntities();
  useStore.getState().setEmptyWorkingState(null);
  useStore.getState().setActiveServerProject('proj-1');
  fetchWorkingState.mockReset();
});

describe('opening a feed whose live state is empty', () => {
  it('warns when the feed has saved versions but no live content', async () => {
    // Exactly the 16 prod feeds: v=0, no working state, versions hold the work.
    fetchWorkingState.mockResolvedValue({
      snapshot: null,
      version: 0,
      absent: 'never_saved',
      snapshotCount: 3,
    });

    await loadProjectFromServer('proj-1');

    expect(useStore.getState().emptyWorkingState).toEqual({
      snapshotCount: 3,
      reason: 'no_content',
    });
  });

  it('warns for a SAVED-but-empty working state too (the 248-byte shell)', async () => {
    // A blob that exists and carries only featureSettings — 22 live prod feeds.
    fetchWorkingState.mockResolvedValue({
      snapshot: { featureSettings: { flex: true }, routes: [], stops: [], trips: [] },
      version: 2,
      snapshotCount: 1,
    });

    await loadProjectFromServer('proj-1');

    expect(useStore.getState().emptyWorkingState).toEqual({
      snapshotCount: 1,
      reason: 'no_content',
    });
  });

  it('stays QUIET for a genuinely new feed with nothing saved and no versions', async () => {
    fetchWorkingState.mockResolvedValue({
      snapshot: null,
      version: 0,
      absent: 'never_saved',
      snapshotCount: 0,
    });

    await loadProjectFromServer('proj-1');

    expect(useStore.getState().emptyWorkingState).toBeNull();
  });

  it('flags a MISSING blob even when there are no versions to recover from', async () => {
    // Real data loss. Nothing to restore, but the user must not be shown a
    // blank canvas as if it were their feed.
    fetchWorkingState.mockResolvedValue({
      snapshot: null,
      version: 9,
      absent: 'blob_missing',
      snapshotCount: 0,
    });

    await loadProjectFromServer('proj-1');

    expect(useStore.getState().emptyWorkingState).toEqual({
      snapshotCount: 0,
      reason: 'blob_missing',
    });
  });

  it('stays quiet when the feed actually has content', async () => {
    fetchWorkingState.mockResolvedValue({
      snapshot: { routes: [ROUTE], stops: [], trips: [] },
      version: 4,
      snapshotCount: 5,
    });

    await loadProjectFromServer('proj-1');

    expect(useStore.getState().emptyWorkingState).toBeNull();
  });

  it('clears a stale warning when the feed is reloaded with content (e.g. after a restore)', async () => {
    fetchWorkingState.mockResolvedValue({ snapshot: null, version: 0, snapshotCount: 2 });
    await loadProjectFromServer('proj-1');
    expect(useStore.getState().emptyWorkingState).not.toBeNull();

    fetchWorkingState.mockResolvedValue({
      snapshot: { routes: [ROUTE] },
      version: 3,
      snapshotCount: 2,
    });
    await loadProjectFromServer('proj-1');
    expect(useStore.getState().emptyWorkingState).toBeNull();
  });

  it('does not follow the user to the next feed', async () => {
    fetchWorkingState.mockResolvedValue({ snapshot: null, version: 0, snapshotCount: 2 });
    await loadProjectFromServer('proj-1');
    expect(useStore.getState().emptyWorkingState).not.toBeNull();

    useStore.getState().setActiveServerProject(null);
    expect(useStore.getState().emptyWorkingState).toBeNull();
  });
});
