import { apiRequest, ApiError, type ApiErrorCode, DEFAULT_HEADERS as BASE_HEADERS } from './apiClient';

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  ownerType: string;
  ownerId: string;
  workingStateVersion: number;
  workingStateSize: number | null;
  workingStateUpdatedAt: number | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  snapshotCount?: number;
  lastSnapshotCreatedAt?: number | null;
  /**
   * True when the feed has a live canonical publication served at
   * FEEDS_ORIGIN/<slug>/gtfs.zip. Set by the list endpoint; the importer's
   * "My feeds" source shows it as a published/draft label (informational only —
   * every feed is importable from its working state regardless).
   */
  published?: boolean;
  /** 6-char hex without leading "#"; null = use default coral. */
  brandPrimaryColor?: string | null;
  /** Absolute URL of the small route-map thumbnail; null when none generated. */
  thumbnailUrl?: string | null;
  /**
   * Lock guard (issue #36). A locked feed pins to the top of the feed list,
   * can't be renamed/deleted, and opens in the editor as a detached draft
   * (Save → Save As). Enforced server-side too.
   */
  locked: boolean;
  /** SPDX short identifier for the feed's declared license, e.g. 'CC-BY-4.0'. */
  licenseSpdx?: string | null;
}

export interface ProjectQuota {
  projects: { used: number; limit: number };
  warning: string | null;
}

export interface ProjectSnapshot {
  id: string;
  label: string | null;
  createdAt: number;
  createdByUserId?: string | null;
  zipSize?: number;
  validationErrors: number;
  validationWarnings: number;
  summary: SnapshotSummary | null;
}

export interface SnapshotSummary {
  routeCount?: number;
  stopCount?: number;
  tripCount?: number;
  serviceDayCount?: number;
  feedStartDate?: string | null;
  feedEndDate?: string | null;
  revenueHoursWeekly?: number;
  [key: string]: unknown;
}

export interface ProjectDetail extends ProjectSummary {
  snapshots: ProjectSnapshot[];
}

export interface ListProjectsResponse {
  projects: ProjectSummary[];
  quota: ProjectQuota;
}

/**
 * A soft-deleted feed (issue #63 — delete protection). Returned by
 * `GET /api/projects/deleted`; carries the same fields as ProjectSummary plus
 * when it was deleted and when it will be permanently purged.
 */
export interface DeletedProjectSummary extends ProjectSummary {
  deletedAt: number;
  purgeAt: number;
}

export interface ListDeletedProjectsResponse {
  projects: DeletedProjectSummary[];
}

export class ConflictError extends ApiError {
  currentVersion: number;
  constructor(message: string, currentVersion: number) {
    super('conflict', message, 409);
    this.name = 'ConflictError';
    this.currentVersion = currentVersion;
  }
}

async function parseErrorResponse(res: Response): Promise<ApiError> {
  let code: ApiErrorCode = 'unknown';
  let message = res.statusText || 'Request failed';
  let extra: Record<string, unknown> = {};
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      const data = await res.json();
      if (data && typeof data === 'object') {
        if (typeof data.error === 'string') code = data.error as ApiErrorCode;
        if (typeof data.message === 'string') message = data.message;
        extra = data as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }
  if (res.status === 409 && typeof extra.currentVersion === 'number') {
    return new ConflictError(message, extra.currentVersion);
  }
  // Pass the full parsed payload through as `extra` (matching apiClient's
  // default mode) so callers like PublishPanel can read error details —
  // e.g. rt_breakage's `removed`, validation_failed's `issues`.
  return new ApiError(code, message, res.status, extra);
}

function requestJson<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  return apiRequest<T>(path, init, { parseError: parseErrorResponse });
}

export function listProjects(
  opts: { includeArchived?: boolean; scope?: string } = {},
): Promise<ListProjectsResponse> {
  const params = new URLSearchParams();
  if (opts.includeArchived) params.set('include_archived', '1');
  if (opts.scope && opts.scope !== 'personal') params.set('scope', opts.scope);
  const q = params.toString();
  return requestJson<ListProjectsResponse>(`/api/projects${q ? '?' + q : ''}`);
}

export function createProject(input: {
  name: string;
  description?: string;
  slug?: string;
  owner?: { type: 'user' } | { type: 'org'; id: string };
}): Promise<ProjectSummary> {
  return requestJson<ProjectSummary>('/api/projects', { method: 'POST', body: input });
}

