import { html } from 'hono/html';
import type { Env } from '../env';
import type { Calendar, CalendarDate } from './types';
import { loadEmbedFeed } from './loader';
import { embedBackToMap, embedHeaders, renderLayout, embedFooter } from './layout';
import { buildRouteMapData, renderMap } from './map';
import { renderScheduleTables } from './schedule';
import {
  activeServicesOn,
  buildServiceProfiles,
  dayOfWeekForYmd,
  expiredProfileIds,
  feedCalendarRange,
  nextServiceDate,
  parseDateParam,
  pickDefaultProfile,
  todayInTimezone,
  ymdToInputValue,
  type ServiceProfile,
} from './services';
import { resolveLang, type EmbedLang, type EmbedStrings } from './i18n';
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

  const agency = agency0;
  const tz = agency?.agency_timezone;
  const now = new Date();
  // "Today" is the agency's today, never the server's — the same clock the
  // default-profile picker runs on.
  const today = todayInTimezone(tz, now);

  // ─── The date this page answers for (#73) ─────────────────────────────────
  //
  // `?date=` is the rider's own control: the date picker in the today-banner
  // replaced the service-day tabs as the way to reach a pattern that isn't
  // today's. It is transient navigation state, exactly the standing the tabs
  // had — deliberately NOT something an agency bakes into a snippet, because a
  // date frozen into an iframe keeps serving one day's schedule forever without
  // ever looking broken. `src/components/embed/embedOptions.ts` has no `date`
  // field for that reason; keep it that way.
  //
  // An unparseable or nonexistent date falls back to today rather than
  // erroring, matching how an unknown `?service=` is already handled.
  const requestedDate = parseDateParam(url.searchParams.get('date'));
  const selectedDate = requestedDate ?? today;
  const isToday = selectedDate === today;
  // Derived from the calendar date itself, so the no-date path computes exactly
  // what dayOfWeekInTimezone(tz) used to and the two cases share one path.
  const dow = dayOfWeekForYmd(selectedDate);

  const truthy = (name: string) =>
    ['1', 'true', 'yes'].includes((url.searchParams.get(name) ?? '').trim().toLowerCase());

  // The tab row is hidden by default now — the date picker is the rider-facing
  // control, and two ways to choose the same thing is one too many. `show_services`
  // brings it back for anyone diagnosing a feed from a rider URL.
  //
  // `show_expired` (#71) is a *refinement* of that row — "include the ended
  // patterns too" — so it implies it rather than being a second, parallel
  // reveal. Asking to see expired tabs on a page with no tabs meant nothing.
  const showExpiredParam = truthy('show_expired');
  const showTabs = truthy('show_services') || showExpiredParam;

  // Everything that changes the bytes goes in the ETag. `today` stays in it
  // alongside `selectedDate` because they are independently load-bearing: the
  // date drives which schedule renders, while today drives whether the banner
  // reads "Today is …" or names the date — so a page cached yesterday for an
  // explicit date is stale this morning even though its date param didn't move.
  const ifNoneMatch = request.headers.get('If-None-Match');
  const etagBase = `"${feed.snapshotId}-${routeId}-${requestedTab ?? 'auto'}-${view}-${variant}-${today}-d${selectedDate}${
    showExpiredParam ? '-all' : ''
  }${showTabs ? '-tabs' : ''}"`;
  if (ifNoneMatch && ifNoneMatch.includes(etagBase)) {
    const headers = embedHeaders(feed.snapshotId, feed.publishedAt);
    headers.set('ETag', etagBase);
    return new Response(null, { status: 304, headers });
  }

  const activeOnDate = activeServicesOn(
    selectedDate,
    dow,
    feed.state.calendars,
    feed.state.calendarDates,
  );

  const profiles = buildServiceProfiles(feed.state.calendars);
  // Judged against the *selected* date, not today: a rider looking up a date
  // last spring should see the pattern that ran then, not be told it's over.
  // Computed over ALL profiles, because an explicit `?service=` can select one
  // this route doesn't run and still needs its "ended" notice.
  const expired = expiredProfileIds(profiles, feed.state.calendarDates, selectedDate);

  // ─── Only patterns THIS route actually operates ───────────────────────────
  //
  // `buildServiceProfiles` reads the whole feed, but this page is one route's.
  // Selecting across all of them picks by what the *network* runs: on a feed
  // with an all-week service and a weekend-only one, a Saturday resolves to
  // "Daily" — and a route that only runs the weekend pattern renders an empty
  // table under a banner announcing a schedule is in effect.
  //
  // That was true before the date picker existed (the tie-break has always been
  // feed-wide), but the tab row let a rider click their way out of it. With the
  // tabs off the page it became a dead end, so the scoping belongs here now.
  // Same trap `servicePinApplies` already guards the snippet builder against.
  const routeServiceIds = new Set<string>();
  for (const trip of feed.state.trips) {
    if (trip.route_id === routeId) routeServiceIds.add(trip.service_id);
  }
  const routeProfiles = profiles.filter((p) => p.serviceIds.some((id) => routeServiceIds.has(id)));

  // Hiding is for routes that still have something to show. When *every*
  // pattern this route runs has ended, hiding them all would leave a rider on
  // an empty page with no explanation — so show them, and let the warning work.
  const allExpired =
    routeProfiles.length > 0 && routeProfiles.every((p) => expired.has(p.id));
  const showExpired = showExpiredParam || allExpired;

  const defaultProfile = pickDefaultProfile(routeProfiles, activeOnDate, expired);

  let pinned: ServiceProfile | null = null;
  // Precedence: an explicit `?date=` outranks an explicit `?service=`.
  //
  // The pin is where the page *starts* — an agency bakes it into an iframe — and
  // the date is what the rider did next. Honouring the pin over the rider's
  // click would make the picker a control that visibly does nothing, which is
  // the silent-mismatch failure this area keeps producing. The picker's form
  // omits `service` from its hidden inputs, so submitting a date drops the pin
  // from the URL outright rather than leaving a dead param behind.
  //
  // With no date param this is unchanged from #71: the pin resolves against ALL
  // profiles, expired included, because showing what it actually points at —
  // with the notice on it — beats silently substituting a different schedule.
  if (requestedTab && !requestedDate) {
    pinned = profiles.find((p) => p.id === requestedTab) ?? null;
  }
  const selected: ServiceProfile | null = pinned ?? defaultProfile;

  // This route's services actually running on the selected date. Feed-wide
  // service isn't enough: a route can sit idle on a day the rest of the network
  // is running, and the rider asked about this route.
  const runningOnDate = new Set<string>();
  for (const id of activeOnDate) {
    if (routeServiceIds.has(id)) runningOnDate.add(id);
  }
  const routeRunsOnDate = runningOnDate.size > 0;

  // The no-service explanation is for a date the rider *asked* for. With no
  // date param the page keeps its previous behaviour — banner says "no service
  // today", the fallback pattern's timetable renders underneath as context —
  // because a cold load is us guessing, not the rider asking. That fallback is
  // now drawn from this route's own patterns, so it's a timetable the route
  // actually runs rather than whatever the network runs most.
  const explainNoService = requestedDate !== null && !routeRunsOnDate;
  const range = feedCalendarRange(feed.state.calendars, feed.state.calendarDates);
  const outOfRange = !!range && (selectedDate < range.start || selectedDate > range.end);

  const mapData = buildRouteMapData(route, feed.state, slug);
  const map = renderMap(mapData, env.MAPBOX_TOKEN);

  // Tabs a rider can reach: this route's live patterns, the expired ones when
  // asked for (or when that's all there is), and whatever is selected — a
  // selected tab missing from its own tab row reads as a broken page, and that
  // exception is also what keeps a `?service=` pin at another route's pattern
  // visible.
  //
  // Scoped to `routeProfiles` for the same reason the selection is: a tab for a
  // pattern this route doesn't operate is a link to an empty table.
  const sel = selected;
  const visibleProfiles = showTabs
    ? routeProfiles
        .filter((p) => showExpired || !expired.has(p.id) || p.id === sel?.id)
        .concat(sel && !routeProfiles.some((p) => p.id === sel.id) ? [sel] : [])
    : [];
  // Only this route's own withheld patterns count as "hidden" — a pattern the
  // route never ran wasn't hidden from the rider, it was never theirs to see.
  const hiddenCount = showTabs
    ? routeProfiles.filter((p) => !visibleProfiles.some((v) => v.id === p.id)).length
    : 0;

  const tabs = visibleProfiles.map((p) => {
    const active = selected && p.id === selected.id;
    const isExpired = expired.has(p.id);
    const params = new URLSearchParams(url.search);
    params.set('service', p.id);
    // A tab is a request for a pattern, not for a day — and `date` outranks
    // `service`, so carrying it through would make every tab a no-op.
    params.delete('date');
    const cls = `${active ? 'active' : ''}${isExpired ? ' expired' : ''}`.trim();
    const label = isExpired ? `${p.label} (${t.endedLabel})` : p.label;
    return html`<a href="?${params.toString()}" class="${cls}">${label}</a>`;
  });

  // Showing fewer tabs without saying so is its own small lie — and it hides a
  // publishing mistake from the operator as effectively as it hides a dead
  // schedule from the rider. One quiet line, and the link that reveals them.
  const showAllParams = new URLSearchParams(url.search);
  showAllParams.set('show_expired', '1');
  const hiddenNote =
    hiddenCount > 0
      ? html`<p class="service-note">
          ${t.pastServiceHidden} <a href="?${showAllParams.toString()}">${t.showAllServices}</a>
        </p>`
      : '';

  // What goes where the timetable would: the requested date's answer when the
  // rider named a date this route doesn't run, otherwise the timetable.
  // Which services the timetable is built from, in priority order:
  //
  //  1. An explicit `?service=` pin — exactly that pattern and nothing else.
  //     Someone has the URL in a live page and is owed what they asked for.
  //  2. Everything this route runs on the selected date. A day is not a
  //     pattern: where two patterns overlap — a seasonal weekend service
  //     running alongside a year-round one — both are real trips a rider can
  //     board, and picking only the one that sorts first made the other
  //     unreachable by any date once the tab row came off the page.
  //  3. Nothing running: fall back to the selected profile so a cold page still
  //     shows what this route runs when it does run, as it did before.
  const scheduleServiceIds = pinned
    ? new Set(pinned.serviceIds)
    : runningOnDate.size > 0
      ? runningOnDate
      : new Set(selected?.serviceIds ?? []);

  const schedule = explainNoService
    ? renderNoServiceForDate({
        url,
        selectedDate,
        today,
        routeServiceIds,
        outOfRange,
        range,
        calendars: feed.state.calendars,
        calendarDates: feed.state.calendarDates,
        lang,
        t,
      })
    : selected
      ? renderScheduleTables(route, scheduleServiceIds, feed.state)
      : html`<p class="empty">${t.noServicePatterns}</p>`;

  // Day banner — always shown so the rider knows what schedule is in force, and
  // for which day. The "no service" flag stays feed-wide on the default path
  // (unchanged behaviour) and route-scoped once a date is named, so the banner
  // can't contradict the explanation rendered underneath it.
  const dayBanner = renderDayBanner({
    selectedDate,
    today,
    isToday,
    dayOfWeek: dow,
    profile: defaultProfile,
    // Route-scoped on both paths. Feed-wide, this said "Daily schedule in
    // effect" on a route that runs nothing that day — the banner asserting a
    // schedule while the table below it came back empty.
    noService: !routeRunsOnDate,
    picker: renderDatePicker(url, selectedDate, range, t),
    lang,
    t,
  });

  // Expiry warning — only when within 14d of feed_end_date or already past.
  const expiryWarning = renderExpiryWarning(feed.state.feedInfo?.feed_end_date, today, t);

  // Per-pattern warning, for the selected pattern only. Suppressed when the
  // feed-level banner is already announcing that the whole schedule expired:
  // two near-identical alerts stacked on one page teaches riders to skip both.
  // Also suppressed when the page is already explaining that the requested date
  // has no service — the selected profile is then just a fallback nobody asked
  // about, and "this schedule ended" would be answering a different question.
  const endedWarning =
    !explainNoService &&
    selected &&
    expired.has(selected.id) &&
    !isFeedExpired(feed.state.feedInfo?.feed_end_date, today)
      ? html`
          <div class="expiry-warning expired" role="alert">
            <span>⚠</span>
            <span>${t.serviceEnded(formatYmd(selected.endDate))}</span>
          </div>
        `
      : '';

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
    ${visibleProfiles.length > 1
      ? html`<nav class="service-tabs" aria-label="${t.serviceDay}">${tabs}</nav>`
      : ''}
    ${hiddenNote}
    ${endedWarning}
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
            ${dayBanner}
            ${scheduleSection}
            ${footer}
            ${beacon}
          `
        : html`
            ${backToMap}
            ${header}
            ${expiryWarning}
            ${dayBanner}
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

