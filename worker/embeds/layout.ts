import { html, raw } from 'hono/html';
import { mapboxAssetTags } from './map';
import { planHasFeature } from '../billing/plans';
import type { Plan } from '../projects/quotas';
import type { EmbedLang, EmbedStrings } from './i18n';
import type { EmbedTheme } from './theme';

/**
 * The "Powered by GTFS·X" embed footer, with an optional agency suffix. Returns
 * empty for owners entitled to remove it (embed_remove_badge — Agency+), so
 * paid white-label feeds render no badge. Shared by all embed renderers.
 */
export function embedFooter(ownerPlan: Plan, suffix?: string, poweredBy = 'Powered by') {
  if (planHasFeature(ownerPlan, 'embed_remove_badge')) return '';
  return html`<footer class="embed-footer">
      ${poweredBy} <a href="https://gtfsx.com" target="_blank" rel="noopener">GTFS·X</a>${suffix ? html` · ${suffix}` : ''}
    </footer>`;
}

/**
 * "← All routes" link back to the feed's system map, for the route and stop
 * embeds.
 *
 * Both pages are reachable by clicking *inside* an embedded system map (a route
 * in its route list, a stop dot on the map itself). Those links carry no
 * `target`, so the navigation happens within the host's iframe and the rider
 * has no visible way back — on mobile, no affordance at all (issue #72).
 *
 * Rendered unconditionally rather than only when the rider arrived from the
 * map: a route embed placed on its own page still benefits from a link to the
 * full map, and a referrer is not reliable inside an iframe anyway.
 *
 * The theme and language are carried across so the destination keeps the host's
 * look and the rider's language. Both are rebuilt from the *parsed* theme and
 * *resolved* lang — never the raw query string — so the href stays a pure
 * function of the caller's ETag variant (themeCacheKey + lang) and cache
 * semantics are unchanged.
 */
export function embedBackToMap(
  slug: string,
  t: EmbedStrings,
  theme: EmbedTheme,
  lang: EmbedLang,
) {
  const params = new URLSearchParams();
  if (theme.accent) params.set('accent', theme.accent);
  if (theme.mode !== 'light') params.set('theme', theme.mode);
  if (theme.font !== 'system') params.set('font', theme.font);
  params.set('lang', lang);
  const href = `/${encodeURIComponent(slug)}/embed/system-map?${params.toString()}`;
  // The arrow is decorative — the accessible name is the visible text label.
  return html`<nav class="embed-nav" aria-label="${t.systemMap}">
      <a href="${href}"><span class="arrow" aria-hidden="true">←</span>${t.allRoutes}</a>
    </nav>`;
}

const STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  :root {
    --brand: #e8734a;        /* default coral; overridden inline by brand_primary_color */
    --brand-deep: #b04d2a;
    --embed-font: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  body {
    font-family: var(--embed-font);
    color: #1a1a1a;
    background: #fff8f0;
    line-height: 1.5;
    font-size: 14px;
  }
  .embed-root {
    max-width: 1100px;
    margin: 0 auto;
    padding: 16px;
  }
  header.embed-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }
  header.embed-header h1 {
    font-size: 18px;
    margin: 0;
    font-weight: 700;
    color: #2a1a0e;
  }
  header.embed-header .effective {
    font-size: 12px;
    color: #6b6b6b;
    margin-top: 2px;
  }
  .route-badge {
    display: inline-block;
    min-width: 36px;
    text-align: center;
    padding: 4px 10px;
    border-radius: 6px;
    font-weight: 700;
    font-size: 14px;
    line-height: 1.4;
  }
  h3 { font-size: 14px; margin: 18px 0 8px; font-weight: 600; color: #2a1a0e; }

  /* Today banner — "Today is Friday · Weekday schedule" */
  .today-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    background: #fef6e9;
    border: 1px solid #f0e0c0;
    color: #5a4525;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 13px;
    margin-bottom: 12px;
  }
  .today-banner .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #2c8a5b;
    flex-shrink: 0;
  }
  .today-banner.muted .dot { background: #b88a4a; }
  .today-banner strong { font-weight: 600; }
  .today-banner .sep { color: #b88a4a; }
  /* The date picker sits inside the today-banner, at its trailing edge, so it
     reads as a refinement of "showing this day's schedule" rather than a form
     bolted underneath one. margin-left:auto pushes it right on a wide embed;
     flex-wrap on the banner lets it drop to its own line on a narrow one
     instead of squeezing the sentence. */
  .today-banner { flex-wrap: wrap; }
  .date-picker {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }
  .date-picker input[type='date'] {
    font: inherit;
    font-size: 12px;
    color: #5a4525;
    background: #fffdf8;
    border: 1px solid #e0cba8;
    border-radius: 4px;
    padding: 2px 6px;
    /* iOS Safari stretches a date input to a fixed intrinsic width and adds
       inner shadow; both make it read as a heavyweight form field. */
    -webkit-appearance: none;
    appearance: none;
    min-height: 24px;
  }
  .date-picker button {
    font: inherit;
    font-size: 12px;
    color: var(--brand-deep);
    background: transparent;
    border: 1px solid #e0cba8;
    border-radius: 4px;
    padding: 2px 8px;
    min-height: 24px;
    cursor: pointer;
  }
  .date-picker button:hover { background: #fdf3e3; }
  /* The answers a chosen date gets when it isn't a timetable — each on its own
     line so "no service" and the way out of it don't run together. */
  .empty .next-service { display: block; margin-top: 6px; }
  .empty a.next-service { color: var(--brand-deep); }

  /* Expiry warning — yellow when ≤14 days, red when expired */
  .expiry-warning {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 13px;
    margin-bottom: 12px;
  }
  .expiry-warning.warn {
    background: #fef3c7;
    border: 1px solid #f0d28a;
    color: #78350f;
  }
  .expiry-warning.expired {
    background: #fee2e2;
    border: 1px solid #fca5a5;
    color: #991b1b;
  }

  /* Map */
  .map {
    position: relative;
    width: 100%;
    height: 360px;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid #e8d8c0;
    margin-bottom: 16px;
    background: #f0e6d4
      linear-gradient(135deg, transparent 49%, rgba(255,255,255,0.4) 49%, rgba(255,255,255,0.4) 51%, transparent 51%);
    background-size: 24px 24px;
  }
  .map .map-skeleton {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: #6b6b6b;
    font-size: 13px;
    pointer-events: none;
    transition: opacity 200ms ease;
  }
  .map .map-skeleton::after {
    content: 'Loading map…';
    background: rgba(255,255,255,0.85);
    padding: 6px 12px;
    border-radius: 999px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.06);
  }
  .map.loaded .map-skeleton { opacity: 0; }
  .map-fallback {
    width: 100%;
    height: 200px;
    display: grid;
    place-items: center;
    color: #6b6b6b;
    background: #f0e6d4;
    border-radius: 8px;
    margin-bottom: 16px;
  }

  /* Service-day tabs, and the back-to-system-map link that shares their look */
  .service-tabs, .embed-nav {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-bottom: 12px;
    border-bottom: 1px solid #e8d8c0;
  }
  .service-tabs a, .embed-nav a {
    padding: 8px 14px;
    text-decoration: none;
    color: #1a1a1a;
    font-size: 13px;
    font-weight: 500;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: color 120ms;
  }
  .service-tabs a:hover, .embed-nav a:hover { color: var(--brand-deep); }
  .service-tabs a.active {
    border-bottom-color: var(--brand);
    color: var(--brand-deep);
    font-weight: 700;
  }
  /* An expired pattern, when one is on show (#71) — legible, but visibly not
     the schedule a rider should be planning around. */
  .service-tabs a.expired { color: #8a7a6a; font-style: italic; }
  .service-tabs a.expired.active { color: var(--brand-deep); }
  /* The one-line note under the tabs saying some patterns were hidden, plus its
     reveal link. Deliberately quiet: it is for the rider who wonders, not the
     rider who is looking up a departure time. */
  .service-note {
    font-size: 12px;
    color: #6b6b6b;
    margin: -4px 0 12px;
  }
  .service-note a { color: var(--brand-deep); }

  /* Flush left so it lines up with the header beneath it. */
  .embed-nav a {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding-left: 0;
  }
  .embed-nav .arrow { font-size: 15px; line-height: 1; }

  /* Schedule table */
  .schedule-scroll {
    overflow-x: auto;
    border: 1px solid #e8d8c0;
    border-radius: 6px;
    background: #fff;
    -webkit-overflow-scrolling: touch;
  }
  table.schedule {
    border-collapse: collapse;
    width: 100%;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  table.schedule th, table.schedule td {
    padding: 6px 10px;
    text-align: right;
    border-bottom: 1px solid #f0e6d4;
    border-right: 1px solid #f0e6d4;
    white-space: nowrap;
  }
  table.schedule thead th {
    background: #fff8f0;
    border-bottom: 1px solid #e8d8c0;
    position: sticky;
    top: 0;
    z-index: 1;
    font-weight: 600;
    color: #6b6b6b;
  }
  table.schedule .corner { background: #fff8f0; left: 0; position: sticky; z-index: 2; text-align: left; }
  table.schedule .stop-name {
    text-align: left;
    font-weight: 500;
    color: #1a1a1a;
    background: #fff;
    position: sticky;
    left: 0;
    z-index: 1;
    border-right: 2px solid #e8d8c0;
    min-width: 160px;
    max-width: 240px;
    white-space: normal;
    line-height: 1.3;
  }
  table.schedule .skip { color: #c0a890; }
  .empty {
    color: #6b6b6b;
    font-style: italic;
    padding: 24px 16px;
    text-align: center;
  }
  footer.embed-footer {
    margin-top: 16px;
    font-size: 11px;
    color: #6b6b6b;
    text-align: right;
  }
  footer.embed-footer a { color: #6b6b6b; }
  .route-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 8px;
    margin-top: 12px;
  }
  .route-list a {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    text-decoration: none;
    color: #1a1a1a;
    background: #fff;
    border: 1px solid #e8d8c0;
    border-radius: 6px;
    font-size: 13px;
    transition: background 120ms;
  }
  .route-list a:hover { background: #fff8f0; }
  .route-list a .name { font-weight: 500; line-height: 1.3; }

  /* Per-stop page departures list */
  .departures {
    list-style: none;
    margin: 0; padding: 0;
    border: 1px solid #e8d8c0;
    border-radius: 6px;
    background: #fff;
    overflow: hidden;
  }
  .departures li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid #f0e6d4;
  }
  .departures li:last-child { border-bottom: none; }
  .dep-time {
    flex-shrink: 0;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: #1a1a1a;
    min-width: 64px;
  }
  .dep-route {
    display: flex;
    align-items: center;
    gap: 8px;
    text-decoration: none;
    color: #1a1a1a;
    flex: 1;
  }
  .dep-route:hover .dep-headsign { color: var(--brand-deep); }
  .dep-headsign { font-weight: 500; }

  /* Brand logo (org-owned feeds) */
  .brand-logo {
    height: 40px;
    width: auto;
    max-width: 200px;
    object-fit: contain;
    flex-shrink: 0;
  }
  body.landing .brand-logo { height: 56px; max-width: 280px; }

  /* Mini-site landing — slightly more spacious */
  body.landing .embed-root { padding: 24px; max-width: 1100px; }
  body.landing .embed-header h1 { font-size: 24px; }
  body.landing .map { height: 480px; }
  body.landing .landing-footnote {
    font-size: 12px; color: #6b6b6b; margin-top: 12px;
  }
  @media (max-width: 600px) {
    body.landing .embed-root { padding: 16px; }
    body.landing .map { height: 280px; }
    body.landing .embed-header h1 { font-size: 20px; }
    .brand-logo { height: 32px; max-width: 140px; }
    body.landing .brand-logo { height: 44px; max-width: 200px; }
  }

  @media (max-width: 600px) {
    .embed-root { padding: 12px; }
    .map { height: 220px; }
    table.schedule .stop-name { min-width: 120px; max-width: 160px; font-size: 11px; }
    table.schedule th, table.schedule td { padding: 5px 8px; font-size: 11px; }
    header.embed-header h1 { font-size: 16px; }
  }
`;

export interface SocialMeta {
  title: string;
  description: string;
  // Optional canonical URL for OG meta.
  url?: string;
  // Optional absolute URL of the route-map thumbnail (og:image / twitter:image).
  // When set, the card upgrades to summary_large_image.
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
}

export function renderLayout(opts: {
  title: string;
  social?: SocialMeta;
  bodyClass?: string;
  body: ReturnType<typeof html>;
  // True for embed iframes (don't outrank the host page); false for the
  // canonical mini-site landing page where SEO is desired.
  noindex?: boolean;
  // 6-char hex without leading "#". When set, overrides the default
  // coral via inline CSS variables.
  brandColor?: string | null;
  // Pre-rendered <style> block for per-embed theming (accent/font/dark mode),
  // emitted AFTER brandColor so an explicit accent= param wins. See theme.ts.
  themeStyle?: string;
  // BCP-47 primary subtag for the <html lang> attribute (a11y + browser hints).
  lang?: string;
}) {
  const social = opts.social;
  const noindex = opts.noindex !== false;
  const lang = /^[a-z]{2}$/.test(opts.lang ?? '') ? opts.lang : 'en';
  const brandStyle = opts.brandColor && /^[0-9a-fA-F]{6}$/.test(opts.brandColor)
    ? `<style>:root { --brand: #${opts.brandColor}; --brand-deep: #${darkenHex(opts.brandColor)}; }</style>`
    : '';
  return html`<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${noindex ? html`<meta name="robots" content="noindex" />` : ''}
  <title>${opts.title}</title>
  ${social
    ? html`
        <meta property="og:title" content="${social.title}" />
        <meta property="og:description" content="${social.description}" />
        <meta property="og:type" content="website" />
        ${social.url ? html`<meta property="og:url" content="${social.url}" />` : ''}
        ${social.imageUrl
          ? html`
              <meta property="og:image" content="${social.imageUrl}" />
              ${social.imageWidth ? html`<meta property="og:image:width" content="${social.imageWidth}" />` : ''}
              ${social.imageHeight ? html`<meta property="og:image:height" content="${social.imageHeight}" />` : ''}
              <meta name="twitter:image" content="${social.imageUrl}" />
            `
          : ''}
        <meta name="twitter:card" content="${social.imageUrl ? 'summary_large_image' : 'summary'}" />
        <meta name="twitter:title" content="${social.title}" />
        <meta name="twitter:description" content="${social.description}" />
      `
    : ''}
  <style>${raw(STYLES)}</style>
  ${raw(brandStyle)}
  ${opts.themeStyle ? raw(opts.themeStyle) : ''}
  ${mapboxAssetTags()}
</head>
<body class="${opts.bodyClass ?? ''}">
  <div class="embed-root">${opts.body}</div>
</body>
</html>`;
}

/**
 * Multiply each RGB channel by 0.7 to produce a "deep" variant of the
 * brand color for hover/active states. Input is 6-char hex with no
 * leading "#"; output matches that shape.
 */
function darkenHex(hex: string): string {
  const m = /^([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m) return hex;
  const adj = (h: string) => {
    const n = parseInt(h, 16);
    return Math.max(0, Math.min(255, Math.round(n * 0.7))).toString(16).padStart(2, '0');
  };
  return `${adj(m[1])}${adj(m[2])}${adj(m[3])}`;
}

export function embedHeaders(snapshotId: string, publishedAt: number): Headers {
  const h = new Headers();
  h.set('Content-Type', 'text/html; charset=utf-8');
  h.set('ETag', `"${snapshotId}"`);
  h.set('Last-Modified', new Date(publishedAt).toUTCString());
  // Embeds are publicly framable.
  h.set('Content-Security-Policy', "frame-ancestors *;");
  // Don't outrank the host page in search.
  h.set('X-Robots-Tag', 'noindex');
  // Tile + edge cache: short browser TTL, longer at the edge; republish
  // invalidates by snapshot_id changing the ETag.
  h.set('Cache-Control', 'public, max-age=300, s-maxage=3600');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return h;
}