export function getProject(id: string): Promise<ProjectDetail> {
  return requestJson<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`);
}

export function patchProject(
  id: string,
  input: {
    name?: string;
    description?: string | null;
    slug?: string;
    archivedAt?: null | 'now';
    brandPrimaryColor?: string | null;
    locked?: boolean;
  },
): Promise<ProjectSummary> {
  return requestJson<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  });
}

/**
 * Lock or unlock a feed (issue #36). Routed through PATCH; the server requires
 * admin-level access (same level that can delete the project).
 */
export function setProjectLocked(id: string, locked: boolean): Promise<ProjectSummary> {
  return patchProject(id, { locked });
}

/**
 * Soft-delete a feed (issue #63). Rejects with a 409 ApiError when the feed is
 * currently published or locked — pass `unpublish: true` to unpublish and
 * delete in one call (the combined action MyFeedsPage offers once the user
 * confirms they want to take the feed down).
 */
export function deleteProject(id: string, opts: { unpublish?: boolean } = {}): Promise<void> {
  const q = opts.unpublish ? '?unpublish=1' : '';
  return requestJson<void>(`/api/projects/${encodeURIComponent(id)}${q}`, { method: 'DELETE' });
}

/**
 * List the caller's soft-deleted feeds for the "Recently deleted" trash view
 * (issue #63). Scoped the same way as listProjects (personal vs org
 * workspace) so an org's trash isn't mixed with the caller's personal one.
 */
export function listDeletedProjects(
  opts: { scope?: string } = {},
): Promise<ListDeletedProjectsResponse> {
  const params = new URLSearchParams();
  if (opts.scope && opts.scope !== 'personal') params.set('scope', opts.scope);
  const q = params.toString();
  return requestJson<ListDeletedProjectsResponse>(`/api/projects/deleted${q ? '?' + q : ''}`);
}

/**
 * Restore a soft-deleted feed (issue #63). The restored project's slug may
 * differ from the one it had before deletion if another feed claimed that
 * slug in the meantime (the server assigns a free suffixed slug) — callers
 * should compare against the pre-delete slug and tell the user when it changed.
 */
export function restoreProject(id: string): Promise<ProjectSummary> {
  return requestJson<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
  });
}

export interface TransferResult {
  project: ProjectSummary;
  slugChanged: boolean;
  previousSlug: string;
}

export function transferProject(
  id: string,
  destination: { type: 'user' } | { type: 'org'; id: string },
): Promise<TransferResult> {
  return requestJson<TransferResult>(`/api/projects/${encodeURIComponent(id)}/transfer`, {
    method: 'POST',
    body: { destination },
  });
}

/**
 * Duplicate a server feed into the SAME workspace (user or org). Returns the
 * new project, shaped like create. Only the editable working state is copied —
 * publications, snapshots, draft links, scheduled publishes, and RT sources are
 * not. Requires editor+ access on the source (server-enforced). Quota and
 * permission failures surface as ApiError.
 */
export function duplicateProject(id: string): Promise<ProjectSummary> {
  return requestJson<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/duplicate`, {
    method: 'POST',
  });
}