/**
 * The banner naming the day on show and the pattern in force, with the date
 * picker sitting at its trailing edge.
 *
 * The lead clause follows the selected date: "Today is Wednesday" only while
 * the page really is showing today. Once a rider picks another day it names
 * that day instead, because a page headed "Today is …" over next Tuesday's
 * timetable is worse than no heading at all.
 */
function renderDayBanner(opts: {
  selectedDate: string;
  today: string;
  isToday: boolean;
  dayOfWeek: number;
  profile: ServiceProfile | null;
  noService: boolean;
  picker: ReturnType<typeof html> | '';
  lang: EmbedLang;
  t: EmbedStrings;
}) {
  const { selectedDate, today, isToday, dayOfWeek, profile, noService, picker, lang, t } = opts;
  const lead = isToday
    ? t.todayIs(t.dayNames[dayOfWeek] ?? '')
    : formatDateWithWeekday(selectedDate, lang, today);
  const effect =
    noService || !profile
      ? isToday
        ? t.noServiceToday
        : t.noServiceOnDate
      : t.scheduleInEffect(profile.label);
  const muted = noService || !profile;
  return html`
    <div class="today-banner${muted ? ' muted' : ''}" role="status">
      <span class="dot"></span>
      <span>
        <strong>${lead}</strong>
        <span class="sep">·</span>
        ${effect}
      </span>
      ${picker}
    </div>
  `;
}

