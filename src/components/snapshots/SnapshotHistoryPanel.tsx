import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../store';
import { AuthButton } from '../auth/AuthButton';
import { FormField } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Badge } from '../ui/Badge';
import {
  deleteSnapshot,
  listSnapshots,
  restoreSnapshot,
  type ProjectSnapshot,
} from '../../services/projectsApi';
import { ApiError } from '../../services/authApi';
import { loadProjectFromServer } from '../../db/serverPersistence';
import { saveVersionWithWorkingState } from '../../services/versionSave';

function formatDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function SnapshotHistoryPanel() {
  const projectId = useStore((s) => s.activeServerProjectId);
  const snapshotList = useStore((s) => s.snapshotList);
  const setSnapshotList = useStore((s) => s.setSnapshotList);
  const setRestoredBanner = useStore((s) => s.setRestoredBanner);
  const emptyWorkingState = useStore((s) => s.emptyWorkingState);
  // Nothing a user would recognise as their feed. Paired with emptyWorkingState
  // this is the "you're looking at the recoverable blank canvas" condition —
  // saving a version here would capture the blank canvas AND (now that a
  // version save writes the working state too) cement it over the live feed.
  const storeIsEmpty = useStore(
    (s) => s.routes.length === 0 && s.stops.length === 0 && s.trips.length === 0,
  );

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSave, setShowSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<ProjectSnapshot | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectSnapshot | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await listSnapshots(projectId);
      setSnapshotList(res.snapshots);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not load snapshots';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [projectId, setSnapshotList]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!projectId) {
    return (
      <div className="p-4 text-sm text-warm-gray">
        Snapshots are only available for feeds saved to your account.
      </div>
    );
  }

  // Saves the LIVE FEED first, then the version — see services/versionSave.ts
  // for why that order is the fix and not an implementation detail.
  const handleSaveSnapshot = async (label: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await saveVersionWithWorkingState(projectId, label);
      if (!result.ok) {
        // The working state hit an If-Match conflict, so no version was
        // written. The ConflictDialog is already up; don't claim a save.
        setError(
          'This feed changed somewhere else, so nothing was saved. ' +
            'Resolve the conflict above, then save the version again.',
        );
        return;
      }
      setShowSave(false);
      await refresh();
    } catch (err) {
      // Not just ApiError: versionSave throws a plain Error for "the feed saved
      // but the version didn't", and that distinction is the whole point.
      setError((err as Error)?.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async (snapshot: ProjectSnapshot) => {
    setBusy(true);
    setError(null);
    try {
      await restoreSnapshot(projectId, snapshot.id);
      await loadProjectFromServer(projectId);
      setRestoreTarget(null);
      setRestoredBanner(
        `Snapshot ${snapshot.label ? `"${snapshot.label}"` : snapshot.id.slice(0, 8)} restored — local changes have been replaced.`,
      );
      await refresh();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Restore failed';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (snapshot: ProjectSnapshot) => {
    setBusy(true);
    setError(null);
    try {
      await deleteSnapshot(projectId, snapshot.id);
      setDeleteTarget(null);
      await refresh();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Delete failed';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-4 py-2 border-b border-sand">
        <div className="text-sm font-heading font-semibold text-dark-brown">Saved snapshots</div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className="text-xs text-warm-gray hover:text-coral disabled:opacity-50"
            title="Refresh"
          >
            Refresh
          </button>
          <AuthButton onClick={() => setShowSave(true)} disabled={busy}>
            Save snapshot
          </AuthButton>
        </div>
      </div>

      {error && (
        <div className="mx-4 my-2 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {loading && snapshotList.length === 0 ? (
          <p className="p-4 text-sm text-warm-gray">Loading…</p>
        ) : snapshotList.length === 0 ? (
          <div className="p-4 text-sm text-warm-gray">
            No saved snapshots yet. Click "Save snapshot" to capture the current feed.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-cream/80 backdrop-blur">
              <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-warm-gray">
                <th className="px-4 py-2">Label</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2">Routes</th>
                <th className="px-3 py-2">Stops</th>
                <th className="px-3 py-2">Trips</th>
                <th className="px-3 py-2">Validation</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {snapshotList.map((v) => {
                const summary = v.summary ?? {};
                return (
                  <tr key={v.id} className="border-t border-sand">
                    <td className="px-4 py-2 font-medium text-dark-brown">
                      {v.label || <span className="text-warm-gray italic">untitled</span>}
                    </td>
                    <td className="px-3 py-2 text-warm-gray whitespace-nowrap">{formatDate(v.createdAt)}</td>
                    <td className="px-3 py-2 text-dark-brown">{(summary.routeCount as number) ?? '—'}</td>
                    <td className="px-3 py-2 text-dark-brown">{(summary.stopCount as number) ?? '—'}</td>
                    <td className="px-3 py-2 text-dark-brown">{(summary.tripCount as number) ?? '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        {v.validationErrors > 0 && (
                          <Badge variant="error">{v.validationErrors} errors</Badge>
                        )}
                        {v.validationWarnings > 0 && (
                          <Badge variant="warning">{v.validationWarnings} warn</Badge>
                        )}
                        {v.validationErrors === 0 && v.validationWarnings === 0 && (
                          <Badge variant="success">Clean</Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button
                        className="text-xs text-coral hover:underline mr-3"
                        onClick={() => setRestoreTarget(v)}
                      >
                        Restore
                      </button>
                      <button
                        className="text-xs text-red-600 hover:underline"
                        onClick={() => setDeleteTarget(v)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showSave && (
        <SaveSnapshotDialog
          onSave={handleSaveSnapshot}
          onCancel={() => setShowSave(false)}
          busy={busy}
          // The dialog stays open on failure, so the failure has to be legible
          // from inside it — the panel behind is covered by the modal.
          error={error}
          // A version save now writes the working state too. On the recoverable
          // blank canvas that would capture nothing AND overwrite the live feed
          // with nothing — so say so before they press Save.
          emptyWarning={emptyWorkingState !== null && storeIsEmpty ? emptyWorkingState.snapshotCount : null}
        />
      )}

      {restoreTarget && (
        <ConfirmDialog
          title="Restore this snapshot?"
          body={`This will replace your current working draft with "${restoreTarget.label || restoreTarget.id.slice(0, 8)}". Your current draft will be lost unless you save it as a snapshot first.`}
          confirmLabel="Restore"
          onCancel={() => setRestoreTarget(null)}
          onConfirm={() => handleRestore(restoreTarget)}
          busy={busy}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete snapshot?"
          body={`"${deleteTarget.label || deleteTarget.id.slice(0, 8)}" will be permanently removed.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => handleDelete(deleteTarget)}
          busy={busy}
        />
      )}
    </div>
  );
}

function defaultSnapshotLabel(): string {
  // Locale-formatted "May 28, 2026, 8:00 AM" — sortable by date, readable
  // at a glance, and instantly meaningful for the common "I'm just
  // snapshotting today's state" workflow.
  return new Date().toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function SaveSnapshotDialog({
  onSave,
  onCancel,
  busy,
  emptyWarning,
  error,
}: {
  onSave: (label: string) => void;
  onCancel: () => void;
  busy: boolean;
  /** Version count to warn about when the editor is currently empty; null = quiet. */
  emptyWarning: number | null;
  error: string | null;
}) {
  // Default the label to today's date+time so the field is never empty —
  // user can hit Save immediately for a date-stamped snapshot, or type
  // over the pre-selected text for a custom label.
  const [label, setLabel] = useState(defaultSnapshotLabel);
  return (
    <Modal
      open
      onClose={onCancel}
      dismissable={!busy}
      maxWidthClassName="max-w-md"
      title="Save snapshot"
      description="Captures the current feed state. Snapshots are immutable once saved."
      footer={
        <>
          <AuthButton variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </AuthButton>
          <AuthButton onClick={() => onSave(label)} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </AuthButton>
        </>
      }
    >
      {emptyWarning !== null && (
        <div className="mb-4 px-3 py-2 rounded-md bg-gold-light border border-amber-200 text-amber-700 text-xs">
          This feed is currently <strong>empty</strong>, and saving also updates the live feed —
          so this would store an empty snapshot over an empty feed.{' '}
          {emptyWarning > 0 ? (
            <>
              Cancel and restore one of the {emptyWarning} saved version
              {emptyWarning === 1 ? '' : 's'} below first if your work is in one of them.
            </>
          ) : (
            <>Cancel if you expected this feed to have content.</>
          )}
        </div>
      )}
      <FormField
        label="Label"
        value={label}
        onChange={setLabel}
        placeholder="e.g. March 2026 service change"
        autoFocus
      />
      {error && (
        <div className="mt-4 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
          {error}
        </div>
      )}
    </Modal>
  );
}
