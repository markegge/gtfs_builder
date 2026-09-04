import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { patchProject, getEmbedImpressions, type EmbedImpressions } from '../../services/projectsApi';
import { ApiError } from '../../services/authApi';
import {
  fetchEmbedServiceProfiles,
  type EmbedServiceProfile,
} from '../../services/embedServicesApi';
import {
  DEFAULT_EMBED_OPTIONS,
  optionsQuery,
  servicePinApplies,
  type EmbedOptions,
} from './embedOptions';

const FEEDS_ORIGIN =
  (import.meta.env.VITE_FEEDS_ORIGIN as string | undefined) ||
  (typeof window !== 'undefined' && window.location.hostname.startsWith('staging.')
    ? 'https://staging-feeds.gtfsx.com'
    : 'https://feeds.gtfsx.com');

interface PublicationInfo {
  slug: string;
  snapshotId: string;
}

/**
 * "Embed" tab in the bottom panel. Lets the agency copy iframe snippets
 * for the system map and per-route embeds. Only visible after a feed is
 * published — embeds read from the canonical published snapshot.
 */
// Per-embed theming/language/service options live in ./embedOptions so the
// query builder can be unit-tested away from React.

const LANG_CHOICES: { code: string; label: string }[] = [
  { code: '', label: 'Feed default' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
];

/**
 * Load the published feed's service profiles. Keyed on the snapshot id as well
 * as the slug so republishing refetches — the ids are derived from the
 * published calendars, and a republish can add, drop or re-key a profile.
 */
function useServiceProfiles(slug: string | null, snapshotId: string | null) {
  const [profiles, setProfiles] = useState<EmbedServiceProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug || !snapshotId) return;
    const ctrl = new AbortController();
    setProfiles(null);
    setError(null);
    (async () => {
      try {
        const list = await fetchEmbedServiceProfiles(FEEDS_ORIGIN, slug, ctrl.signal);
        if (!ctrl.signal.aborted) setProfiles(list);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Could not load service patterns');
        setProfiles([]);
      }
    })();
    return () => ctrl.abort();
  }, [slug, snapshotId]);

  return { profiles, error };
}

export function EmbedPanel() {
  const routes = useStore((s) => s.routes);
  const currentPublication = useStore((s) => s.currentPublication);
  const feedsProjects = useStore((s) => s.feedsProjects);
  const activeServerProjectId = useStore((s) => s.activeServerProjectId);

  const [options, setOptions] = useState<EmbedOptions>(DEFAULT_EMBED_OPTIONS);

  const project = activeServerProjectId
    ? feedsProjects.find((p) => p.id === activeServerProjectId)
    : null;

  const pub: PublicationInfo | null =
    project && currentPublication ? { slug: project.slug, snapshotId: currentPublication.snapshotId } : null;

  const { profiles, error: profilesError } = useServiceProfiles(
    pub?.slug ?? null,
    pub?.snapshotId ?? null,
  );

  // A republish can drop or re-key a profile (editing calendar.txt's dates
  // changes the id). Fall back to Automatic visibly rather than leaving a
  // selection that resolves to nothing.
  const pinnedStillExists =
    !options.service || !profiles || profiles.some((p) => p.id === options.service);
  useEffect(() => {
    if (!pinnedStillExists) setOptions((o) => ({ ...o, service: '' }));
  }, [pinnedStillExists]);

  if (!pub || !project) {
    return (
      <div className="p-6 text-sm text-warm-gray">
        Publish this feed first to get embeddable links. Once published, the system map and
        per-route widgets are available at{' '}
        <code className="text-coral">{FEEDS_ORIGIN}/&lt;slug&gt;/embed/...</code>.
      </div>
    );
  }

  // The system map has no service-day concept, so its snippet never carries a
  // `service` param (see optionsQuery's `includeService`).
  const systemMapQuery = optionsQuery(options);
  // A pinned profile only applies to routes that actually run it; RouteSnippets
  // and WidgetsSection decide per route.
  const pinned = options.service ? profiles?.find((p) => p.id === options.service) ?? null : null;

  return (
    <div className="overflow-y-auto p-6 space-y-6">
      <BrandColorSection projectId={project.id} initialColor={project.brandPrimaryColor ?? null} />
      <ThemeSection options={options} onChange={setOptions} />
      <ServiceSection
        profiles={profiles}
        error={profilesError}
        options={options}
        onChange={setOptions}
      />
      <SystemMapSnippet slug={pub.slug} query={systemMapQuery} />
      <RouteSnippets slug={pub.slug} routes={routes} options={options} pinned={pinned} />
      <WidgetsSection slug={pub.slug} routes={routes} options={options} pinned={pinned} />
      <JsonApiSection slug={pub.slug} />
      <ImpressionsSection projectId={project.id} />
    </div>
  );
}

