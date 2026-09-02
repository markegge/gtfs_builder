// Per-embed options the snippet panel bakes into the URLs it hands the agency.
//
// These are URL params honored by the embed pages (worker/embeds/theme.ts +
// i18n.ts + route.ts), never stored on the project — so they only affect the
// snippets the agency copies, not the feed's saved brand color.
//
// Split out of EmbedPanel.tsx so the query builder is unit-testable: not every
// embed accepts every param, and a param sent to a page that ignores it looks
// exactly like the option working.

export interface EmbedOptions {
  accent: string; // 6-char hex, no '#'; '' = use saved brand/default
  mode: 'light' | 'dark';
  font: 'system' | 'serif' | 'mono' | 'rounded';
  lang: string; // BCP-47 primary subtag, '' = feed default
  service: string; // service-profile id to pin; '' = automatic (today's service)
}

export const DEFAULT_EMBED_OPTIONS: EmbedOptions = {
  accent: '',
  mode: 'light',
  font: 'system',
  lang: '',
  service: '',
};

/**
 * Build the `?a=b&c=d` query string for the chosen embed options (empty when
 * all defaults).
 *
 * `includeService` defaults to **false** and must be opted into per call site.
 * Only the per-route pages read `service`; the system map has no service-day
 * concept and silently ignores it. Emitting it there would hand the agency a
 * snippet that looks pinned and isn't — the exact silent-mismatch this feature
 * exists to remove.
 */
export function optionsQuery(
  opts: EmbedOptions,
  { includeService = false }: { includeService?: boolean } = {},
): string {
  const qs = new URLSearchParams();
  if (opts.accent) qs.set('accent', opts.accent);
  if (opts.mode !== 'light') qs.set('theme', opts.mode);
  if (opts.font !== 'system') qs.set('font', opts.font);
  if (opts.lang) qs.set('lang', opts.lang);
  if (includeService && opts.service) qs.set('service', opts.service);
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/**
 * Whether a pinned service profile means anything for a given route.
 *
 * The embed resolves `?service=` against the whole feed, not the route: pin a
 * Saturday-only pattern and ask for a weekday-only route and the page finds the
 * profile, finds no trips on it, and shows an empty schedule. So a pin is only
 * emitted on routes that actually run it. `null` (nothing pinned) applies
 * everywhere — that's the automatic default.
 */
export function servicePinApplies(
  pinned: { routeIds: string[] } | null,
  routeId: string,
): boolean {
  return !pinned || pinned.routeIds.includes(routeId);
}
