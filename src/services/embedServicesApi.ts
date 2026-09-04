// Client for the published feed's service-profile catalogue,
// GET <feeds origin>/<slug>/api/v1/services (worker/embeds/api.ts:apiServices).
//
// Read from the PUBLISHED snapshot rather than derived from live editor state
// on purpose. The embed pages resolve `?service=<id>` against the published
// calendars; if the panel computed ids from the editor's in-progress calendars,
// then editing calendar.txt and copying a snippet before republishing would
// emit an id the embed can't resolve — and the embed would fall back to today's
// service with no error anywhere. Same source, same ids, always.

import type { ServiceProfile } from '../../shared/serviceProfiles';

/** A published service profile, plus the routes that actually run it. */
export interface EmbedServiceProfile extends ServiceProfile {
  routeIds: string[];
  // Whether the pattern's date range has already ended, as judged by the
  // server against the agency's own today (#71). The rider-facing embed hides
  // expired patterns; the picker deliberately shows them, marked — an agency
  // may want to pin a seasonal pattern before its season, or work out why one
  // stopped appearing publicly.
  expired: boolean;
}

/** Wire shape — snake_case, like the rest of the read-only JSON API. */
interface ServiceWire {
  id?: string;
  label?: string;
  service_ids?: string[];
  route_ids?: string[];
  end_date?: string | null;
  expired?: boolean;
}

interface ServicesResponse {
  services?: ServiceWire[];
}

/**
 * Fetch the profiles a feed publishes. Throws on a non-2xx (403 when the owner
 * lacks `embeds`, 404 before the first publish) so the caller can degrade the
 * picker rather than silently offering an empty list.
 */
export async function fetchEmbedServiceProfiles(
  feedsOrigin: string,
  slug: string,
  signal?: AbortSignal,
): Promise<EmbedServiceProfile[]> {
  const url = `${feedsOrigin.replace(/\/$/, '')}/${encodeURIComponent(slug)}/api/v1/services`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Could not load service patterns (HTTP ${res.status})`);
  }
  const body = (await res.json()) as ServicesResponse;
  return (body.services ?? [])
    .filter((s): s is ServiceWire & { id: string; label: string } =>
      typeof s?.id === 'string' && typeof s?.label === 'string')
    .map((s) => ({
      id: s.id,
      label: s.label,
      serviceIds: s.service_ids ?? [],
      routeIds: s.route_ids ?? [],
      // Both default to "not expired" so a server that hasn't shipped the
      // fields yet degrades to the old behaviour — every pattern offered
      // unmarked — rather than labelling live patterns as ended.
      endDate: s.end_date ?? '',
      expired: s.expired === true,
    }));
}