/**
 * `" on Jun 7, 2026"` for a YYYYMMDD end date, or `''` when the feed left it
 * blank — so the caller reads "ended" rather than "ended on Invalid Date".
 * The year is carried, unlike the tab labels' short form: whether a pattern
 * ended in June or last June is the whole question here.
 */
function endedOn(ymd: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd);
  if (!m) return '';
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
  return ` on ${formatted}`;
}

/**
 * Service-pattern picker. Its own section rather than part of "Theme &
 * language" — pinning a schedule is a content choice, not a cosmetic one.
 *
 * The options come from the published snapshot's `/api/v1/services`, which is
 * also where the embed pages resolve `?service=` from. Before this existed the
 * profile id was surfaced nowhere in the product: an agency had to open the
 * live embed, click a service-day tab, and copy the id out of the address bar.
 */
function ServiceSection({
  profiles,
  error,
  options,
  onChange,
}: {
  profiles: EmbedServiceProfile[] | null;
  error: string | null;
  options: EmbedOptions;
  onChange: (o: EmbedOptions) => void;
}) {
  const pinnedExpired =
    profiles?.find((p) => p.id === options.service && p.expired) ?? null;
  return (
    <section>
      <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">Service pattern</h3>
      <p className="text-xs text-warm-gray mb-3">
        Per-route embeds open on today’s service by default. Pin one here to always show a
        particular schedule — a Saturday timetable on a weekend-service page, say, or a
        seasonal pattern. Riders can still switch tabs.
      </p>
      <p className="text-xs text-warm-gray mb-3">
        Patterns whose dates have already ended are hidden from riders, so a discontinued
        seasonal schedule stops showing up on your site by itself. They stay listed here,
        marked — pin one and the embed will show it, with an “ended” notice.
      </p>
      {error ? (
        <p className="text-xs text-red-600">{error}</p>
      ) : profiles === null ? (
        <p className="text-xs text-warm-gray">Loading service patterns…</p>
      ) : profiles.length === 0 ? (
        <p className="text-xs text-warm-gray">
          This feed’s published snapshot has no <code className="text-coral">calendar.txt</code>{' '}
          service patterns, so there’s nothing to pin.
        </p>
      ) : (
        <>
          <label className="flex flex-col gap-1 max-w-xs">
            <span className="text-[11px] font-heading font-semibold text-brown">
              Service shown in copied embeds
            </span>
            <select
              value={options.service}
              onChange={(e) => onChange({ ...options, service: e.target.value })}
              className="px-2 py-1.5 rounded-md border border-sand text-sm focus:outline-none focus:border-coral"
            >
              <option value="">Automatic (today’s service)</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.expired ? `${p.label} — ended${endedOn(p.endDate)}` : p.label}
                </option>
              ))}
            </select>
          </label>
          {pinnedExpired ? (
            <p className="text-[11px] text-amber-700 mt-2">
              This pattern ended{endedOn(pinnedExpired.endDate)}. Embeds pinned to it still show
              its timetable, with a notice telling riders the service is over.
            </p>
          ) : null}
          <p className="text-[11px] text-warm-gray mt-2">
            These patterns come from your published feed. Republish after changing{' '}
            <code className="text-coral">calendar.txt</code> so the pinned id keeps matching.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Per-embed theming + language controls. These layer on top of the saved brand
 * color via URL params (accent / theme / font / lang) and are baked into every
 * copyable snippet below, so the agency previews + ships exactly what it picks.
 */