async function gzipString(input: string): Promise<Blob> {
  const stream = new Blob([input], { type: 'application/json' })
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

/**
 * Why the server had no working state to hand back. The two cases used to be
 * indistinguishable — both a bare 404 — which meant genuine data loss was
 * invisible, reported to the user as "that feed has no routes yet" and counted
 * in telemetry as a boring empty feed.
 *
 *   never_saved  — `working_state_r2_key IS NULL`. Normal for a fresh feed.
 *   blob_missing — the key is recorded but the R2 object is gone. Data loss.
 */
export type WorkingStateAbsence = 'never_saved' | 'blob_missing';

export interface WorkingStateResult {
  snapshot: Record<string, unknown> | null;
  version: number;
  /** Set only when the server returned no working state. */
  absent?: WorkingStateAbsence;
  /**
   * Total saved versions on this feed. Always populated by the server (header
   * on 200, body field on 404); `undefined` only against an older worker.
   */
  snapshotCount?: number;
}

function parseCount(raw: unknown): number | undefined {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export async function fetchWorkingState(projectId: string): Promise<WorkingStateResult> {
  let res: Response;
  try {
    res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/working-state`, {
      method: 'GET',
      credentials: 'include',
      headers: { ...BASE_HEADERS },
    });
  } catch (e) {
    throw new ApiError('network_error', (e as Error)?.message ?? 'Network error', 0);
  }

  if (res.status === 404) {
    // No working state — but WHICH 404? The body carries `reason` and
    // `snapshotCount`; fall back to getProject for the version (and for an
    // older worker that sends neither).
    let reason: WorkingStateAbsence | undefined;
    let snapshotCount: number | undefined;
    try {
      const body = (await res.json()) as { reason?: string; snapshotCount?: number };
      if (body?.reason === 'blob_missing' || body?.reason === 'never_saved') reason = body.reason;
      snapshotCount = parseCount(body?.snapshotCount);
    } catch {
      // Non-JSON 404 — fall through to the getProject path below.
    }
    const detail = await getProject(projectId);
    return {
      snapshot: null,
      version: detail.workingStateVersion,
      // An unlabelled 404 from an older worker still tells us which case it is:
      // a recorded key with no blob is exactly `blob_missing`.
      absent: reason ?? (detail.workingStateVersion > 0 ? 'blob_missing' : 'never_saved'),
      snapshotCount: snapshotCount ?? parseCount(detail.snapshotCount) ?? detail.snapshots?.length,
    };
  }
  if (!res.ok) throw await parseErrorResponse(res);

  const versionHeader = res.headers.get('X-Working-State-Version');
  const version = versionHeader ? parseInt(versionHeader, 10) : 0;
  const text = await res.text();
  const snapshot = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  return {
    snapshot,
    version: Number.isFinite(version) ? version : 0,
    snapshotCount: parseCount(res.headers.get('X-Snapshot-Count')),
  };
}

export async function saveWorkingState(
  projectId: string,
  snapshot: Record<string, unknown>,
  ifMatchVersion: number,
): Promise<{ workingStateVersion: number }> {
  const json = JSON.stringify(snapshot);
  const body = await gzipString(json);

  let res: Response;
  try {
    res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/working-state`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        ...BASE_HEADERS,
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'If-Match': String(ifMatchVersion),
      },
      body,
    });
  } catch (e) {
    throw new ApiError('network_error', (e as Error)?.message ?? 'Network error', 0);
  }

  if (!res.ok) throw await parseErrorResponse(res);
  return (await res.json()) as { workingStateVersion: number };
}

export async function saveSnapshot(
  projectId: string,
  input: {
    label?: string;
    summary: SnapshotSummary;
    validationErrors: number;
    validationWarnings: number;
    snapshot: Record<string, unknown>;
  },
): Promise<{ snapshot: ProjectSnapshot; workingStateVersion?: number }> {
  const gz = await gzipString(JSON.stringify(input.snapshot));
  const file = new File([gz], 'state.json.gz', { type: 'application/json' });
  const meta = {
    label: input.label,
    summary: input.summary,
    validationErrors: input.validationErrors,
    validationWarnings: input.validationWarnings,
  };

  const form = new FormData();
  form.append('state', file);
  form.append('meta', JSON.stringify(meta));

  let res: Response;
  try {
    res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/snapshots`, {
      method: 'POST',
      credentials: 'include',
      headers: { ...BASE_HEADERS },
      body: form,
    });
  } catch (e) {
    throw new ApiError('network_error', (e as Error)?.message ?? 'Network error', 0);
  }
  if (!res.ok) throw await parseErrorResponse(res);
  // `workingStateVersion` is present only when the server had to seed the
  // working state itself (a feed that had never been saved) — see the backstop
  // in the snapshot route. Callers adopt it as their new If-Match token.
  return (await res.json()) as { snapshot: ProjectSnapshot; workingStateVersion?: number };
}

export function listSnapshots(projectId: string): Promise<{ snapshots: ProjectSnapshot[] }> {
  return requestJson<{ snapshots: ProjectSnapshot[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/snapshots`,
  );
}

export async function fetchSnapshotState(
  projectId: string,
  snapshotId: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/state`,
      {
        method: 'GET',
        credentials: 'include',
        headers: { ...BASE_HEADERS },
      },
    );
  } catch (e) {
    throw new ApiError('network_error', (e as Error)?.message ?? 'Network error', 0);
  }
  if (!res.ok) throw await parseErrorResponse(res);
  return (await res.json()) as Record<string, unknown>;
}

export function restoreSnapshot(
  projectId: string,
  snapshotId: string,
): Promise<{ workingStateVersion: number }> {
  return requestJson<{ workingStateVersion: number }>(
    `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
    { method: 'POST' },
  );
}

