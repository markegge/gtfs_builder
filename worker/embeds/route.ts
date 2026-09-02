import { html } from 'hono/html';
import type { Env } from '../env';
import { loadEmbedFeed } from './loader';
import { embedBackToMap, embedHeaders, renderLayout, embedFooter } from './layout';
import { buildRouteMapData, renderMap } from './map';
import { renderScheduleTables } from './schedule';
import {
  activeServicesOn,
  buildServiceProfiles,
  dayOfWeekInTimezone,
  pickDefaultProfile,
  todayInTimezone,
  type ServiceProfile,
} from './services';
import { resolveLang, type EmbedStrings } from './i18n';
import { parseTheme, themeCacheKey, themeStyle } from './theme';
import { renderImpressionBeacon } from './beacon';

export async function renderRouteEmbed(
  request: Request,
  env: Env,
  slug: string,
  routeId: string,
): Promise<Response> {
  const feed = await loadEmbedFeed(env, slug);
  if (!feed) return new Response('Feed not found', { status: 404 });

  const route = feed.state.routes.find((r) => r.route_id === routeId);
  if (!route) return new Response('Route not found', { status: 404 });

  const url = new URL(request.url);
  const requestedTab = url.searchParams.get('service');
  // `view` lets the widgets.js web components ask for a single section:
  //   view=map      → just the route map (powers <gtfs-route-map>)
  //   view=schedule → just the schedule table + service-day tabs (<gtfs-schedule>)
  //   anything else → the full combined page (default; iframe + mini-site links).
  const viewParam = url.searchParams.get('view');
  const view: 'map' | 'schedule' | 'full' =
    viewParam === 'map' ? 'map' : viewParam === 'schedule' ? 'schedule' : 'full';

  const agency0 = feed.state.agencies[0];
  // Theme (accent/font/dark) + language are pure functions of the URL params,
  // so fold them into the ETag to stay edge-cache-safe across variants.
  const theme = parseTheme(url.searchParams);
  const { lang, t } = resolveLang(
    url.searchParams.get('lang'),
    feed.state.feedInfo?.feed_lang,
    agency0?.agency_lang,
  );
  const variant = `${themeCacheKey(theme)}-${lang}`;

  const ifNoneMatch = request.headers.get('If-None-Match');
  const etagBase = `"${feed.snapshotId}-${routeId}-${requestedTab ?? 'auto'}-${view}-${variant}"`;
  if (ifNoneMatch && ifNoneMatch.includes(etagBase)) {
    const headers = embedHeaders(feed.snapshotId, feed.publishedAt);
    headers.set('ETag', etagBase);
    return new Response(null, { status: 304, headers });
  }

  const agency = agency0;
  const tz = agency?.agency_timezone;
  const now = new Date();
  const today = todayInTimezone(tz, now);
  const dow = dayOfWeekInTimezone(tz, now);
  const activeToday = activeServicesOn(today, dow, feed.state.calendars, feed.state.calendarDates);

  const profiles = buildServiceProfiles(feed.state.calendars);
  const defaultProfile = pickDefaultProfile(profiles, activeToday);

  let selected: ServiceProfile | null = null;
  if (requestedTab) selected = profiles.find((p) => p.id === requestedTab) ?? null;
  if (!selected) selected = defaultProfile;

  const mapData = buildRouteMapData(route, feed.state, slug);
  const map = renderMap(mapData, env.MAPBOX_TOKEN);

  const tabs = profiles.map((p) => {
    const active = selected && p.id === selected.id;
    const params = new URLSearchParams(url.search);
    params.set('service', p.id);
    return html`<a href="?${params.toString()}" class="${active ? 'active' : ''}">${p.label}</a>`;
  });

  const schedule = selected
    ? renderScheduleTables(route, new Set(selected.serviceIds), feed.state)
    : html`<p class="empty">${t.noServicePatterns}</p>`;

  // Today banner — always shown so the rider knows what schedule is in force.
  const todayBanner = renderTodayBanner(dow, defaultProfile, activeToday.size === 0, t);

  // Expiry warning — only when within 14d of feed_end_date or already past.
  const expiryWarning = renderExpiryWarning(feed.state.feedInfo?.feed_end_date, today, t);

  // Per-view impression beacon (kind depends on the section served).
  const beaconKind = view === 'map' ? 'route' : view === 'schedule' ? 'schedule' : 'route';
  const beacon = renderImpressionBeacon(slug, beaconKind, routeId);

  const routeColor = `#${route.route_color || 'cccccc'}`;
  const routeTextColor = `#${route.route_text_color || '000000'}`;
  const longName = route.route_long_name || '';
  const shortName = route.route_short_name || route.route_id;
  const effective =
    feed.state.feedInfo?.feed_start_date && feed.state.feedInfo?.feed_end_date
      ? `Schedule effective ${formatYmd(feed.state.feedInfo.feed_start_date)} – ${formatYmd(
          feed.state.feedInfo.feed_end_date,
        )}`
      : null;

  const titleText = `${shortName} ${longName}`.trim() + ` — ${agency?.agency_name ?? feed.projectName}`;
  const description = longName
    ? `${shortName} ${longName} schedule and route map.`
    : `${shortName} schedule and route map.`;

  // Back-navigation out of the embedded system map (#72). Used by the full page
  // only: view=map / view=schedule are single-section widgets composed into a
  // host page that supplies its own navigation, so they stay chrome-free.
  const backToMap = embedBackToMap(slug, t, theme, lang);

  const header = html`
    <header class="embed-header">
      ${feed.brandLogoUrl
        ? html`<img class="brand-logo" src="${feed.brandLogoUrl}" alt="${agency?.agency_name ?? feed.projectName} logo" />`
        : ''}
      <span class="route-badge" style="background: ${routeColor}; color: ${routeTextColor};">${shortName}</span>
      <div>
        <h1>${longName || shortName}</h1>
        ${effective ? html`<div class="effective">${effective}</div>` : ''}
      </div>
    </header>
  `;
  const scheduleSection = html`
    ${profiles.length > 1
      ? html`<nav class="service-tabs" aria-label="${t.serviceDay}">${tabs}</nav>`
      : ''}
    ${schedule}
  `;

  const footer = embedFooter(feed.ownerPlan, agency?.agency_name ?? feed.projectName, t.poweredBy);

  // Sectioned views (view=map / view=schedule) power the standalone
  // <gtfs-route-map> / <gtfs-schedule> web components. The full view stays
  // the combined page used by the iframe snippets and direct links.
  const body =
    view === 'map'
      ? html`
          ${header}
          ${expiryWarning}
          ${map}
          ${footer}
          ${beacon}
        `
      : view === 'schedule'
        ? html`
            ${header}
            ${expiryWarning}
            ${todayBanner}
            ${scheduleSection}
            ${footer}
            ${beacon}
          `
        : html`
            ${backToMap}
            ${header}
            ${expiryWarning}
            ${todayBanner}
            ${map}
            ${scheduleSection}
            ${footer}
            ${beacon}
          `;

  const html5 = await renderLayout({
    title: titleText,
    social: {
      title: titleText,
      description,
      url: url.toString(),
    },
    brandColor: feed.brandPrimaryColor,
    themeStyle: themeStyle(theme),
    lang,
    body: await body,
  });

  const headers = embedHeaders(feed.snapshotId, feed.publishedAt);
  headers.set('ETag', etagBase);
  return new Response(String(html5), { status: 200, headers });
}