function ThemeSection({
  options,
  onChange,
}: {
  options: EmbedOptions;
  onChange: (o: EmbedOptions) => void;
}) {
  const set = <K extends keyof EmbedOptions>(key: K, val: EmbedOptions[K]) =>
    onChange({ ...options, [key]: val });

  return (
    <section>
      <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">Theme &amp; language</h3>
      <p className="text-xs text-warm-gray mb-3">
        Customize how the copied embeds look and read. These apply per embed via URL
        params — they don’t change your saved brand color, and each variant is cached
        separately at the edge.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-heading font-semibold text-brown">Accent override</span>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={`#${options.accent || 'e8734a'}`}
              onChange={(e) => set('accent', e.target.value.replace(/^#/, '').toLowerCase())}
              className="w-8 h-8 rounded border border-sand cursor-pointer"
              aria-label="Embed accent color"
            />
            {options.accent ? (
              <button
                type="button"
                onClick={() => set('accent', '')}
                className="text-[11px] text-warm-gray hover:text-coral underline"
              >
                clear
              </button>
            ) : (
              <span className="text-[11px] text-warm-gray">using brand</span>
            )}
          </div>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-heading font-semibold text-brown">Color scheme</span>
          <select
            value={options.mode}
            onChange={(e) => set('mode', e.target.value as EmbedOptions['mode'])}
            className="px-2 py-1.5 rounded-md border border-sand text-sm focus:outline-none focus:border-coral"
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-heading font-semibold text-brown">Font</span>
          <select
            value={options.font}
            onChange={(e) => set('font', e.target.value as EmbedOptions['font'])}
            className="px-2 py-1.5 rounded-md border border-sand text-sm focus:outline-none focus:border-coral"
          >
            <option value="system">System</option>
            <option value="serif">Serif</option>
            <option value="mono">Monospace</option>
            <option value="rounded">Rounded</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-heading font-semibold text-brown">Language</span>
          <select
            value={options.lang}
            onChange={(e) => set('lang', e.target.value)}
            className="px-2 py-1.5 rounded-md border border-sand text-sm focus:outline-none focus:border-coral"
          >
            {LANG_CHOICES.map((l) => (
              <option key={l.code || 'default'} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-[11px] text-warm-gray mt-2">
        Language localizes the embed interface (banners, headings, accessibility labels).
        Route and stop names always come straight from your feed.
      </p>
    </section>
  );
}

function BrandColorSection({
  projectId,
  initialColor,
}: {
  projectId: string;
  initialColor: string | null;
}) {
  const upsertFeedProject = useStore((s) => s.upsertFeedProject);
  const [color, setColor] = useState<string>(initialColor ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    setColor(initialColor ?? '');
  }, [initialColor]);

  const valid = color === '' || /^[0-9a-fA-F]{6}$/.test(color);
  const dirty = (color || null) !== (initialColor || null);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      const updated = await patchProject(projectId, {
        brandPrimaryColor: color === '' ? null : color.toLowerCase(),
      });
      upsertFeedProject(updated);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1600);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">Brand color</h3>
      <p className="text-xs text-warm-gray mb-2">
        Hex color used for the active service-day tab and accent links on every embed page.
        Leave blank to use the default coral.
      </p>
      <div className="flex items-center gap-3">
        <input
          type="color"
          value={`#${color || 'e8734a'}`}
          onChange={(e) => setColor(e.target.value.replace(/^#/, '').toLowerCase())}
          className="w-10 h-10 rounded-md border border-sand cursor-pointer"
          aria-label="Brand color picker"
        />
        <div className="flex items-center gap-1 font-mono text-sm">
          <span className="text-warm-gray">#</span>
          <input
            type="text"
            value={color}
            onChange={(e) => setColor(e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6))}
            placeholder="e8734a"
            className={`w-24 px-2 py-1 rounded-md border ${
              valid ? 'border-sand' : 'border-red-400'
            } focus:outline-none focus:border-coral text-sm`}
          />
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={!valid || !dirty || saving}
          className="px-3 py-1.5 rounded-md text-xs font-heading font-bold bg-coral text-white hover:bg-[#d4603a] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : savedFlash ? 'Saved' : 'Save'}
        </button>
        {color === '' ? null : (
          <button
            type="button"
            onClick={() => setColor('')}
            disabled={saving}
            className="text-xs text-warm-gray hover:text-coral underline"
          >
            Reset to default
          </button>
        )}
      </div>
      {error && (
        <div className="mt-2 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
          {error}
        </div>
      )}
    </section>
  );
}

function SystemMapSnippet({ slug, query }: { slug: string; query: string }) {
  const url = `${FEEDS_ORIGIN}/${encodeURIComponent(slug)}/embed/system-map${query}`;
  return (
    <section>
      <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">System map</h3>
      <p className="text-xs text-warm-gray mb-2">
        An interactive map of every route + a clickable list of routes.
      </p>
      <CopyableSnippet
        label="iframe"
        snippet={`<iframe src="${url}" width="100%" height="700" frameborder="0" loading="lazy" title="Transit system map"></iframe>`}
      />
      <PreviewLink url={url} />
    </section>
  );
}

function RouteSnippets({
  slug,
  routes,
  options,
  pinned,
}: {
  slug: string;
  routes: { route_id: string; route_short_name: string; route_long_name: string; route_color: string; route_text_color: string }[];
  options: EmbedOptions;
  pinned: EmbedServiceProfile | null;
}) {
  const sorted = useMemo(
    () =>
      routes.slice().sort((a, b) => {
        const an = a.route_short_name || a.route_id;
        const bn = b.route_short_name || b.route_id;
        return an.localeCompare(bn, undefined, { numeric: true });
      }),
    [routes],
  );

  if (sorted.length === 0) {
    return (
      <section>
        <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">Per-route embeds</h3>
        <p className="text-xs text-warm-gray">No routes defined yet.</p>
      </section>
    );
  }

  return (
    <section>
      <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">Per-route embeds</h3>
      <p className="text-xs text-warm-gray mb-2">
        One iframe per route. Includes the route map, schedule table, and a service-day selector
        (defaults to today unless you pin a service pattern above).
      </p>
      <div className="space-y-3">
        {sorted.map((r) => {
          // A pin only means something on routes that actually run it. Emitting
          // it elsewhere would produce a snippet that reads as pinned while the
          // embed quietly falls back to today's service.
          const pinApplies = servicePinApplies(pinned, r.route_id);
          const url = `${FEEDS_ORIGIN}/${encodeURIComponent(slug)}/embed/route/${encodeURIComponent(r.route_id)}${optionsQuery(options, { includeService: pinApplies })}`;
          return (
            <div key={r.route_id} className="border border-sand rounded-lg p-3">
              <div className="flex items-center gap-3 mb-2">
                <span
                  className="inline-block px-2 py-0.5 rounded text-xs font-bold"
                  style={{
                    background: `#${r.route_color || 'cccccc'}`,
                    color: `#${r.route_text_color || '000000'}`,
                  }}
                >
                  {r.route_short_name || r.route_id}
                </span>
                <span className="text-sm text-dark-brown font-medium">{r.route_long_name}</span>
              </div>
              <CopyableSnippet
                label="iframe"
                snippet={`<iframe src="${url}" width="100%" height="700" frameborder="0" loading="lazy" title="${escapeAttr(r.route_long_name || r.route_short_name || r.route_id)}"></iframe>`}
              />
              {pinned && !pinApplies && (
                <p className="text-[11px] text-warm-gray mt-1">
                  No {pinned.label} trips on this route — this snippet uses the automatic service.
                </p>
              )}
              <PreviewLink url={url} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Web-component (widgets.js) section. The declarative loader lets a developer
 * drop <gtfs-route-map> / <gtfs-schedule> / <gtfs-system-map> / <gtfs-stop>
 * tags straight into their CMS/HTML instead of hand-writing iframe markup —
 * each tag wraps the matching embed page. One <script> include covers them all.
 */
function WidgetsSection({
  slug,
  routes,
  options,
  pinned,
}: {
  slug: string;
  routes: { route_id: string; route_short_name: string; route_long_name: string }[];
  options: EmbedOptions;
  pinned: EmbedServiceProfile | null;
}) {
  const scriptTag = `<script src="${FEEDS_ORIGIN}/widgets.js" defer></script>`;
  // Theme/language attributes mirror the page params; only emit the non-default
  // ones so the example tags stay clean.
  const themeAttrs =
    (options.accent ? ` accent="${escapeAttr(options.accent)}"` : '') +
    (options.mode !== 'light' ? ` theme="${escapeAttr(options.mode)}"` : '') +
    (options.font !== 'system' ? ` font="${escapeAttr(options.font)}"` : '') +
    (options.lang ? ` lang="${escapeAttr(options.lang)}"` : '');
  // Pick a representative route id for the example tags so the copied snippet
  // works as-is when the feed has routes.
  const sample = useMemo(() => {
    const sorted = routes.slice().sort((a, b) => {
      const an = a.route_short_name || a.route_id;
      const bn = b.route_short_name || b.route_id;
      return an.localeCompare(bn, undefined, { numeric: true });
    });
    return sorted[0]?.route_id ?? 'ROUTE_ID';
  }, [routes]);

  // `service` goes only on the two tags whose builders forward it
  // (worker/embeds/widgets.ts withService) — <gtfs-system-map> and <gtfs-stop>
  // would accept the attribute and ignore it. Suppressed when the sample route
  // doesn't run the pinned pattern, for the same reason as the iframes above.
  const serviceAttr =
    pinned && servicePinApplies(pinned, sample) ? ` service="${escapeAttr(pinned.id)}"` : '';
  const routeTagAttrs = `${themeAttrs}${serviceAttr}`;

  const slugAttr = escapeAttr(slug);
  const routeAttr = escapeAttr(sample);

  return (
    <section>
      <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">
        Web component widgets
      </h3>
      <p className="text-xs text-warm-gray mb-2">
        For developers: include the loader once, then drop these custom tags
        anywhere in your HTML — no iframe markup to maintain. Each tag renders the
        same data as the iframes above.
      </p>
      <div className="mb-3">
        <p className="text-[11px] font-heading font-semibold text-brown mb-1">
          1. Include the loader once (in your &lt;head&gt; or before &lt;/body&gt;)
        </p>
        <CopyableSnippet label="script" snippet={scriptTag} />
      </div>
      <p className="text-[11px] font-heading font-semibold text-brown mb-1">
        2. Drop in any of these tags
      </p>
      <div className="space-y-3">
        <WidgetTag
          desc="Interactive map of every route."
          snippet={`<gtfs-system-map feed="${slugAttr}"${themeAttrs}></gtfs-system-map>`}
        />
        <WidgetTag
          desc="A single route’s map."
          snippet={`<gtfs-route-map feed="${slugAttr}" route="${routeAttr}"${routeTagAttrs}></gtfs-route-map>`}
        />
        <WidgetTag
          desc="A single route’s schedule table (with service-day tabs)."
          snippet={`<gtfs-schedule feed="${slugAttr}" route="${routeAttr}"${routeTagAttrs}></gtfs-schedule>`}
        />
        <WidgetTag
          desc="Departures from one stop (replace STOP_ID)."
          snippet={`<gtfs-stop feed="${slugAttr}" stop="STOP_ID"${themeAttrs}></gtfs-stop>`}
        />
      </div>
    </section>
  );
}

/**
 * Read-only JSON API section. Surfaces the integrator API base URL plus the
 * available endpoints, mirroring the served `/<slug>/api/v1` discovery doc.
 * Like the rest of the panel this is only visible to embeds-entitled owners;
 * the endpoints themselves serve the canonical published snapshot.
 */
function JsonApiSection({ slug }: { slug: string }) {
  const base = `${FEEDS_ORIGIN}/${encodeURIComponent(slug)}/api/v1`;
  const endpoints: { method: string; path: string; desc: string }[] = [
    { method: 'GET', path: '', desc: 'Feed metadata + endpoint discovery.' },
    { method: 'GET', path: '/agencies', desc: 'All agencies.' },
    { method: 'GET', path: '/routes', desc: 'All routes (with trip counts).' },
    { method: 'GET', path: '/routes/{route_id}', desc: 'One route, its trips, and the stops it serves.' },
    { method: 'GET', path: '/stops', desc: 'All stops.' },
    { method: 'GET', path: '/stops/{stop_id}', desc: 'One stop and the routes that serve it.' },
    { method: 'GET', path: '/stops/{stop_id}/schedule', desc: 'A stop’s departures, grouped by service.' },
    { method: 'GET', path: '/services', desc: 'Service patterns and the ids the embeds accept as ?service=.' },
  ];

  return (
    <section>
      <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">JSON API</h3>
      <p className="text-xs text-warm-gray mb-2">
        For developers: a read-only REST API over this feed’s published snapshot.
        Returns JSON, CORS-open, edge-cached, and revalidated by ETag. Updates
        automatically when you republish.
      </p>
      <div className="mb-3">
        <p className="text-[11px] font-heading font-semibold text-brown mb-1">Base URL</p>
        <CopyableSnippet label="url" snippet={base} />
        <PreviewLink url={base} />
      </div>
      <p className="text-[11px] font-heading font-semibold text-brown mb-1">Endpoints</p>
      <div className="border border-sand rounded-lg overflow-hidden">
        {endpoints.map((e) => (
          <div
            key={e.path || '/'}
            className="flex items-baseline gap-2 px-3 py-2 border-b border-sand last:border-b-0"
          >
            <span className="text-[10px] font-mono font-bold text-coral shrink-0">{e.method}</span>
            <code className="text-[11px] font-mono text-dark-brown break-all">
              /api/v1{e.path}
            </code>
            <span className="text-[11px] text-warm-gray ml-auto text-right">{e.desc}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const KIND_LABELS: Record<string, string> = {
  'system-map': 'System map',
  route: 'Route map',
  schedule: 'Schedule',
  stop: 'Stop departures',
  landing: 'Mini-site',
};

/**
 * Impression counts (EM-131/135). Aggregate, privacy-respecting embed view
 * totals for this feed over the last 30 days, fetched from the owner-only
 * rollup endpoint. No PII — just counts by embed kind + top routes/stops.
 */
function ImpressionsSection({ projectId }: { projectId: string }) {
  const [data, setData] = useState<EmbedImpressions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Run async so state updates happen in callbacks (not synchronously in the
    // effect body) — re-fetches whenever projectId changes.
    (async () => {
      try {
        const d = await getEmbedImpressions(projectId, 30);
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load view counts');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const kinds = data ? Object.entries(data.by_kind).sort((a, b) => b[1] - a[1]) : [];

  return (
    <section>
      <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">Embed views</h3>
      <p className="text-xs text-warm-gray mb-2">
        Anonymous view counts for your embeds over the last 30 days. No personal data
        is collected — just totals per embed.
      </p>
      {loading ? (
        <p className="text-xs text-warm-gray">Loading…</p>
      ) : error ? (
        <p className="text-xs text-red-600">{error}</p>
      ) : !data || data.total === 0 ? (
        <p className="text-xs text-warm-gray">
          No views recorded yet. Counts appear once your embeds are loaded by visitors.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="text-2xl font-heading font-bold text-dark-brown">
            {data.total.toLocaleString()}{' '}
            <span className="text-sm font-normal text-warm-gray">total views</span>
          </div>
          <div className="border border-sand rounded-lg overflow-hidden">
            {kinds.map(([kind, views]) => (
              <div
                key={kind}
                className="flex items-baseline gap-2 px-3 py-2 border-b border-sand last:border-b-0"
              >
                <span className="text-xs text-dark-brown">{KIND_LABELS[kind] ?? kind}</span>
                <span className="text-xs font-mono text-warm-gray ml-auto">
                  {views.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
          {data.top_targets.length > 0 && (
            <div>
              <p className="text-[11px] font-heading font-semibold text-brown mb-1">
                Top routes &amp; stops
              </p>
              <div className="border border-sand rounded-lg overflow-hidden">
                {data.top_targets.slice(0, 10).map((tt) => (
                  <div
                    key={`${tt.kind}:${tt.target}`}
                    className="flex items-baseline gap-2 px-3 py-2 border-b border-sand last:border-b-0"
                  >
                    <span className="text-[10px] font-mono font-bold text-coral shrink-0">
                      {KIND_LABELS[tt.kind] ?? tt.kind}
                    </span>
                    <code className="text-[11px] font-mono text-dark-brown break-all">
                      {tt.target}
                    </code>
                    <span className="text-xs font-mono text-warm-gray ml-auto">
                      {tt.views.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function WidgetTag({ desc, snippet }: { desc: string; snippet: string }) {
  return (
    <div className="border border-sand rounded-lg p-3">
      <p className="text-xs text-warm-gray mb-2">{desc}</p>
      <CopyableSnippet label="tag" snippet={snippet} />
    </div>
  );
}

function CopyableSnippet({ snippet }: { label: string; snippet: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore — user can still select-and-copy.
    }
  };
  return (
    <div className="flex items-stretch gap-2">
      <code className="flex-1 text-[11px] font-mono bg-cream border border-sand rounded-md px-2 py-1.5 break-all">
        {snippet}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        className="px-3 py-1 rounded-md text-xs font-heading font-bold bg-sand text-brown hover:bg-coral-light hover:text-coral transition-colors"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function PreviewLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-block mt-2 text-xs text-coral font-semibold hover:underline"
    >
      Open preview →
    </a>
  );
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/&/g, '&amp;');
}