export function deleteSnapshot(projectId: string, snapshotId: string): Promise<void> {
  return requestJson<void>(
    `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}`,
    { method: 'DELETE' },
  );
}

export interface ImportProjectItem {
  slug?: string;
  name: string;
  description?: string;
  snapshot: Record<string, unknown>;
}

export interface ImportResult {
  imported: ProjectSummary[];
  skipped: { name: string; reason: string }[];
}

async function snapshotToBase64Gzip(snapshot: Record<string, unknown>): Promise<{ base64: string; size: number }> {
  const gz = await gzipString(JSON.stringify(snapshot));
  const buf = await gz.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Build base64 in chunks to avoid call-stack overflow for large blobs.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as number[]);
  }
  return { base64: btoa(binary), size: bytes.byteLength };
}

export async function importProjects(items: ImportProjectItem[]): Promise<ImportResult> {
  const projects = await Promise.all(
    items.map(async (item) => {
      const { base64, size } = await snapshotToBase64Gzip(item.snapshot);
      return {
        slug: item.slug,
        name: item.name,
        description: item.description,
        workingState: base64,
        workingStateSize: size,
      };
    }),
  );
  return requestJson<ImportResult>('/api/projects/import', {
    method: 'POST',
    body: { projects },
  });
}

// ─── Publication, draft links ─────────────────────────────────────────────────

export interface PublicationInfo {
  projectId: string;
  snapshotId: string;
  publishedAt: number;
  canonicalUrl: string;
}

export interface PublicationHistoryEntry {
  id: string;
  snapshotId: string | null;
  action: string;
  actorUserId: string | null;
  createdAt: number;
}

export interface ScheduledPublishInfo {
  id: string;
  snapshotId: string;
  scheduledFor: number; // unix ms
  ignoreWarnings: boolean;
  /** ID-stability gates acknowledged at schedule time; the cron replays these. */
  ignoreRtBreakage: boolean;
  ignoreAgencyChurn: boolean;
  status: 'pending' | 'executed' | 'cancelled' | 'failed';
  failureReason: string | null;
}

export interface PublicationHistoryResponse {
  history: PublicationHistoryEntry[];
  current: { snapshotId: string; publishedAt: number } | null;
  scheduled: ScheduledPublishInfo | null;
}

export interface DraftLinkInfo {
  tokenHash: string;
  snapshotId: string;
  expiresAt: number;
  createdAt: number;
}

export interface CreateDraftLinkResponse {
  url: string;
  token: string;
  tokenHash: string;
  expiresAt: number;
}

async function postFormData<T>(path: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: { ...BASE_HEADERS },
      body: form,
    });
  } catch (e) {
    throw new ApiError('network_error', (e as Error)?.message ?? 'Network error', 0);
  }
  if (!res.ok) throw await parseErrorResponse(res);
  if (res.status === 204) return undefined as T;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return (await res.json()) as T;
  return undefined as T;
}

export interface PublishInput {
  snapshotId: string;
  ignoreWarnings?: boolean;
  ignoreRtBreakage?: boolean;
  /** Acknowledges the 409 `agency_id_churn` warning (removed/renamed agency_ids). */
  ignoreAgencyChurn?: boolean;
  /** SPDX short identifier for the feed's license, e.g. 'CC-BY-4.0'. */
  licenseSpdx?: string | null;
  zip?: Blob;
}

export async function publishProject(
  projectId: string,
  input: PublishInput,
): Promise<{ publication: PublicationInfo }> {
  const meta = {
    snapshotId: input.snapshotId,
    ignoreWarnings: input.ignoreWarnings,
    ignoreRtBreakage: input.ignoreRtBreakage,
    ignoreAgencyChurn: input.ignoreAgencyChurn,
    licenseSpdx: input.licenseSpdx,
  };
  if (input.zip) {
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    form.append('zip', input.zip, 'gtfs.zip');
    return postFormData<{ publication: PublicationInfo }>(
      `/api/projects/${encodeURIComponent(projectId)}/publish`,
      form,
    );
  }
  return requestJson<{ publication: PublicationInfo }>(
    `/api/projects/${encodeURIComponent(projectId)}/publish`,
    { method: 'POST', body: meta },
  );
}

