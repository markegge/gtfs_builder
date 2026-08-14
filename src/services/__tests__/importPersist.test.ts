// The root cause of the stranded feeds: an import declared the editor SAVED on
// a server-backed feed without writing anything to the server.
//
// `isDirty` is not cosmetic. TopBar disables Save when `!isDirty &&
// activeServerProjectId`, and the beforeunload guard returns early when the
// store is clean — so clearing it early told the user their work was safe AND
// removed both ways to rescue it, over a server holding an empty shell.
//
// These tests pin the invariant: the store is NEVER clean unless something
// durable happened where the user believes their feed lives.

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Route } from '../../types/gtfs';

const h = vi.hoisted(() => ({
  saveWorkingStateImpl: null as
    | ((id: string, snap: Record<string, unknown>, ifMatch: number) => Promise<{ workingStateVersion: number }>)
    | null,
  puts: 0,
}));

vi.mock('../projectsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../projectsApi')>();
  return {
    ...actual,
    fetchWorkingState: async () => ({ snapshot: null, version: 0 }),
    saveWorkingState: async (id: string, snap: Record<string, unknown>, ifMatch: number) => {
      h.puts += 1;
      if (h.saveWorkingStateImpl) return h.saveWorkingStateImpl(id, snap, ifMatch);
      return { workingStateVersion: ifMatch + 1 };
    },
  };
});

const { useStore } = await import('../../store');
const { ConflictError } = await import('../projectsApi');
const { resetEditorState, setCurrentWorkingStateVersion } = await import('../../db/serverPersistence');
const { persistImportedFeed } = await import('../importPersist');

const PID = 'proj-1';

/** Stand in for loadImportIntoStore: content lands in the store, store is dirty. */
function loadFeedIntoStore() {
  resetEditorState();
  useStore.getState().setRoutes([
    { route_id: 'R1', route_short_name: '1', route_long_name: 'Main', route_type: 3 } as Route,
  ]);
  useStore.getState().markDirty();
}

/** TopBar's actual Save-button predicate (TopBar.tsx: disabled when true). */
const saveButtonDisabled = () => {
  const s = useStore.getState();
  return !s.isDirty && !!s.activeServerProjectId;
};

/** App.tsx's beforeunload guard: returns early (no prompt) when clean. */
const unloadGuardArmed = () => useStore.getState().isDirty;

beforeEach(() => {
  h.saveWorkingStateImpl = null;
  h.puts = 0;
  setCurrentWorkingStateVersion(PID, 0);
  resetEditorState();
  useStore.getState().setActiveServerProject(null);
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
});

describe('persistImportedFeed — on a SERVER-BACKED feed', () => {
  beforeEach(() => {
    useStore.getState().setActiveServerProject(PID);
    loadFeedIntoStore();
  });

  it('writes the import to the server rather than only claiming it did', async () => {
    const result = await persistImportedFeed();

    expect(result).toEqual({ kind: 'saved' });
    expect(h.puts).toBe(1); // the actual regression: something reached the server
    expect(useStore.getState().isDirty).toBe(false);
  });

  it('leaves the store DIRTY when the save fails, keeping Save and the unload guard alive', async () => {
    h.saveWorkingStateImpl = async () => {
      throw new Error('network down');
    };

    const result = await persistImportedFeed();

    expect(result).toEqual({ kind: 'failed', message: 'network down' });
    // The three things that went wrong together, asserted together.
    expect(useStore.getState().isDirty).toBe(true);
    expect(saveButtonDisabled()).toBe(false);
    expect(unloadGuardArmed()).toBe(true);
  });

  it('treats an If-Match conflict as NOT saved', async () => {
    // saveProjectNow resolves rather than throwing on a 409 (the ConflictDialog
    // owns resolution), so a caller reading "it returned" as success would
    // silently reproduce the bug.
    h.saveWorkingStateImpl = async () => {
      throw new ConflictError('Working state has been updated elsewhere', 4);
    };

    const result = await persistImportedFeed();

    expect(result).toEqual({ kind: 'conflict' });
    expect(useStore.getState().isDirty).toBe(true);
    expect(saveButtonDisabled()).toBe(false);
  });

  it('never reports saved without a PUT', async () => {
    h.saveWorkingStateImpl = async () => {
      throw new Error('boom');
    };
    const result = await persistImportedFeed();
    expect(result.kind).not.toBe('saved');
    expect(useStore.getState().isDirty).toBe(true);
  });
});

describe('persistImportedFeed — when there is no server feed', () => {
  it('marks clean for an anonymous draft (IndexedDB autosave really does cover it)', async () => {
    loadFeedIntoStore();
    expect(useStore.getState().activeServerProjectId).toBeNull();

    const result = await persistImportedFeed();

    expect(result).toEqual({ kind: 'local' });
    expect(useStore.getState().isDirty).toBe(false);
    expect(h.puts).toBe(0);
    // No server feed, so Save routes to Save-As and stays enabled regardless.
    expect(saveButtonDisabled()).toBe(false);
  });

  it('does NOT write to a still-attached feed when the caller is creating a new one', async () => {
    // MyFeedsPage / OrgSettingsPage pass ImportDialog an onComplete: they create
    // the project and do the first save themselves. Writing here would push the
    // imported feed into whatever project happened to still be attached.
    useStore.getState().setActiveServerProject('some-other-feed');
    loadFeedIntoStore();

    const result = await persistImportedFeed({ creatingNewFeed: true });

    expect(result).toEqual({ kind: 'local' });
    expect(h.puts).toBe(0);
  });
});
