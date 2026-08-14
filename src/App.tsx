import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { SaveAsDialog } from './components/feeds/SaveAsDialog';
import { setupAutoSave, LAST_PROJECT_KEY } from './db/persistence';
import {
  loadProjectFromServer,
  resetEditorState,
} from './db/serverPersistence';
import { loadingFeed } from './store/history';
import { listProjects } from './services/projectsApi';
import { ApiError } from './services/authApi';
import { useStore } from './store';
import type { EmptyWorkingStateWarning } from './store/feedsSlice';
import { importGtfsZip, loadImportIntoStore } from './services/gtfsImport';
import { NotFoundPage } from './components/misc/NotFoundPage';
import { ConflictDialog } from './components/snapshots/ConflictDialog';
import { Banner } from './components/ui/Banner';
import { ImpersonationBanner } from './components/admin/ImpersonationBanner';
import { RtBreakageDialog } from './components/distribution/RtBreakageDialog';
import {
  captureGclidFromUrl,
  captureRefFromUrl,
  trackFeedImportFailed,
  trackFeedOpened,
  trackGateBlocked,
  trackPageview,
} from './services/trackBeacon';
import { startDevAuthBadge } from './dev/devAuth';

// Route-level code splitting. The homepage (`/`) renders the editor, so its
// shell stays eager (imported above); every other route is loaded on demand
// so its code is kept out of the initial bundle. `React.lazy` needs a default
// export, so each named page is remapped to `{ default }`.
const LoginPage = lazy(() => import('./components/auth/LoginPage').then((m) => ({ default: m.LoginPage })));
const SignupPage = lazy(() => import('./components/auth/SignupPage').then((m) => ({ default: m.SignupPage })));
const VerifyEmailPage = lazy(() => import('./components/auth/VerifyEmailPage').then((m) => ({ default: m.VerifyEmailPage })));
const MagicLinkPage = lazy(() => import('./components/auth/MagicLinkPage').then((m) => ({ default: m.MagicLinkPage })));
const ResetPasswordPage = lazy(() => import('./components/auth/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })));
const ChangeEmailPage = lazy(() => import('./components/auth/ChangeEmailPage').then((m) => ({ default: m.ChangeEmailPage })));
const AccountSettingsPage = lazy(() => import('./components/auth/AccountSettingsPage').then((m) => ({ default: m.AccountSettingsPage })));
const MyFeedsPage = lazy(() => import('./components/feeds/MyFeedsPage').then((m) => ({ default: m.MyFeedsPage })));
const AdminDashboardPage = lazy(() => import('./components/admin/AdminDashboardPage').then((m) => ({ default: m.AdminDashboardPage })));
const AdminUsersPage = lazy(() => import('./components/admin/AdminUsersPage').then((m) => ({ default: m.AdminUsersPage })));
const AdminUserDetailPage = lazy(() => import('./components/admin/AdminUserDetailPage').then((m) => ({ default: m.AdminUserDetailPage })));
const AdminOrgsPage = lazy(() => import('./components/admin/AdminOrgsPage').then((m) => ({ default: m.AdminOrgsPage })));
const AdminOrgDetailPage = lazy(() => import('./components/admin/AdminOrgDetailPage').then((m) => ({ default: m.AdminOrgDetailPage })));
const AdminAuditPage = lazy(() => import('./components/admin/AdminAuditPage').then((m) => ({ default: m.AdminAuditPage })));
const AdminEventsPage = lazy(() => import('./components/admin/AdminEventsPage').then((m) => ({ default: m.AdminEventsPage })));
const DeepLinkImportPage = lazy(() => import('./components/import-export/DeepLinkImportPage').then((m) => ({ default: m.DeepLinkImportPage })));
const OrgSettingsPage = lazy(() => import('./components/orgs/OrgSettingsPage').then((m) => ({ default: m.OrgSettingsPage })));
const AcceptInvitationPage = lazy(() => import('./components/orgs/AcceptInvitationPage').then((m) => ({ default: m.AcceptInvitationPage })));
const PricingPage = lazy(() => import('./components/billing/PricingPage').then((m) => ({ default: m.PricingPage })));
const AccountBillingPage = lazy(() => import('./components/billing/AccountBillingPage').then((m) => ({ default: m.AccountBillingPage })));
const CommunityRoot = lazy(() => import('./components/community/CommunityRoot').then((m) => ({ default: m.CommunityRoot })));
const CategoryIndex = lazy(() => import('./components/community/CategoryIndex').then((m) => ({ default: m.CategoryIndex })));
const ThreadList = lazy(() => import('./components/community/ThreadList').then((m) => ({ default: m.ThreadList })));
const ThreadView = lazy(() => import('./components/community/ThreadView').then((m) => ({ default: m.ThreadView })));
const ComposeThread = lazy(() => import('./components/community/ComposeThread').then((m) => ({ default: m.ComposeThread })));
const ProfileEditor = lazy(() => import('./components/community/ProfileEditor').then((m) => ({ default: m.ProfileEditor })));
const ProfilePage = lazy(() => import('./components/community/ProfilePage').then((m) => ({ default: m.ProfilePage })));
const DisplayNameGate = lazy(() => import('./components/community/DisplayNameGate').then((m) => ({ default: m.DisplayNameGate })));
const HelpPage = lazy(() => import('./components/help/HelpPage').then((m) => ({ default: m.HelpPage })));
const SearchResults = lazy(() => import('./components/community/SearchResults').then((m) => ({ default: m.SearchResults })));

function RouteFallback() {
  return <div className="p-8 text-warm-gray">Loading…</div>;
}

// The old tier-picker lived at /upgrade and /welcome/plan; it's been merged
// into /pricing. The Worker 301s these for full-page loads; this handles any
// in-session client-side navigation, preserving the query (?plan=, ?feature=,
// ?source=, ?ownerType=…) so checkout context carries over.
function RedirectToPricing() {
  const { search } = useLocation();
  return <Navigate to={`/pricing${search}`} replace />;
}

function PageviewTracker() {
  const location = useLocation();
  useEffect(() => {
    // Don't inflate the dashboard with admin-side navigation.
    if (location.pathname.startsWith('/admin')) return;
    trackPageview(location.pathname);
  }, [location.pathname]);
  return null;
}

// /demo pulls from the canonical published feed at feeds.gtfsx.com/svt-demo/
// rather than a bundled streamline.zip — keeps the demo in sync with the
// published Sunny Valley Transit example and matches the slug the embed
// example site uses, so /demo and /embed-demo always show the same data.
async function loadDemoFeed() {
  // Split fetch from parse so a failure records WHICH half broke. Until now a
  // /demo that never loaded was logged to console.error and nowhere else — an
  // ad click landing on a silently empty editor looked identical to a bounce.
  let file: File;
  try {
    const res = await fetch('https://feeds.gtfsx.com/svt-demo/gtfs.zip');
    if (!res.ok) throw new Error('Demo feed not found');
    const blob = await res.blob();
    file = new File([blob], 'svt-demo.zip', { type: 'application/zip' });
  } catch (e) {
    trackFeedImportFailed('demo', 'fetch');
    throw e;
  }
  let data: Awaited<ReturnType<typeof importGtfsZip>>;
  try {
    data = await importGtfsZip(file);
  } catch (e) {
    trackFeedImportFailed('demo', 'parse');
    throw e;
  }
  loadImportIntoStore(data);
  useStore.getState().setProjectName('Sunny Valley Transit');
  // Loading is not "editing" — clear the dirty flag so the beforeunload
  // prompt doesn't fire on refresh until the user actually changes something.
  useStore.getState().markSaved();
  trackFeedOpened('demo');
}

function EditorRoute({ demo = false }: { demo?: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const authChecked = useStore((s) => s.authChecked);
  const currentUser = useStore((s) => s.currentUser);
  const feedsProjects = useStore((s) => s.feedsProjects);

  // If a signed-in user lands here with stale server-backed state in the
  // store (e.g. they were just editing /feeds/<slug>, navigated back to /,
  // and the store retains projectId/projectName/data from the previous
  // ServerEditorRoute session) redirect them to the actual server route.
  // Otherwise clicking Save would open SaveAsDialog and create a duplicate
  // project — the exact scenario reported when a user saved, moved to an
  // org, then came back to "continue editing."
  useEffect(() => {
    if (demo) return;
    if (!authChecked || !currentUser) return;
    const sid = useStore.getState().projectId;
    if (!sid) return;
    const match = feedsProjects.find((p) => p.id === sid);
    if (match) {
      navigate(`/feeds/${encodeURIComponent(match.slug)}`, { replace: true });
    }
  }, [demo, authChecked, currentUser, feedsProjects, navigate]);

  useEffect(() => {
    if (demo) {
      loadDemoFeed().catch(console.error);
      // /demo is a read-only preview of the published SVT feed loaded into the
      // shared editor store. Leaving it must tear that feed back out, or its
      // geometry (route shapes, flex zones, half-drawn lines) leaks onto the
      // next feed the user opens — including a brand-new empty feed (#42).
      // loadingFeed() suppresses undo capture and clears the history stacks so
      // the teardown isn't itself undoable.
      return () => loadingFeed(() => resetEditorState());
    }
    // Refresh = fresh start. Anonymous drafts are NOT auto-restored from
    // IndexedDB on mount — the beforeunload prompt is the only line of
    // defense for unsaved work. Auto-restoring would make that warning
    // misleading ("you'll lose changes" then silently rehydrating them).
    // Old localStorage pointers from the previous auto-restore behavior
    // are cleared so a stale pointer doesn't influence anything else.
    try { localStorage.removeItem(LAST_PROJECT_KEY); } catch { /* ignored */ }
    const unsub = setupAutoSave();
    return unsub;
  }, [demo, location.pathname]);

  // After a "save → sign in" round-trip, the login redirect lands here with
  // ?save=1. Show the Save-As dialog as long as the param is present and
  // auth is hydrated; closing the dialog strips the param.
  const showSaveAs =
    authChecked &&
    !!currentUser &&
    searchParams.get('save') === '1';

  const dismissSaveAs = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('save');
    setSearchParams(next, { replace: true });
  };

  return (
    <>
      <AppShell />
      {showSaveAs && <SaveAsDialog onClose={dismissSaveAs} />}
    </>
  );
}

function ServerEditorRoute() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const authChecked = useStore((s) => s.authChecked);
  const currentUser = useStore((s) => s.currentUser);
  const setActiveServerProject = useStore((s) => s.setActiveServerProject);
  const feedsProjects = useStore((s) => s.feedsProjects);
  const setFeedsProjects = useStore((s) => s.setFeedsProjects);
  const restoredBanner = useStore((s) => s.restoredBanner);
  const setRestoredBanner = useStore((s) => s.setRestoredBanner);
  // Set by loadProjectFromServer when this feed opened to a blank canvas that
  // it should NOT have (saved versions exist, or the working-state blob is
  // gone). A brand-new feed never sets it — see feedsSlice.
  const emptyWorkingState = useStore((s) => s.emptyWorkingState);

  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A locked feed opens as a detached draft (issue #36): edits are allowed but
  // it's never attached as the active cloud project, so autosave-to-cloud stays
  // off and Save routes to Save As. We track it just to show the banner.
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    if (!authChecked) return;
    if (!currentUser) {
      // A sign-in wall, not a paywall — invisible in the funnel until now.
      trackGateBlocked('feeds_signin');
      navigate(`/login?next=${encodeURIComponent(`/feeds/${slug ?? ''}`)}`, { replace: true });
      return;
    }
    let cancelled = false;
    let localUnsub: (() => void) | null = null;
    setLocked(false);
    const resolveAndLoad = async () => {
      try {
        let proj = feedsProjects.find((p) => p.slug === slug);
        if (!proj) {
          // Slugs are unique per workspace, not globally — try the active
          // workspace first, then fall back to personal so a direct URL
          // hit (e.g. shared link) still resolves when the user lands in
          // a workspace that doesn't own the slug.
          const ws = useStore.getState().activeWorkspace;
          const primaryScope = ws.type === 'org' ? `org:${ws.orgId}` : 'personal';
          const tries = primaryScope === 'personal' ? ['personal'] : [primaryScope, 'personal'];
          for (const scope of tries) {
            const res = await listProjects({ includeArchived: true, scope });
            setFeedsProjects(res.projects, res.quota.warning);
            proj = res.projects.find((p) => p.slug === slug);
            if (proj) break;
          }
        }
        if (cancelled) return;
        if (!proj) {
          setError('Feed not found');
          return;
        }
        setProjectId(proj.id);
        setLocked(proj.locked);
        // A locked feed opens as a detached draft: load its working state but
        // do NOT attach it as the active cloud project. With
        // activeServerProjectId left null, autosave-to-cloud is off (it falls
        // back to the local IndexedDB draft) and TopBar's Save routes to the
        // Save-As dialog — exactly the "behaves like an imported feed" rule.
        if (!proj.locked) {
          setActiveServerProject(proj.id);
        }
        // Set project metadata in the store BEFORE loading the snapshot,
        // so the markSaved() at the end of the snapshot apply also covers
        // the name/id assignment. Setting them after would re-mark dirty.
        useStore.getState().setProjectName(proj.name);
        useStore.getState().setProjectId(proj.id);
        await loadProjectFromServer(proj.id);
        if (cancelled) return;
        // Keeps the funnel denominator honest: an editor session that opened a
        // saved cloud feed did get a feed in front of the user, so it must not
        // be counted alongside "opened the editor and saw nothing".
        //
        // Except when it DIDN'T get a feed in front of them. Opening to a blank
        // canvas that should have had content is a failure, and counting it as
        // feed_opened is how 16 broken feeds stayed invisible in the funnel for
        // three weeks. `saved_project:missing` is real data loss;
        // `saved_project:empty` is content stranded in a version.
        const emptied = useStore.getState().emptyWorkingState;
        if (emptied) {
          trackFeedImportFailed(
            'saved_project',
            emptied.reason === 'blob_missing' ? 'missing' : 'empty',
          );
        } else {
          trackFeedOpened('saved_project');
        }
        localUnsub = setupAutoSave();
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof ApiError ? err.message : 'Could not load feed';
        setError(msg);
      }
    };
    resolveAndLoad();
    return () => {
      cancelled = true;
      if (localUnsub) localUnsub();
      setActiveServerProject(null);
      setRestoredBanner(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, authChecked, currentUser]);

  if (!authChecked) {
    return <div className="p-8 text-warm-gray">Loading…</div>;
  }
  if (error) {
    return (
      <div className="p-8">
        <div className="max-w-xl mx-auto bg-white border border-sand rounded-2xl p-6">
          <h2 className="font-heading font-bold text-lg text-dark-brown mb-2">Couldn't open feed</h2>
          <p className="text-sm text-warm-gray mb-4">{error}</p>
          <button
            onClick={() => navigate('/feeds')}
            className="px-4 py-2 rounded-lg bg-coral text-white font-heading font-bold text-sm hover:bg-[#d4603a]"
          >
            Back to My Feeds
          </button>
        </div>
      </div>
    );
  }

  // Full-viewport flex column: banners are non-shrinking rows at the top and
  // AppShell takes the remaining height. This keeps any top banner inside the
  // viewport instead of pushing AppShell (and its bottom panel) off-screen.
  return (
    <div className="h-full flex flex-col">
      {locked && (
        <Banner variant="warning" icon="🔒">
          Locked — changes won't be saved here. Use <strong>Save As</strong> to fork
          this feed, or unlock it from the feed list to edit.
        </Banner>
      )}
      {restoredBanner && (
        <Banner variant="info" onDismiss={() => setRestoredBanner(null)}>
          {restoredBanner}
        </Banner>
      )}
      {emptyWorkingState && <EmptyWorkingStateBanner warning={emptyWorkingState} />}
      <div className="flex-1 min-h-0">
        <AppShell />
      </div>
      {/* ConflictDialog is only relevant for cloud-attached projects; a locked
          feed is a detached draft (no active server project, no autosave-to-cloud)
          so there's no working-state version to conflict on. */}
      {projectId && !locked && <ConflictDialog projectId={projectId} />}
    </div>
  );
}

/**
 * The feed opened, and there is nothing on the canvas that should be there.
 *
 * Deliberately NOT dismissible: the whole failure mode is that this state was
 * silent — the editor applied `{}`, showed a blank map, and fired
 * feed_opened('saved_project') as if it had worked. The banner clears itself
 * when the state stops being true (a version is restored, or the feed is saved
 * with content), not when the user waves it away.
 */
function EmptyWorkingStateBanner({ warning }: { warning: EmptyWorkingStateWarning }) {
  const setBottomPanelTab = useStore((s) => s.setBottomPanelTab);
  const setBottomPanelOpen = useStore((s) => s.setBottomPanelOpen);
  const { snapshotCount, reason } = warning;
  const openVersions = () => {
    setBottomPanelTab('snapshots');
    setBottomPanelOpen(true);
  };
  return (
    <Banner
      variant={reason === 'blob_missing' ? 'alert' : 'warning'}
      icon={reason === 'blob_missing' ? '⚠️' : '📄'}
      actions={
        snapshotCount > 0 ? (
          <button
            onClick={openVersions}
            className="shrink-0 text-xs font-semibold px-3 py-1 rounded-md bg-white/70 hover:bg-white border border-current/20 whitespace-nowrap"
          >
            Open version history
          </button>
        ) : undefined
      }
    >
      {reason === 'blob_missing' ? (
        <>
          <strong>This feed's saved data could not be loaded.</strong> The editor is showing an
          empty feed — that is not your feed.{' '}
          {snapshotCount > 0
            ? `Restore one of the ${snapshotCount} saved version${snapshotCount === 1 ? '' : 's'} instead of editing here.`
            : 'Please contact support before making any changes here.'}
        </>
      ) : (
        <>
          <strong>This feed's live state is empty</strong> — but it has {snapshotCount} saved
          version{snapshotCount === 1 ? '' : 's'}. Your work is most likely in one of them;
          restore it rather than starting over.
        </>
      )}
    </Banner>
  );
}

function App() {
  useEffect(() => {
    useStore.getState().hydrateAuth().catch(() => {});
    captureRefFromUrl();
    captureGclidFromUrl();
    // Persistent "DEV AUTH" badge when the local dev auth switch is on. Returns
    // a no-op in every production build (the module is compiled out) and
    // whenever VITE_DEV_AUTH is unset.
    return startDevAuthBadge(useStore);
  }, []);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // Warn only on genuinely unsaved work. Variants now persist with the
      // project (#66 redesign) and survive reload, so their mere existence is
      // NOT a reason to warn; unsaved variant edits (and fork/switch/delete/
      // rebaseline) mark the editor dirty, so isDirty already covers them.
      if (!useStore.getState().isDirty) return;
      e.preventDefault();
      // Most modern browsers ignore the message and show a generic prompt,
      // but assigning returnValue is what triggers the prompt at all.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  return (
    <BrowserRouter>
      <ImpersonationBanner />
      <PageviewTracker />
      <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<EditorRoute />} />
        <Route path="/editor" element={<EditorRoute />} />
        <Route path="/demo" element={<EditorRoute demo />} />
        <Route path="/import" element={<DeepLinkImportPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/magic-link" element={<MagicLinkPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/change-email" element={<ChangeEmailPage />} />
        <Route path="/account" element={<AccountSettingsPage />} />
        <Route path="/account/billing" element={<AccountBillingPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="/welcome/plan" element={<RedirectToPricing />} />
        <Route path="/upgrade" element={<RedirectToPricing />} />
        <Route path="/feeds" element={<MyFeedsPage />} />
        <Route path="/feeds/:slug" element={<ServerEditorRoute />} />
        <Route path="/feeds/*" element={<Navigate to="/feeds" replace />} />
        <Route path="/orgs/accept" element={<AcceptInvitationPage />} />
        {/* /orgs/:slug/billing → same page as /orgs/:slug, scrolled to the
            billing section. Kept alive so Stripe portal returnUrl + the
            checkout success_url + the worker's /api/billing/portal route
            keep landing on a valid URL. */}
        <Route path="/orgs/:slug/billing" element={<OrgSettingsPage />} />
        <Route path="/orgs/:slug" element={<OrgSettingsPage />} />
        <Route path="/admin" element={<AdminDashboardPage />} />
        <Route path="/admin/users" element={<AdminUsersPage />} />
        <Route path="/admin/users/:id" element={<AdminUserDetailPage />} />
        <Route path="/admin/orgs" element={<AdminOrgsPage />} />
        <Route path="/admin/orgs/:id" element={<AdminOrgDetailPage />} />
        <Route path="/admin/audit" element={<AdminAuditPage />} />
        <Route path="/admin/events" element={<AdminEventsPage />} />
        <Route path="/community" element={<CommunityRoot><DisplayNameGate><CategoryIndex /></DisplayNameGate></CommunityRoot>} />
        <Route path="/community/search" element={<CommunityRoot><SearchResults /></CommunityRoot>} />
        <Route path="/community/new" element={<CommunityRoot><DisplayNameGate><ComposeThread /></DisplayNameGate></CommunityRoot>} />
        <Route path="/community/profile" element={<CommunityRoot><DisplayNameGate><ProfileEditor /></DisplayNameGate></CommunityRoot>} />
        <Route path="/community/u/:userId" element={<CommunityRoot><ProfilePage /></CommunityRoot>} />
        <Route path="/community/:catId" element={<CommunityRoot><DisplayNameGate><ThreadList /></DisplayNameGate></CommunityRoot>} />
        <Route path="/community/:catId/:threadKey" element={<CommunityRoot><DisplayNameGate><ThreadView /></DisplayNameGate></CommunityRoot>} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      </Suspense>
      {/* Global RT-breakage dialog — listens for `gb:rt-breakage` events from
          the PublishPanel and confirms before publishing a snapshot that would
          break the project's registered GTFS-RT feed. */}
      <RtBreakageDialog />
    </BrowserRouter>
  );
}

export default App;
