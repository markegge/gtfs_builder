// One decision, in one place: after a feed has been loaded into the store, is
// the editor allowed to call itself SAVED?
//
// It got this wrong exactly once and that was enough. ImportDialog's
// replace-import ended with a bare `markSaved()` on the reasoning that "an
// import is a load, not an edit". True for an anonymous draft — IndexedDB
// autosave has it. False for a server-backed feed, where `setupAutoSave`
// returns early (src/db/persistence.ts) and NOTHING had reached the server.
//
// The consequences compound in the worst possible direction, because `isDirty`
// is not a label — it is the switch behind both rescue controls:
//
//   - TopBar disables Save when `!isDirty && activeServerProjectId`, so the
//     button the user would have pressed was greyed out;
//   - the `beforeunload` guard returns early when the store is clean, so
//     closing the tab took the work silently.
//
// So the editor said "Saved", removed the way to save, and dropped the warning,
// over a server holding a 248-byte empty shell. 18 production feeds reached
// that state. The user was not misusing "Save a version" — it was the only
// control still available to them.
//
// The rule this module enforces: never declare clean without a durable write to
// wherever the user believes their feed lives. Route every "I just loaded a
// feed into a possibly-server-backed store" path through here rather than
// reaching for markSaved() again.

import { useStore } from '../store';
import { saveProjectNow } from '../db/serverPersistence';
import { ApiError } from './authApi';

export type ImportPersistResult =
  /** No server feed attached — IndexedDB autosave genuinely covers it, and the
   *  store has been marked clean. */
  | { kind: 'local' }
  /** The working-state PUT returned; saveProjectNow marked the store clean. */
  | { kind: 'saved' }
  /** If-Match conflict. Resolved by the ConflictDialog, NOT a save. Store left dirty. */
  | { kind: 'conflict' }
  /** Network / quota / 4xx. Store left dirty. */
  | { kind: 'failed'; message: string };

/**
 * Persist a feed that was just loaded into the store, and mark the editor clean
 * only if that succeeded.
 *
 * `creatingNewFeed` is for the flows where the caller is about to create the
 * project itself (MyFeedsPage / OrgSettingsPage hand ImportDialog an
 * `onComplete`): the feed has no server home yet, so there is nothing to write
 * to and we must not write to whichever project happens to still be attached.
 *
 * Every non-'saved' outcome leaves `isDirty` true. That is the whole point:
 * Save stays enabled, the unload guard stays armed, and the caller has an
 * outcome it can report honestly.
 */
export async function persistImportedFeed(
  opts: { creatingNewFeed?: boolean } = {},
): Promise<ImportPersistResult> {
  const projectId = opts.creatingNewFeed ? null : useStore.getState().activeServerProjectId;

  if (!projectId) {
    useStore.getState().markSaved();
    return { kind: 'local' };
  }

  try {
    // saveProjectNow marks the store clean itself — but only on 'saved'. A 409
    // resolves without throwing (the ConflictDialog owns resolution), so
    // "it returned" is not "it saved"; reading it as success is the same trap
    // that the version-save path had to be gated against.
    const outcome = await saveProjectNow(projectId);
    return outcome === 'saved' ? { kind: 'saved' } : { kind: 'conflict' };
  } catch (err) {
    const message = err instanceof ApiError
      ? err.message
      : (err as Error)?.message ?? 'Unknown error';
    return { kind: 'failed', message };
  }
}
