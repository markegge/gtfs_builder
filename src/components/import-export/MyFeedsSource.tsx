import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { ApiError } from '../../services/authApi';
import { listMyFeeds, type MyFeedItem } from '../../services/myFeedsImport';

interface Props {
  /** Resolve + import the selected feed. Throws to surface an inline error. */
  onSelect: (feed: MyFeedItem) => Promise<void>;
}

function fmtDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Importer source that lists EVERY feed the signed-in account can access — its
 * own + each org's, published or draft — and hands a selected feed off to the
 * shared ImportDialog picker → merge pipeline. The selected feed is resolved
 * from its live working state (latest edits), so drafts are importable too.
 * Org-scoped: feeds are listed per workspace (personal or a specific org), and
 * the server only returns feeds the caller can access.
 */
export function MyFeedsSource({ onSelect }: Props) {
  const activeWorkspace = useStore((s) => s.activeWorkspace);
  const userOrgs = useStore((s) => s.userOrgs);

  // Workspace options: personal + every org the user belongs to. The user can
  // import from any of their workspaces, defaulting to the active one.
  const options = useMemo(() => {
    const opts: { value: string; label: string }[] = [
      { value: 'personal', label: 'My personal feeds' },
    ];
    for (const org of userOrgs) opts.push({ value: `org:${org.id}`, label: org.name });
    return opts;
  }, [userOrgs]);

  const defaultScope =
    activeWorkspace.type === 'org' ? `org:${activeWorkspace.orgId}` : 'personal';
  const [scope, setScope] = useState(defaultScope);

  const [feeds, setFeeds] = useState<MyFeedItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [importingId, setImportingId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const load = useCallback(async (s: string) => {
    setLoading(true);
    setError(null);
    setFeeds(null);
    try {
      setFeeds(await listMyFeeds(s));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load your feeds.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(scope);
  }, [scope, load]);

  const handleImport = async (feed: MyFeedItem) => {
    setImportError(null);
    setImportingId(feed.id);
    try {
      await onSelect(feed);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setImportingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {options.length > 1 && (
        <label className="flex items-center gap-2 text-sm text-warm-gray">
          <span className="shrink-0">Workspace</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            disabled={loading || importingId !== null}
            className="flex-1 px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white text-dark-brown focus:outline-none focus:border-coral disabled:opacity-50"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
      )}
      {importError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{importError}</div>
      )}

      {loading ? (
        <div className="border border-sand rounded-lg px-3 py-6 text-center text-sm text-warm-gray">
          Loading your feeds…
        </div>
      ) : feeds && (
        <div className="border border-sand rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-cream text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
            {feeds.length} feed{feeds.length === 1 ? '' : 's'}
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-sand">
            {feeds.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-warm-gray">
                No feeds in this workspace yet.
              </div>
            ) : (
              feeds.map((feed) => {
                const isImporting = importingId === feed.id;
                // About a quarter of a typical account's feeds have nothing in
                // them, and the server sorts never-saved feeds to the TOP of
                // this list (a null working_state_updated_at falls back to
                // creation time) — so the entries a user reaches for first were
                // precisely the ones that could only ever fail.
                //
                // Only 'empty' (no working state at all) is blocked: that one is
                // certain, because the fetch is guaranteed to 404. 'likely-empty'
                // is a size heuristic and gzip makes it fallible — a real
                // 12-route feed can compress below the empty shell — so it only
                // ever annotates. Never disable on a guess.
                const disabled = importingId !== null || feed.content === 'empty';
                return (
                  <button
                    key={feed.id}
                    type="button"
                    onClick={() => handleImport(feed)}
                    disabled={disabled}
                    title={
                      feed.content === 'empty'
                        ? 'This feed has nothing saved in it yet — nothing to import'
                        : feed.content === 'likely-empty'
                          ? 'This feed looks empty, but you can still try importing from it'
                          : 'Import routes/stops from this feed'
                    }
                    className={`w-full text-left block select-none px-3 py-2.5 transition-colors ${
                      disabled ? 'opacity-60 cursor-not-allowed' : 'hover:bg-cream'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <span className="block text-sm font-semibold text-dark-brown truncate">{feed.name}</span>
                        <div className="text-[11px] text-warm-gray flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-0.5">
                          <span className="font-mono">{feed.slug}</span>
                          {feed.updatedAt > 0 && <span>· updated {fmtDate(feed.updatedAt)}</span>}
                          <span className={feed.published ? 'text-teal-700' : 'text-amber-600'}>
                            · {feed.published ? 'published' : 'draft'}
                          </span>
                        </div>
                      </div>
                      <span
                        className={`text-xs font-semibold whitespace-nowrap pt-0.5 ${
                          feed.content === 'ok' ? 'text-coral' : 'text-warm-gray'
                        }`}
                      >
                        {feed.content === 'empty'
                          ? 'empty — nothing to import'
                          : isImporting
                            ? 'Loading…'
                            : feed.content === 'likely-empty'
                              ? 'looks empty · Import →'
                              : 'Import →'}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      <p className="text-[10px] text-warm-gray/80">
        Imports routes and stops from any of your feeds (published or draft), pulled from
        the latest saved edits. Your current project stays open; choose which routes to bring in.
      </p>
    </div>
  );
}