/**
 * The date picker: a plain `<form method="get">` around an `<input type="date">`.
 *
 * No JavaScript, on purpose — these pages are chrome-light and the controls they
 * replaced were plain links, so the picker degrades to a normal navigation the
 * same way. The visible submit button is the cost of that: a native date input
 * fires no navigation of its own when a rider taps a day in the calendar popup.
 *
 * A GET form replaces the query string wholesale with its own fields, which is
 * what makes the hidden-input list the *complete* definition of what survives a
 * date change. Presentation params (theme/lang/font/view) and the diagnostic
 * reveals ride along; `service` deliberately does NOT, so picking a date drops a
 * pinned pattern visibly in the URL instead of leaving a param that outranks
 * nothing and explains less.
 */
const PICKER_CARRY_PARAMS = [
  'accent',
  'theme',
  'font',
  'lang',
  'view',
  'show_services',
  'show_expired',
] as const;

function renderDatePicker(
  url: URL,
  selectedDate: string,
  range: { start: string; end: string } | null,
  t: EmbedStrings,
) {
  const hidden = PICKER_CARRY_PARAMS.filter((name) => url.searchParams.has(name)).map(
    (name) => html`<input type="hidden" name="${name}" value="${url.searchParams.get(name) ?? ''}" />`,
  );
  // `min`/`max` are advisory: they grey out uncovered days in the browser's own
  // calendar, which communicates the feed's coverage for free. They are not
  // validation — a hand-typed URL still reaches the server — which is why the
  // out-of-range message underneath has to exist regardless.
  const min = range ? html` min="${ymdToInputValue(range.start)}"` : '';
  const max = range ? html` max="${ymdToInputValue(range.end)}"` : '';
  return html`
    <form class="date-picker" method="get">
      ${hidden}
      <input
        type="date"
        name="date"
        value="${ymdToInputValue(selectedDate)}"
        aria-label="${t.showScheduleForDate}"${min}${max}
      />
      <button type="submit">${t.go}</button>
    </form>
  `;
}