export function unpublishProject(projectId: string): Promise<void> {
  return requestJson<void>(`/api/projects/${encodeURIComponent(projectId)}/unpublish`, {
    method: 'POST',
  });
}

export function rollbackPublication(
  projectId: string,
  snapshotId: string,
): Promise<{ publication: PublicationInfo }> {
  return requestJson<{ publication: PublicationInfo }>(
    `/api/projects/${encodeURIComponent(projectId)}/publish/rollback`,
    { method: 'POST', body: { snapshotId } },
  );
}

export function getPublicationHistory(
  projectId: string,
): Promise<PublicationHistoryResponse> {
  return requestJson<PublicationHistoryResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/publish/history`,
  );
}

export interface EmbedImpressions {
  window_days: number;
  since: string;
  total: number;
  by_kind: Record<string, number>;
  by_day: Record<string, number>;
  top_targets: { kind: string; target: string; views: number }[];
}

/**
 * Aggregate, privacy-respecting embed view counts for a feed (EM-131/135).
 * Read-only rollup of the public beacon counters; gated server-side by the
 * owner's `embeds` entitlement + project access.
 */
export function getEmbedImpressions(
  projectId: string,
  days = 30,
): Promise<EmbedImpressions> {
  return requestJson<EmbedImpressions>(
    `/api/projects/${encodeURIComponent(projectId)}/embed-impressions?days=${days}`,
  );
}

export interface SchedulePublishInput {
  snapshotId: string;
  scheduledFor: number;
  ignoreWarnings?: boolean;
  /**
   * The schedule endpoint runs the SAME ID-stability gates as an immediate
   * publish (409 `rt_breakage` / 409 `agency_id_churn`) — at schedule time,
   * while the user is present to acknowledge them. The acknowledgement is
   * persisted on the scheduled row and replayed by the cron at fire time.
   */
  ignoreRtBreakage?: boolean;
  ignoreAgencyChurn?: boolean;
  zip?: Blob;
}

export function schedulePublish(
  projectId: string,
  input: SchedulePublishInput,
): Promise<{ scheduled: ScheduledPublishInfo }> {
  const meta = {
    snapshotId: input.snapshotId,
    scheduledFor: input.scheduledFor,
    ignoreWarnings: input.ignoreWarnings,
    ignoreRtBreakage: input.ignoreRtBreakage,
    ignoreAgencyChurn: input.ignoreAgencyChurn,
  };
  if (input.zip) {
    // The cron has no client to render the GTFS ZIP at fire time, so we upload
    // the rendered ZIP now (multipart) and the server persists it on the snapshot.
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    form.append('zip', input.zip, 'gtfs.zip');
    return postFormData<{ scheduled: ScheduledPublishInfo }>(
      `/api/projects/${encodeURIComponent(projectId)}/publish/schedule`,
      form,
    );
  }
  return requestJson<{ scheduled: ScheduledPublishInfo }>(
    `/api/projects/${encodeURIComponent(projectId)}/publish/schedule`,
    { method: 'POST', body: meta },
  );
}

export function cancelScheduledPublish(projectId: string): Promise<{ cancelled: boolean }> {
  return requestJson<{ cancelled: boolean }>(
    `/api/projects/${encodeURIComponent(projectId)}/publish/schedule`,
    { method: 'DELETE' },
  );
}

export interface CreateDraftLinkInput {
  snapshotId: string;
  ttlDays?: number;
  zip?: Blob;
}

export async function createDraftLink(
  projectId: string,
  input: CreateDraftLinkInput,
): Promise<CreateDraftLinkResponse> {
  const meta = { snapshotId: input.snapshotId, ttlDays: input.ttlDays };
  if (input.zip) {
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    form.append('zip', input.zip, 'gtfs.zip');
    return postFormData<CreateDraftLinkResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/draft-links`,
      form,
    );
  }
  return requestJson<CreateDraftLinkResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/draft-links`,
    { method: 'POST', body: meta },
  );
}

export function listDraftLinks(projectId: string): Promise<{ links: DraftLinkInfo[] }> {
  return requestJson<{ links: DraftLinkInfo[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/draft-links`,
  );
}

export function revokeDraftLink(projectId: string, tokenHash: string): Promise<void> {
  return requestJson<void>(
    `/api/projects/${encodeURIComponent(projectId)}/draft-links/${encodeURIComponent(tokenHash)}`,
    { method: 'DELETE' },
  );
}
