// ─── Embed theming ───────────────────────────────────────────────────────────
//
// Per-embed look-and-feel, controlled by URL query params so a host can theme
// an individual iframe without changing the project's saved brand color. All
// params are read from the embed URL; nothing is stored, so theming stays a
// pure function of the request — which keeps it edge-cacheable as long as the
// resolved theme is folded into the page ETag (see themeCacheKey()).
//
// Params (all optional):
//   accent=RRGGBB   6-char hex accent override (no leading #). Falls back to
//                   the project's saved brand_primary_color, then default coral.
//   theme=light|dark  color scheme. Default 'light'. 'dark' flips the surface
//                   colors for embeds on dark host pages.
//   font=system|serif|mono|rounded   body font stack. Default 'system'.
//
// The brand color saved on the project still drives the default accent; the
// `accent=` param is an explicit per-embed override layered on top.

export type ThemeMode = 'light' | 'dark';
export type ThemeFont = 'system' | 'serif' | 'mono' | 'rounded';

export interface EmbedTheme {
  // 6-char hex (no #) or null → use the page's default/brand accent.
  accent: string | null;
  mode: ThemeMode;
  font: ThemeFont;
}

const HEX6 = /^[0-9a-fA-F]{6}$/;

const FONT_STACKS: Record<ThemeFont, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", "Noto Serif", serif',
  mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace',
  rounded: '"Nunito", "Quicksand", ui-rounded, "SF Pro Rounded", system-ui, sans-serif',
};

/** Parse the theme out of an embed request's query params. Invalid values are dropped. */
export function parseTheme(params: URLSearchParams): EmbedTheme {
  const rawAccent = (params.get('accent') ?? '').replace(/^#/, '').trim();
  const accent = HEX6.test(rawAccent) ? rawAccent.toLowerCase() : null;

  const rawMode = (params.get('theme') ?? '').trim().toLowerCase();
  const mode: ThemeMode = rawMode === 'dark' ? 'dark' : 'light';

  const rawFont = (params.get('font') ?? '').trim().toLowerCase();
  const font: ThemeFont =
    rawFont === 'serif' || rawFont === 'mono' || rawFont === 'rounded' ? rawFont : 'system';

  return { accent, mode, font };
}

/**
 * A short, stable string describing the non-default parts of the theme, for
 * folding into a page ETag so two requests with different themes never collide
 * in the edge cache. Empty string when the theme is fully default.
 */
export function themeCacheKey(theme: EmbedTheme): string {
  const parts: string[] = [];
  if (theme.accent) parts.push(`a${theme.accent}`);
  if (theme.mode !== 'light') parts.push(`m${theme.mode}`);
  if (theme.font !== 'system') parts.push(`f${theme.font}`);
  return parts.join('');
}

/**
 * Build the inline <style> overrides for this theme. Returns '' when the theme
 * is fully default (so the base stylesheet + brandColor handling stays as-is).
 * The accent override here takes precedence over renderLayout's brandColor
 * block because it is emitted *after* it in <head>.
 */
export function themeStyle(theme: EmbedTheme): string {
  const rules: string[] = [];

  if (theme.accent) {
    rules.push(`--brand: #${theme.accent};`);
    rules.push(`--brand-deep: #${darkenHex(theme.accent)};`);
  }
  if (theme.font !== 'system') {
    rules.push(`--embed-font: ${FONT_STACKS[theme.font]};`);
  }

  let css = '';
  if (rules.length) {
    css += `:root { ${rules.join(' ')} }`;
  }
  if (theme.font !== 'system') {
    css += ` body { font-family: var(--embed-font); }`;
  }
  if (theme.mode === 'dark') {
    // Flip surfaces, borders, and text for a dark host page. Accent vars are
    // left as-is so the agency's brand color keeps popping against the dark UI.
    css += ` ${DARK_CSS}`;
  }
  return css ? `<style>${css}</style>` : '';
}

const DARK_CSS = `
  body { background: #14110e; color: #f2ece3; }
  header.embed-header h1, h3 { color: #f7f1e8; }
  header.embed-header .effective, .empty, footer.embed-footer, footer.embed-footer a { color: #b8ac9b; }
  .today-banner { background: #241d15; border-color: #3a2f22; color: #d8cab2; }
  .today-banner .sep { color: #8a7350; }
  .schedule-scroll, .departures, .route-list a { background: #1d1813; border-color: #3a2f22; }
  table.schedule thead th, table.schedule .corner, table.schedule .stop-name { background: #1d1813; color: #d8cab2; border-color: #2c241a; }
  table.schedule td, table.schedule th { border-color: #2c241a; }
  table.schedule .stop-name { color: #f2ece3; border-right-color: #3a2f22; }
  .service-tabs, .embed-nav { border-bottom-color: #3a2f22; }
  .service-tabs a, .embed-nav a { color: #e7ddcd; }
  .service-tabs a.expired { color: #a2947f; }
  .service-note { color: #b8ac9b; }
  .route-list a { color: #f2ece3; }
  .route-list a:hover { background: #241d15; }
  .dep-time, .dep-route, .dep-headsign { color: #f2ece3; }
  .map { border-color: #3a2f22; }
`;

/**
 * Multiply each RGB channel by 0.7 to produce a "deep" accent for hover/active
 * states. Input is 6-char hex with no leading "#"; output matches that shape.
 * (Duplicated from layout.ts's private helper to keep theme.ts self-contained.)
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