/**
 * What a rider gets instead of a timetable when the date they picked isn't one
 * this route runs.
 *
 * Two different answers, kept apart because they mean different things: a day
 * inside the feed's coverage with nothing scheduled ("no service that day") is a
 * fact about the service, while a day outside it ("the feed doesn't go that far")
 * is a fact about the data. Collapsing them would tell a rider asking about next
 * summer that the bus doesn't run then, which nobody knows.
 *
 * Either way the page offers the next day this route does run, when there is
 * one — a dead end with a date picker on it is still a dead end.
 */
function renderNoServiceForDate(opts: {
  url: URL;
  selectedDate: string;
  today: string;
  routeServiceIds: ReadonlySet<string>;
  outOfRange: boolean;
  range: { start: string; end: string } | null;
  calendars: Calendar[];
  calendarDates: CalendarDate[];
  lang: EmbedLang;
  t: EmbedStrings;
}) {
  const { url, selectedDate, today, routeServiceIds, outOfRange, range, lang, t } = opts;
  const next = nextServiceDate(selectedDate, routeServiceIds, opts.calendars, opts.calendarDates);
  // Built off the current query so the rider keeps the theme and language they
  // are already looking at — a link that silently reverts the embed to default
  // English is a worse dead end than the one it's rescuing them from.
  let nextHref = '';
  if (next) {
    const params = new URLSearchParams(url.search);
    params.set('date', ymdToInputValue(next));
    nextHref = `?${params.toString()}`;
  }
  return html`
    <p class="empty">
      <span>${t.noServiceOnDate}</span>
      ${outOfRange && range
        ? html`<span class="next-service"
            >${t.scheduleCovers(
              formatDateMedium(range.start, lang),
              formatDateMedium(range.end, lang),
            )}</span
          >`
        : ''}
      ${next
        ? html`<a class="next-service" href="${nextHref}"
            >${t.nextServiceOn(formatDateWithWeekday(next, lang, today))}</a
          >`
        : ''}
    </p>
  `;
}

