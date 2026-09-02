// Unit tests for the embed snippet query builder (src/components/embed/embedOptions.ts).
//
// The load-bearing case is the LAST group: the system-map embed does not accept
// a `service` param, so a service pin must never reach its snippet. If it did,
// the copied iframe would carry a param the page ignores — which looks like the
// pin working while it silently does nothing.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMBED_OPTIONS,
  optionsQuery,
  servicePinApplies,
  type EmbedOptions,
} from '../embedOptions';

function opts(over: Partial<EmbedOptions> = {}): EmbedOptions {
  return { ...DEFAULT_EMBED_OPTIONS, ...over };
}

describe('optionsQuery', () => {
  it('is empty when every option is at its default', () => {
    expect(optionsQuery(opts())).toBe('');
    expect(optionsQuery(opts(), { includeService: true })).toBe('');
  });

  it('emits only the non-default theming params', () => {
    expect(optionsQuery(opts({ accent: 'ff0000' }))).toBe('?accent=ff0000');
    expect(optionsQuery(opts({ mode: 'dark' }))).toBe('?theme=dark');
    expect(optionsQuery(opts({ font: 'serif' }))).toBe('?font=serif');
    expect(optionsQuery(opts({ lang: 'es' }))).toBe('?lang=es');
    // Defaults stay off the wire.
    expect(optionsQuery(opts({ mode: 'light', font: 'system', lang: '' }))).toBe('');
  });

  it('combines params in a stable order', () => {
    const q = optionsQuery(opts({ accent: 'abcdef', mode: 'dark', font: 'mono', lang: 'fr' }));
    expect(q).toBe('?accent=abcdef&theme=dark&font=mono&lang=fr');
  });

  // ─── The service pin ──────────────────────────────────────────────────────

  it('emits service= only when a profile is pinned and the embed accepts one', () => {
    expect(optionsQuery(opts({ service: 'svc-1rbulw' }), { includeService: true })).toBe(
      '?service=svc-1rbulw',
    );
  });

  it('treats an empty service as "automatic" and omits the param', () => {
    expect(optionsQuery(opts({ service: '' }), { includeService: true })).toBe('');
  });

  it('appends service after the theming params', () => {
    expect(optionsQuery(opts({ mode: 'dark', service: 'svc-x' }), { includeService: true })).toBe(
      '?theme=dark&service=svc-x',
    );
  });

  it('url-encodes the service id', () => {
    expect(optionsQuery(opts({ service: 'svc a&b' }), { includeService: true })).toBe(
      '?service=svc+a%26b',
    );
  });

  it('NEVER emits service= for embeds that do not accept it (the system map)', () => {
    // includeService defaults to false — the system-map call site relies on that.
    expect(optionsQuery(opts({ service: 'svc-1rbulw' }))).toBe('');
    expect(optionsQuery(opts({ service: 'svc-1rbulw' }), {})).toBe('');
    expect(optionsQuery(opts({ service: 'svc-1rbulw' }), { includeService: false })).toBe('');
    // …and it doesn't drop the theming params on the way.
    expect(optionsQuery(opts({ service: 'svc-1rbulw', mode: 'dark', lang: 'es' }))).toBe(
      '?theme=dark&lang=es',
    );
  });
});

describe('servicePinApplies', () => {
  const saturday = { routeIds: ['R1', 'R3'] };

  it('applies to a route that runs the pinned pattern', () => {
    expect(servicePinApplies(saturday, 'R1')).toBe(true);
    expect(servicePinApplies(saturday, 'R3')).toBe(true);
  });

  it('does not apply to a route with no trips on the pinned pattern', () => {
    // Emitting the pin here would render an empty schedule, not a fallback.
    expect(servicePinApplies(saturday, 'R2')).toBe(false);
    expect(servicePinApplies(saturday, 'nonexistent')).toBe(false);
  });

  it('applies everywhere when nothing is pinned (automatic)', () => {
    expect(servicePinApplies(null, 'R1')).toBe(true);
    expect(servicePinApplies(null, 'R2')).toBe(true);
  });

  it('applies nowhere for a profile the feed runs on no route', () => {
    expect(servicePinApplies({ routeIds: [] }, 'R1')).toBe(false);
  });

  it('matches route ids exactly, not by prefix', () => {
    expect(servicePinApplies({ routeIds: ['R1'] }, 'R10')).toBe(false);
  });
});
