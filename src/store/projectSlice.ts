import type { StateCreator } from 'zustand';

export interface ProjectSlice {
  projectId: string;
  projectName: string;
  lastSavedAt: number | null;
  isDirty: boolean;
  // SPDX short identifier for the feed's declared license (e.g. "CC-BY-4.0"),
  // or null when unset. This is feed state: the store is the source of truth and
  // the D1 `license_spdx` column is only a projection written at publish, so a
  // license picked before the first publish survives a reload and is available
  // outside the publish flow.
  //
  // (An agency's NTD / external ID is NOT here — it belongs to the Agency
  // entity as `external_id` and rides along with agencies. See types/gtfs.ts.)
  licenseSpdx: string | null;
  // The Mobility Database numeric source id this feed was imported FROM, or null
  // when the feed didn't come from an MDB import. Like licenseSpdx this is feed
  // state: the store is the source of truth and the D1 `mdb_source_id` column is
  // only a projection written at (first) publish. It's the "switcher" signal —
  // an agency already catalogued in the Mobility Database that moved its hosting
  // to GTFS-X — so the open catalog can tell MDB to UPDATE that existing source
  // rather than create a duplicate (issue #47, docs/catalog-spec.md §7). Set
  // only for genuine MDB imports (never guessed); see setMdbSourceId.
  mdbSourceId: number | null;
  setProjectName: (name: string) => void;
  markDirty: () => void;
  /**
   * Declare the editor clean: clears `isDirty` and stamps `lastSavedAt`.
   *
   * ⚠️ Only call this when the bytes are durable WHERE THE USER THINKS THEY
   * ARE. `isDirty` is not a cosmetic flag — it drives the TopBar's Save button
   * (disabled when clean on a server-backed feed) and the `beforeunload`
   * guard. Clearing it early doesn't just mislabel the state, it removes the
   * two controls the user would have used to rescue their work.
   *
   * For a SERVER-BACKED feed (`activeServerProjectId != null`) durable means
   * the working-state PUT returned — nothing less. IndexedDB autosave is NOT
   * durability for a cloud feed: `setupAutoSave` returns early for one, so
   * there is no local copy either.
   *
   * This exact mistake put 18 production feeds into a state where the editor
   * said "Saved", the Save button was disabled, and the server held an empty
   * shell (ImportDialog's replace-import called markSaved() without writing to
   * the server). If you are reaching for this after a load or an import, ask
   * first: did anything reach the server? If not, leave the store dirty.
   */
  markSaved: () => void;
  setProjectId: (id: string) => void;
  setLicenseSpdx: (value: string | null) => void;
  setMdbSourceId: (value: number | null) => void;
}

export const createProjectSlice: StateCreator<ProjectSlice, [['zustand/immer', never]], [], ProjectSlice> = (set) => ({
  projectId: crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  projectName: 'Untitled Feed',
  lastSavedAt: null,
  isDirty: false,
  licenseSpdx: null,
  mdbSourceId: null,
  setProjectName: (name) => set((state) => {
    if (state.projectName === name) return;
    state.projectName = name;
    state.isDirty = true;
  }),
  markDirty: () => set((state) => { state.isDirty = true; }),
  markSaved: () => set((state) => { state.isDirty = false; state.lastSavedAt = Date.now(); }),
  setProjectId: (id) => set((state) => { state.projectId = id; }),
  setLicenseSpdx: (value) => set((state) => {
    // Trim; empty string → null (the "Not specified" option in the publish
    // panel's select sends '').
    const trimmed = value?.trim() ?? '';
    const normalized = trimmed === '' ? null : trimmed;
    if (state.licenseSpdx === normalized) return;
    state.licenseSpdx = normalized;
    state.isDirty = true;
  }),
  setMdbSourceId: (value) => set((state) => {
    // Only a positive integer is a valid Mobility Database source id; anything
    // else (NaN, 0, negatives, non-integers) normalizes to null so we never
    // stamp a bogus switcher id. Callers pass null to clear.
    const normalized =
      typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
    if (state.mdbSourceId === normalized) return;
    state.mdbSourceId = normalized;
    state.isDirty = true;
  }),
});