// ─── Localized date formatting ───────────────────────────────────────────────
//
// Formatted through Intl in the page's own language rather than from five
// hand-written month/weekday tables — the day and month names riders read are
// exactly the ones their locale already uses, and there is nothing to keep in
// sync in i18n.ts. (`formatYmd` below still hardcodes en-US; it predates this
// and belongs to the #71 expiry banners, so it's left alone here.)

/** "Friday, December 25" — with the year only when it isn't the current one. */
function formatDateWithWeekday(ymd: string, lang: EmbedLang, today: string): string {
  const ms = ymdToUtcDay(ymd);
  if (ms === null) return ymd;
  const sameYear = ymd.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat(lang, {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(new Date(ms));
}

/** "December 25, 2026" — always with the year; used for the feed's coverage span. */
function formatDateMedium(ymd: string, lang: EmbedLang): string {
  const ms = ymdToUtcDay(ymd);
  if (ms === null) return ymd;
  return new Intl.DateTimeFormat(lang, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(ms));
}

/**
 * True when the whole feed is past its `feed_info.feed_end_date` — i.e. when
 * renderExpiryWarning is rendering its `expired` variant. Kept next to it so
 * the two can't drift into disagreeing about what "expired" means.
 */
function isFeedExpired(feedEndDate: string | undefined, today: string): boolean {
  if (!feedEndDate) return false;
  const days = daysBetweenYmd(today, feedEndDate);
  return days !== null && days < 0;
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