// ─── Banners ────────────────────────────────────────────────────────────────

function renderTodayBanner(
  dayOfWeek: number,
  defaultProfile: ServiceProfile | null,
  noServiceToday: boolean,
  t: EmbedStrings,
) {
  const dayName = t.dayNames[dayOfWeek] ?? '';
  if (noServiceToday || !defaultProfile) {
    return html`
      <div class="today-banner muted" role="status">
        <span class="dot"></span>
        <span><strong>${t.todayIs(dayName)}</strong> <span class="sep">·</span> ${t.noServiceToday}</span>
      </div>
    `;
  }
  return html`
    <div class="today-banner" role="status">
      <span class="dot"></span>
      <span>
        <strong>${t.todayIs(dayName)}</strong>
        <span class="sep">·</span>
        ${t.scheduleInEffect(defaultProfile.label)}
      </span>
    </div>
  `;
}

export function renderExpiryWarning(feedEndDate: string | undefined, today: string, t?: EmbedStrings) {
  if (!feedEndDate) return '';
  const days = daysBetweenYmd(today, feedEndDate);
  if (days === null) return '';
  if (days < 0) {
    const expired = Math.abs(days);
    return html`
      <div class="expiry-warning expired" role="alert">
        <span>⚠</span>
        <span>${t ? t.scheduleExpired(expired) : `Schedule expired ${expired} day${expired === 1 ? '' : 's'} ago.`}</span>
      </div>
    `;
  }
  if (days <= 14) {
    const formatted = formatYmd(feedEndDate);
    return html`
      <div class="expiry-warning warn" role="status">
        <span>⚠</span>
        <span>${t ? t.scheduleExpiresIn(days, formatted) : `Schedule expires in ${days} day${days === 1 ? '' : 's'} (${formatted}).`}</span>
      </div>
    `;
  }
  return '';
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatYmd(ymd: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(parseInt(y, 10), parseInt(mo, 10) - 1, parseInt(d, 10)));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function ymdToUtcDay(ymd: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd);
  if (!m) return null;
  return Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}

function daysBetweenYmd(fromYmd: string, toYmd: string): number | null {
  const a = ymdToUtcDay(fromYmd);
  const b = ymdToUtcDay(toYmd);
  if (a === null || b === null) return null;
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}
