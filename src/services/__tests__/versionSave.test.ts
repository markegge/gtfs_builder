// "Save a version" must also save the feed.
//
// Regression cover for the defect that stranded 16 production feeds: the
// snapshot POST wrote an immutable version and nothing else, so the feed's LIVE
// state stayed empty while the version list showed a timestamped entry that
// reads exactly like a save receipt. Reopening the feed gave a blank editor.
//
// The ordering is the fix, not an implementation detail, so it is asserted
// directly: working state first, version second, version ABORTED if the working
// state didn't land. See services/versionSave.ts for the reasoning.

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Route, Stop, Trip } from '../../types/gtfs';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  saveWorkingStateImpl: null as
    | ((id: string, snapshot: Record<string, unknown>, ifMatch: number) => Promise<{ workingStateVersion: number }>)
    | null,
  saveSnapshotImpl: null as ((...args: unknown[]) => Promise<unknown>) | null,
  lastSnapshotBlob: null as Record<string, unknown> | null,
  lastWorkingStateBlob: null as Record<string, unknown> | null,
}));

vi.mock('../projectsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../projectsApi')>();
  return {
    ...actual,
    fetchWorkingState: async () => ({ snapshot: null, version: 0 }),
    saveWorkingState: async (id: string, snapshot: Record<string, unknown>, ifMatch: number) => {
      h.calls.push('saveWorkingState');
      h.lastWorkingStateBlob = snapshot;
      if (h.saveWorkingStateImpl) return h.saveWorkingStateImpl(id, snapshot, ifMatch);
      return { workingStateVersion: ifMatch + 1 };
    },
    saveSnapshot: async (...args: unknown[]) => {
      h.calls.push('saveSnapshot');
      const input = args[1] as { snapshot: Record<string, unknown> };
      h.lastSnapshotBlob = input.snapshot;
      if (h.saveSnapshotImpl) return h.saveSnapshotImpl(...args);
      return { snapshot: { id: 'v1', label: null, createdAt: 1, validationErrors: 0, validationWarnings: 0, summary: null } };
    },
  };
});

const { useStore } = await import('../../store');
const { ConflictError } = await import('../projectsApi');
const { resetEditorState, setCurrentWorkingStateVersion, getCurrentWorkingStateVersion } =
  await import('../../db/serverPersistence');
const { saveVersionWithWorkingState } = await import('../versionSave');

const PID = 'proj-1';

function seedFeed() {
  const s = useStore.getState();
  resetEditorState();
  s.setRoutes([{ route_id: 'R1', route_short_name: '1', route_long_name: 'Main', route_type: 3 } as Route]);
  s.setStops([{ stop_id: 'S1', stop_name: 'A', stop_lat: 45, stop_lon: -111, wheelchair_boarding: 0 } as unknown as Stop]);
  s.setTrips([{ trip_id: 'T1', route_id: 'R1', service_id: 'wk', direction_id: 0 } as Trip]);
}

beforeEach(() => {
  h.calls = [];
  h.saveWorkingStateImpl = null;
  h.saveSnapshotImpl = null;
  h.lastSnapshotBlob = null;
  h.lastWorkingStateBlob = null;
  setCurrentWorkingStateVersion(PID, 0);
  seedFeed();
  // window is absent in the node test env; saveProjectNow dispatches the
  // conflict event on it.
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
});

describe('saveVersionWithWorkingState', () => {
  it('persists the WORKING STATE as well as the version — the actual bug', async () => {
    const result = await saveVersionWithWorkingState(PID, 'Aug 12, 2026');

    expect(result.ok).toBe(true);
    expect(h.calls).toContain('saveWorkingState');
    expect(h.calls).toContain('saveSnapshot');
    // The live feed got the real content, not an empty shell.
    expect((h.lastWorkingStateBlob?.routes as Route[]).map((r) => r.route_id)).toEqual(['R1']);
    // …and the editor is no longer claiming unsaved work.
    expect(useStore.getState().isDirty).toBe(false);
    // …and the If-Match token advanced, so the next Save doesn't 409.
    expect(getCurrentWorkingStateVersion(PID)).toBe(1);
  });

  it('saves the working state BEFORE the version', async () => {
    await saveVersionWithWorkingState(PID, 'label');
    expect(h.calls).toEqual(['saveWorkingState', 'saveSnapshot']);
  });

  it('writes the SAME blob to both, so a restore round-trips losslessly', async () => {
    // The snapshot used to be built from its own stale key list — no transfers,
    // no Fares v2, no featureSettings — and restore copies the snapshot blob
    // straight back over the working state, so every omission was a silent wipe.
    useStore.getState().setTransfers([{ from_stop_id: 'S1', to_stop_id: 'S1', transfer_type: 0 }] as never);
    useStore.getState().setLicenseSpdx('CC-BY-4.0');

    await saveVersionWithWorkingState(PID, 'label');

    expect(h.lastSnapshotBlob).toEqual(h.lastWorkingStateBlob);
    expect(h.lastSnapshotBlob?.transfers).toHaveLength(1);
    expect(h.lastSnapshotBlob?.licenseSpdx).toBe('CC-BY-4.0');
    // The working state deliberately excludes these; the old snapshot included
    // them and injected them back on restore.
    expect(h.lastSnapshotBlob).not.toHaveProperty('projectId');
    expect(h.lastSnapshotBlob).not.toHaveProperty('projectName');
  });

  it('does NOT create a version when the working-state save conflicts', async () => {
    // saveProjectNow RESOLVES on a 409 (the ConflictDialog owns resolution), so
    // "it returned" is not "it saved". Posting the version here would recreate
    // the original bug through a different door.
    h.saveWorkingStateImpl = async () => {
      throw new ConflictError('Working state has been updated elsewhere', 7);
    };

    const result = await saveVersionWithWorkingState(PID, 'label');

    expect(result).toEqual({ ok: false, reason: 'conflict' });
    expect(h.calls).toEqual(['saveWorkingState']);
  });

  it('does NOT create a version when the working-state save throws', async () => {
    h.saveWorkingStateImpl = async () => {
      throw new Error('network down');
    };
    await expect(saveVersionWithWorkingState(PID, 'label')).rejects.toThrow('network down');
    expect(h.calls).toEqual(['saveWorkingState']);
  });

  it('says the FEED was saved when only the version write fails', async () => {
    h.saveSnapshotImpl = async () => {
      throw new Error('quota exceeded');
    };
    // Telling the user "save failed" here would be the mirror image of the bug:
    // their feed IS durable, only the restore point is missing.
    await expect(saveVersionWithWorkingState(PID, 'label')).rejects.toThrow(
      /Your feed was saved, but the version wasn't created: quota exceeded/,
    );
    expect(useStore.getState().isDirty).toBe(false);
  });
});
