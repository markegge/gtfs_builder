import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulidx';
import type { AppContext, AuthedUser, Env } from '../env';
import { requireAuth } from '../auth/middleware';
import {
  conflict,
  forbidden,
  notFound,
  validationFailed,
  ApiError,
} from '../util/errors';
import { logAudit } from '../util/audit';
import { clientIp } from '../util/rateLimit';
import { generateToken, sha256Hex } from '../util/crypto';
import { performPublish } from '../publication/performPublish';
import { assertIdStable } from '../publication/idStability';
import { getOrgMembership, roleAtLeast, type OrgRole } from '../orgs/routes';
import { isValidSlug, slugify, uniqueSlug } from './slug';
import {
  countProjects,
  countSnapshots,
  enforceBlobSize,
  enforceQuota,
  getOwnerQuotas,
  type OwnerType,
} from './quotas';
import {
  requirePublishAccess,
  requireDraftLinkAccess,
  requireOwnerFeature,
} from '../billing/middleware';
import {
  deleteFeedBlob,
  draftZipKey,
  getFeedBlob,
  publicationZipKey,
  putFeedBlob,
  snapshotStateKey,
  snapshotZipKey,
  workingStateKey,
} from './r2';
import {
  maybeRegenerateThumbnail,
  parseFeedStateFromGzip,
} from '../embeds/thumbnail';
// Retention window for the trash. Owned by the reaper that enforces it, so the
// "purged in N days" the UI shows and the day the row actually dies are the
// same number by construction.
import { PROJECT_DELETE_GRACE_MS } from '../cron/tasks';

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  owner_type: string;
  owner_id: string;
  working_state_r2_key: string | null;
  working_state_version: number;
  working_state_size: number | null;
  working_state_updated_at: number | null;
  archived_at: number | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  brand_primary_color: string | null;
  locked: number;
  // SPDX license identifier for the published feed (migration 0024), set from
  // the publish dialog. NTD IDs are NOT here — they live on the agency, inside
  // the feed (agency.external_id).
  license_spdx: string | null;
  thumbnail_version?: number | null;
}

interface SnapshotRow {
  id: string;
  project_id: string;
  label: string | null;
  created_by_user_id: string | null;
  state_r2_key: string;
  zip_r2_key: string;
  zip_size: number;
  summary_json: string;
  validation_errors: number;
  validation_warnings: number;
  created_at: number;
}

export async function parseJson<T extends z.ZodTypeAny>(
  c: { req: { json: () => Promise<unknown> } },
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw validationFailed('Invalid JSON body');
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw validationFailed('Invalid request', { issues: result.error.issues });
  }
  return result.data;
}

function shapeProject(row: ProjectRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    workingStateVersion: row.working_state_version,
    workingStateSize: row.working_state_size,
    workingStateUpdatedAt: row.working_state_updated_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    brandPrimaryColor: row.brand_primary_color,
    locked: row.locked === 1,
    licenseSpdx: row.license_spdx ?? null,
  };
}

function shapeSnapshot(row: SnapshotRow) {
  let summary: unknown = null;
  try {
    summary = JSON.parse(row.summary_json);
  } catch {
    // malformed summary_json — leave summary null
  }
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id,
    zipSize: row.zip_size,
    validationErrors: row.validation_errors,
    validationWarnings: row.validation_warnings,
    summary,
  };
}

type ProjectAccess = 'personal' | `org:${OrgRole}`;
type RequiredProjectLevel = 'viewer' | 'editor' | 'admin';

interface ProjectAccessResult {
  row: ProjectRow;
  access: ProjectAccess;
}

const ACCESS_RANK: Record<RequiredProjectLevel, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
};

/**
 * Load a project and the caller's access to it. Returns 404 (not 403) when
 * the caller has no access, mirroring the cross-user isolation policy.
 *
 * `access` is one of:
 *   'personal' — project owned by the user directly (always full permission);
 *   'org:<role>' — the project is owned by an org the user belongs to.
 *
 * `required` gates access for this operation:
 *   'viewer'  — any member (or personal owner) may access
 *   'editor'  — org editor+ (viewer denied → 403)
 *   'admin'   — org admin+ (only admins/owners can delete org projects)
 * Personal owners always satisfy every level.
 */
export async function requireOwnedProject(
  env: Env,
  user: AuthedUser,
  projectId: string,
  required: RequiredProjectLevel = 'viewer',
): Promise<ProjectAccessResult> {
  const row = await env.DB.prepare(
    `SELECT id, slug, name, description, owner_type, owner_id,
            working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
            archived_at, deleted_at, created_at, updated_at, brand_primary_color, locked,
            license_spdx
       FROM feed_project WHERE id = ?`,
  )
    .bind(projectId)
    .first<ProjectRow>();
  if (!row || row.deleted_at !== null) throw notFound('Project not found');

  if (row.owner_type === 'user') {
    if (row.owner_id !== user.id) throw notFound('Project not found');
    return { row, access: 'personal' };
  }

  if (row.owner_type === 'org') {
    const membership = await getOrgMembership(env, row.owner_id, user.id);
    if (!membership) throw notFound('Project not found');
    // Map org role to the highest project-level it satisfies.
    const orgAccessLevel: RequiredProjectLevel =
      membership.role === 'viewer'
        ? 'viewer'
        : membership.role === 'editor'
          ? 'editor'
          : 'admin'; // admin + owner both satisfy 'admin'
    if (ACCESS_RANK[orgAccessLevel] < ACCESS_RANK[required]) {
      throw forbidden('You do not have permission to perform this action');
    }
    return { row, access: `org:${membership.role}` };
  }

  throw notFound('Project not found');
}

/**
 * The mirror of requireOwnedProject for the trash routes: load a SOFT-DELETED
 * project the caller is allowed to act on. requireOwnedProject deliberately
 * 404s on deleted rows (they're gone as far as every other route is concerned),
 * so restore needs its own loader.
 *
 * Gated at delete-grade access ('admin' on org-owned feeds) — whoever could
 * delete a feed is exactly whoever can bring it back.
 */
async function requireDeletedProject(env: Env, user: AuthedUser, projectId: string): Promise<ProjectRow> {
  const row = await env.DB.prepare(
    `SELECT id, slug, name, description, owner_type, owner_id,
            working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
            archived_at, deleted_at, created_at, updated_at, brand_primary_color, locked
       FROM feed_project WHERE id = ?`,
  )
    .bind(projectId)
    .first<ProjectRow>();
  if (!row || row.deleted_at === null) throw notFound('Project not found');

  if (row.owner_type === 'user') {
    if (row.owner_id !== user.id) throw notFound('Project not found');
    return row;
  }

  if (row.owner_type === 'org') {
    const membership = await getOrgMembership(env, row.owner_id, user.id);
    if (!membership) throw notFound('Project not found');
    if (!roleAtLeast(membership.role, 'admin')) {
      throw forbidden('You do not have permission to perform this action');
    }
    return row;
  }

  throw notFound('Project not found');
}

/**
 * Resolve the `scope` query param (`personal` | `org:<id>`) that GET / and
 * GET /deleted share, checking org membership. Any member can LIST a workspace's
 * feeds (acting on one is gated separately).
 */
async function resolveListScope(
  env: Env,
  user: AuthedUser,
  scope: string,
): Promise<{ ownerType: 'user' | 'org'; ownerId: string }> {
  if (scope === 'personal') {
    return { ownerType: 'user', ownerId: user.id };
  }
  if (scope.startsWith('org:')) {
    const ownerId = scope.slice(4);
    if (!ownerId) throw validationFailed('Invalid scope');
    const membership = await getOrgMembership(env, ownerId, user.id);
    if (!membership) throw notFound('Organization not found');
    return { ownerType: 'org', ownerId };
  }
  throw validationFailed('scope must be "personal" or "org:<id>"');
}

async function requireOwnedSnapshot(env: Env, projectId: string, snapshotId: string): Promise<SnapshotRow> {
  const row = await env.DB.prepare(
    `SELECT id, project_id, label, created_by_user_id, state_r2_key, zip_r2_key, zip_size,
            summary_json, validation_errors, validation_warnings, created_at
       FROM feed_snapshot WHERE id = ? AND project_id = ?`,
  )
    .bind(snapshotId, projectId)
    .first<SnapshotRow>();
  if (!row) throw notFound('Snapshot not found');
  return row;
}

function setQuotaWarningHeader(c: { header: (k: string, v: string) => void }, warning: string | null) {
  if (warning) c.header('X-Quota-Warning', warning);
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  slug: z.string().optional(),
  owner: z
    .object({
      type: z.enum(['user', 'org']),
      id: z.string().optional(),
    })
    .optional(),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  slug: z.string().optional(),
  archivedAt: z.union([z.null(), z.literal('now')]).optional(),
  // 6-char hex without leading "#", or null to clear.
  brandPrimaryColor: z.union([z.string().regex(/^[0-9a-fA-F]{6}$/), z.null()]).optional(),
  // Lock/unlock the feed (issue #36). Toggling requires admin-level access
  // (the same level that can delete the project) — see the handler below.
  locked: z.boolean().optional(),
});

const importItemSchema = z.object({
  slug: z.string().optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  workingState: z.string().min(1),
  workingStateSize: z.number().int().nonnegative(),
});

const importSchema = z.object({
  projects: z.array(importItemSchema).max(50),
});

const snapshotMetaSchema = z.object({
  label: z.string().trim().max(200).optional(),
  summary: z.record(z.string(), z.unknown()),
  validationErrors: z.number().int().nonnegative(),
  validationWarnings: z.number().int().nonnegative(),
});

export const projectsRouter = new Hono<AppContext>();

projectsRouter.use('*', requireAuth);

projectsRouter.post('/', async (c) => {
  const user = c.var.user!;
  const body = await parseJson(c, createSchema);

  // Determine owner. Default = personal (user).
  const ownerType: 'user' | 'org' = body.owner?.type ?? 'user';
  let ownerId: string;
  if (ownerType === 'user') {
    ownerId = user.id;
  } else {
    if (!body.owner?.id) {
      throw validationFailed('owner.id is required when owner.type is org');
    }
    ownerId = body.owner.id;
    const membership = await getOrgMembership(c.env, ownerId, user.id);
    if (!membership) throw notFound('Organization not found');
    if (!roleAtLeast(membership.role, 'editor')) {
      throw forbidden('Editor role or higher required to create projects in this organization');
    }
  }

  const ownerQuotas = await getOwnerQuotas(c.env, ownerType, ownerId);
  const used = await countProjects(c.env, ownerType, ownerId);
  const { warning } = enforceQuota(c.env, 'projects', used, ownerQuotas.projects, { hard: true });
  setQuotaWarningHeader(c, warning);

  let desiredSlug: string;
  if (body.slug !== undefined) {
    if (!isValidSlug(body.slug)) {
      throw validationFailed('Invalid slug — lowercase ASCII letters/digits/dashes, must start with letter or digit, max 63 chars');
    }
    desiredSlug = body.slug;
  } else {
    desiredSlug = slugify(body.name);
  }
  const finalSlug = await uniqueSlug(c.env, ownerType, ownerId, desiredSlug);

  const now = Date.now();
  const id = ulid();
  await c.env.DB.prepare(
    `INSERT INTO feed_project
       (id, slug, name, description, owner_type, owner_id,
        working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
        archived_at, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)`,
  )
    .bind(id, finalSlug, body.name, body.description ?? null, ownerType, ownerId, now, now)
    .run();

  const row = await c.env.DB.prepare(
    `SELECT id, slug, name, description, owner_type, owner_id,
            working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
            archived_at, deleted_at, created_at, updated_at, brand_primary_color, locked,
            license_spdx
       FROM feed_project WHERE id = ?`,
  )
    .bind(id)
    .first<ProjectRow>();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'project',
    subjectId: id,
    action: 'project.create',
    metadata: { slug: finalSlug, name: body.name, ownerType, ownerId },
    ip: clientIp(c.req.raw),
  });

  return c.json(shapeProject(row!), 201);
});

projectsRouter.get('/', async (c) => {
  const user = c.var.user!;
  const includeArchived = c.req.query('include_archived') === '1';
  const { ownerType, ownerId } = await resolveListScope(c.env, user, c.req.query('scope') ?? 'personal');

  const archivedFilter = includeArchived ? '' : ' AND archived_at IS NULL';
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.name, p.description, p.owner_type, p.owner_id,
            p.working_state_r2_key, p.working_state_version, p.working_state_size, p.working_state_updated_at,
            p.archived_at, p.deleted_at, p.created_at, p.updated_at, p.brand_primary_color, p.locked, p.thumbnail_version,
            (SELECT COUNT(*) FROM feed_snapshot v WHERE v.project_id = p.id) AS snapshot_count,
            (SELECT MAX(v.created_at) FROM feed_snapshot v WHERE v.project_id = p.id) AS last_snapshot_created_at,
            EXISTS(SELECT 1 FROM publication pub WHERE pub.project_id = p.id) AS is_published
       FROM feed_project p
       WHERE p.owner_type = ? AND p.owner_id = ? AND p.deleted_at IS NULL${archivedFilter}
       ORDER BY COALESCE(p.working_state_updated_at, p.updated_at) DESC`,
  )
    .bind(ownerType, ownerId)
    .all<ProjectRow & { snapshot_count: number; last_snapshot_created_at: number | null; is_published: number }>();

  const feedsOrigin = c.env.FEEDS_ORIGIN.replace(/\/$/, '');
  const projects = (rows.results ?? []).map((r) => ({
    ...shapeProject(r),
    snapshotCount: r.snapshot_count,
    lastSnapshotCreatedAt: r.last_snapshot_created_at,
    // Whether this feed has a live canonical publication at
    // FEEDS_ORIGIN/<slug>/gtfs.zip. The importer's "My feeds" source uses this
    // to only offer published feeds (v1 imports from the stable published feed).
    published: !!r.is_published,
    thumbnailUrl: r.thumbnail_version
      ? `${feedsOrigin}/${r.slug}/thumbnail-sm.png?v=${r.thumbnail_version}`
      : null,
  }));

  const ownerQuotas = await getOwnerQuotas(c.env, ownerType, ownerId);
  const used = await countProjects(c.env, ownerType, ownerId);
  const warnAt = Math.floor(ownerQuotas.projects * 0.9);
  const warning = used >= warnAt ? `${used}/${ownerQuotas.projects}` : null;

  return c.json({
    projects,
    quota: {
      projects: { used, limit: ownerQuotas.projects },
      plan: ownerQuotas.plan,
      warning,
    },
  });
});

// ─── GET /api/projects/deleted — the trash ────────────────────────────────────
//
// Soft-deleted feeds for a workspace (?scope=personal | org:<id>, same rules as
// GET /), newest deletion first. `purgeAt` = deleted_at + PROJECT_DELETE_GRACE_MS
// — when the nightly reaper will erase it for good, so the UI can say
// "purged in N days".
//
// MUST stay registered ahead of GET /:id — '/deleted' would otherwise be read
// as a project id.
projectsRouter.get('/deleted', async (c) => {
  const user = c.var.user!;
  const { ownerType, ownerId } = await resolveListScope(c.env, user, c.req.query('scope') ?? 'personal');

  // Same select as GET / (minus the publication/thumbnail extras — a deleted
  // feed is by definition unpublished, and the trash doesn't show thumbnails).
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.name, p.description, p.owner_type, p.owner_id,
            p.working_state_r2_key, p.working_state_version, p.working_state_size, p.working_state_updated_at,
            p.archived_at, p.deleted_at, p.created_at, p.updated_at, p.brand_primary_color, p.locked,
            (SELECT COUNT(*) FROM feed_snapshot v WHERE v.project_id = p.id) AS snapshot_count
       FROM feed_project p
       WHERE p.owner_type = ? AND p.owner_id = ? AND p.deleted_at IS NOT NULL
       ORDER BY p.deleted_at DESC`,
  )
    .bind(ownerType, ownerId)
    .all<ProjectRow & { snapshot_count: number }>();

  const projects = (rows.results ?? []).map((r) => ({
    ...shapeProject(r),
    snapshotCount: r.snapshot_count,
    deletedAt: r.deleted_at,
    purgeAt: (r.deleted_at ?? 0) + PROJECT_DELETE_GRACE_MS,
  }));

  return c.json({ projects, retentionMs: PROJECT_DELETE_GRACE_MS });
});

projectsRouter.get('/:id', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row, access } = await requireOwnedProject(c.env, user, id, 'viewer');

  const snapshots = await c.env.DB.prepare(
    `SELECT id, project_id, label, created_by_user_id, state_r2_key, zip_r2_key, zip_size,
            summary_json, validation_errors, validation_warnings, created_at
       FROM feed_snapshot WHERE project_id = ?
       ORDER BY created_at DESC LIMIT 20`,
  )
    .bind(id)
    .all<SnapshotRow>();

  return c.json({
    ...shapeProject(row),
    access,
    // `snapshots` is capped at 20 for display; snapshotCount is the true total,
    // which is what the "live state is empty but N versions exist" warning has
    // to quote. fetchWorkingState reads it on the 404 path.
    snapshotCount: await countSnapshots(c.env, row.id),
    snapshots: (snapshots.results ?? []).map(shapeSnapshot),
  });
});

projectsRouter.patch('/:id', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const body = await parseJson(c, patchSchema);
  // PATCH (rename, slug, archive, brand color, and lock/unlock) all require
  // editor-level access. Lock/unlock is intentionally editor-grade — any
  // collaborator who can edit a feed can also protect it (and undo that
  // protection) — rather than delete-grade admin.
  const { row: current } = await requireOwnedProject(c.env, user, id, 'editor');

  // Rename/slug on a locked feed is exactly what the lock protects against.
  // Refuse those (the client also disables them) unless the same request is
  // unlocking the feed.
  const mutatesProtectedFields = body.name !== undefined || body.slug !== undefined;
  const willBeLocked = body.locked !== undefined ? body.locked : current.locked === 1;
  if (current.locked === 1 && mutatesProtectedFields && willBeLocked) {
    throw conflict('This feed is locked. Unlock it before renaming.');
  }

  const updates: string[] = [];
  const binds: unknown[] = [];

  if (body.locked !== undefined) {
    updates.push('locked = ?');
    binds.push(body.locked ? 1 : 0);
  }
  if (body.name !== undefined) {
    updates.push('name = ?');
    binds.push(body.name);
  }
  if (body.description !== undefined) {
    updates.push('description = ?');
    binds.push(body.description);
  }
  if (body.brandPrimaryColor !== undefined) {
    // Custom brand color is a paid-tier feature. Clearing it (null) is always OK.
    if (body.brandPrimaryColor !== null) {
      await requireOwnerFeature(c.env, current.owner_type as OwnerType, current.owner_id, 'brand_color', user);
    }
    updates.push('brand_primary_color = ?');
    binds.push(body.brandPrimaryColor === null ? null : body.brandPrimaryColor.toLowerCase());
  }
  if (body.slug !== undefined && body.slug !== current.slug) {
    if (!isValidSlug(body.slug)) {
      throw validationFailed('Invalid slug');
    }
    const existing = await c.env.DB.prepare(
      `SELECT id FROM feed_project
         WHERE owner_type = ? AND owner_id = ? AND slug = ? AND deleted_at IS NULL AND id != ?
         LIMIT 1`,
    )
      .bind(current.owner_type, current.owner_id, body.slug, current.id)
      .first<{ id: string }>();
    if (existing) throw conflict('Slug is already in use');
    updates.push('slug = ?');
    binds.push(body.slug);
  }
  if (body.archivedAt !== undefined) {
    updates.push('archived_at = ?');
    binds.push(body.archivedAt === 'now' ? Date.now() : null);
  }

  if (updates.length === 0) {
    return c.json(shapeProject(current));
  }

  const now = Date.now();
  updates.push('updated_at = ?');
  binds.push(now);
  binds.push(current.id);

  await c.env.DB.prepare(`UPDATE feed_project SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'project',
    subjectId: current.id,
    action: 'project.update',
    metadata: {
      name: body.name !== undefined,
      description: body.description !== undefined,
      slug: body.slug !== undefined,
      archived: body.archivedAt !== undefined,
      locked: body.locked,
    },
    ip: clientIp(c.req.raw),
  });

  const updated = await c.env.DB.prepare(
    `SELECT id, slug, name, description, owner_type, owner_id,
            working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
            archived_at, deleted_at, created_at, updated_at, brand_primary_color, locked,
            license_spdx
       FROM feed_project WHERE id = ?`,
  )
    .bind(current.id)
    .first<ProjectRow>();
  return c.json(shapeProject(updated!));
});

// ─── DELETE /api/projects/:id — soft delete (trash) ────────────────────────
//
// Sets feed_project.deleted_at. The feed leaves the owner's list but stays
// recoverable for PROJECT_DELETE_GRACE_MS via GET /api/projects/deleted +
// POST /:id/restore; after that the nightly reaper purges it for good
// (worker/cron/tasks.ts → reapDeletedProjects).
//
// Refused (409) when the feed is LOCKED, or when it is currently PUBLISHED.
// `?unpublish=1` opts into the combined action: take the feed down, then
// delete it.
projectsRouter.delete('/:id', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: current } = await requireOwnedProject(c.env, user, id, 'admin');

  // A locked feed is protected from deletion. Unlock it first (PATCH locked:false).
  // The lock outranks ?unpublish=1 — it protects against exactly this.
  if (current.locked === 1) {
    throw conflict('This feed is locked. Unlock it before deleting.');
  }

  // A published feed can't just be soft-deleted: the public feed handler joins
  // feed_project WITHOUT filtering deleted_at, so the ZIP would keep serving on
  // FEEDS_ORIGIN forever while vanishing from the owner's list — leaving them no
  // way to ever take it down. Deletion is gated on publication state (NOT on the
  // `locked` flag, which also blocks renames and means something different).
  const publication = await loadPublication(c.env, current.id);
  const alsoUnpublish = c.req.query('unpublish') === '1';
  if (publication && !alsoUnpublish) {
    const feedsHost = c.env.FEEDS_ORIGIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
    throw conflict(
      `This feed is published at ${feedsHost}/${publication.canonical_slug}. Unpublish it before deleting.`,
      { reason: 'published', canonicalSlug: publication.canonical_slug },
    );
  }

  // ?unpublish=1 — take it down first, through the same code path POST
  // /:id/unpublish uses, so both emit an 'unpublish' history row + audit event.
  const ip = clientIp(c.req.raw);
  await unpublishProject(c.env, current.id, publication, user.id, ip);

  const now = Date.now();
  await c.env.DB.prepare(`UPDATE feed_project SET deleted_at = ?, updated_at = ? WHERE id = ?`)
    .bind(now, now, current.id)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'project',
    subjectId: current.id,
    action: 'project.delete',
    metadata: { unpublished: !!publication, purgeAt: now + PROJECT_DELETE_GRACE_MS },
    ip,
  });

  return c.body(null, 204);
});

// ─── POST /api/projects/:id/restore — bring a feed back out of the trash ───
//
// Clears deleted_at. Admin-level, same as the delete it undoes.
//
// Restoring does NOT re-publish: the publication row is gone (delete requires an
// unpublish first), and resurrecting a live feed URL behind the user's back is
// not something a "restore" should do. They can publish again from the editor.
projectsRouter.post('/:id/restore', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');

  // requireOwnedProject() 404s on soft-deleted rows (correctly — they're gone
  // as far as every other route is concerned), so resolve the row and the
  // caller's access to it here.
  const current = await requireDeletedProject(c.env, user, id);

  // The unique index on (owner_type, owner_id, slug) is partial —
  // `WHERE deleted_at IS NULL` — so while this feed sat in the trash its slug
  // was free for a NEW feed to take. If that happened, restoring it under the
  // old slug would violate the index. Suffix it (`<slug>-2`, `-3`, …) and tell
  // the client, rather than failing a restore the user is entitled to.
  const restoredSlug = await uniqueSlug(
    c.env,
    current.owner_type,
    current.owner_id,
    current.slug,
    current.id,
  );
  const slugChanged = restoredSlug !== current.slug;

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE feed_project SET deleted_at = NULL, slug = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(restoredSlug, now, current.id)
    .run();

  // Belt and braces: a project restored from BEFORE the publish-guard existed
  // could still carry a publication row pointing at the old slug. Keep the
  // canonical URL pointed at this project (same rule as the transfer route).
  if (slugChanged) {
    await c.env.DB.prepare(`UPDATE publication SET canonical_slug = ? WHERE project_id = ?`)
      .bind(restoredSlug, current.id)
      .run();
  }

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'project',
    subjectId: current.id,
    action: 'project.restore',
    metadata: { slugChanged, previousSlug: current.slug, slug: restoredSlug },
    ip: clientIp(c.req.raw),
  });

  const fresh = await c.env.DB.prepare(
    `SELECT id, slug, name, description, owner_type, owner_id,
            working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
            archived_at, deleted_at, created_at, updated_at, brand_primary_color, locked
       FROM feed_project WHERE id = ?`,
  )
    .bind(current.id)
    .first<ProjectRow>();
  if (!fresh) throw notFound('Project not found');

  return c.json({
    project: shapeProject(fresh),
    slug: restoredSlug,
    slugChanged,
    previousSlug: current.slug,
  });
});

// ─── POST /api/projects/:id/transfer — move between workspaces ─────────────

const transferSchema = z.object({
  destination: z.union([
    z.object({ type: z.literal('user') }),
    z.object({ type: z.literal('org'), id: z.string().min(1) }),
  ]),
});

projectsRouter.post('/:id/transfer', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const body = await parseJson(c, transferSchema);

  // Source: must be admin+ on the current owner.
  const { row: current } = await requireOwnedProject(c.env, user, id, 'admin');

  // Resolve destination owner.
  let destOwnerType: 'user' | 'org';
  let destOwnerId: string;
  if (body.destination.type === 'user') {
    destOwnerType = 'user';
    destOwnerId = user.id;
  } else {
    destOwnerType = 'org';
    destOwnerId = body.destination.id;
    const membership = await getOrgMembership(c.env, destOwnerId, user.id);
    if (!membership) throw notFound('Destination organization not found');
    if (!roleAtLeast(membership.role, 'editor')) {
      throw forbidden('Editor role or higher required to transfer projects into this organization');
    }
  }

  if (destOwnerType === current.owner_type && destOwnerId === current.owner_id) {
    throw validationFailed('Project is already in that workspace');
  }

  // Quota check on the destination.
  const destQuotas = await getOwnerQuotas(c.env, destOwnerType, destOwnerId);
  const usedAtDest = await countProjects(c.env, destOwnerType, destOwnerId);
  enforceQuota(c.env, 'projects', usedAtDest, destQuotas.projects, { hard: true });

  // Slug uniqueness in the destination.
  const finalSlug = await uniqueSlug(c.env, destOwnerType, destOwnerId, current.slug);
  const slugChanged = finalSlug !== current.slug;

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE feed_project
        SET owner_type = ?, owner_id = ?, slug = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(destOwnerType, destOwnerId, finalSlug, now, current.id)
    .run();

  // Keep the canonical published URL pointed at this project even if the
  // slug had to change because of a collision in the destination.
  if (slugChanged) {
    await c.env.DB.prepare(`UPDATE publication SET canonical_slug = ? WHERE project_id = ?`)
      .bind(finalSlug, current.id)
      .run();
  }

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'project',
    subjectId: current.id,
    action: 'project.transfer',
    metadata: {
      from: { ownerType: current.owner_type, ownerId: current.owner_id },
      to: { ownerType: destOwnerType, ownerId: destOwnerId },
      slugChanged,
      finalSlug,
    },
    ip: clientIp(c.req.raw),
  });

  const fresh = await c.env.DB.prepare(
    `SELECT id, slug, name, description, owner_type, owner_id,
            working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
            archived_at, deleted_at, created_at, updated_at, brand_primary_color, locked,
            license_spdx
       FROM feed_project WHERE id = ?`,
  )
    .bind(current.id)
    .first<ProjectRow>();
  if (!fresh) throw notFound('Project not found');

  return c.json({
    project: shapeProject(fresh),
    slugChanged,
    previousSlug: current.slug,
  });
});

// ─── POST /api/projects/:id/duplicate — independent copy in the same workspace ──
//
// Creates a new feed_project owned by the SAME owner (user or org) as the
// source, with name "<source> (copy)" (slug/name deduped like create) and a
// copy of the source's working-state R2 blob. Only the editable working state
// is copied — publications, snapshots, draft links, scheduled publishes, and RT
// sources are intentionally NOT carried over. The copy is never born locked.
projectsRouter.post('/:id/duplicate', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');

  // Creating a feed in an org needs editor+ (matches POST /). A personal owner
  // always satisfies 'editor'. We gate on the SOURCE here; the destination is
  // the same owner, so this is also the destination's create permission.
  const { row: source } = await requireOwnedProject(c.env, user, id, 'editor');

  const ownerType = source.owner_type as OwnerType;
  const ownerId = source.owner_id;

  // Quota check on the (shared) destination owner — same rule as POST /.
  const ownerQuotas = await getOwnerQuotas(c.env, ownerType, ownerId);
  const used = await countProjects(c.env, ownerType, ownerId);
  const { warning } = enforceQuota(c.env, 'projects', used, ownerQuotas.projects, { hard: true });
  setQuotaWarningHeader(c, warning);

  // Name + slug dedupe. The name gets a " (copy)" suffix; the slug is derived
  // from that name and uniquified in the destination workspace.
  const newName = `${source.name} (copy)`;
  const finalSlug = await uniqueSlug(c.env, ownerType, ownerId, slugify(newName));

  const now = Date.now();
  const newId = ulid();

  // Copy the working state blob if the source has one. A source with no working
  // state yet yields an empty copy (same as a fresh create).
  let newKey: string | null = null;
  let newSize: number | null = null;
  let newVersion = 0;
  if (source.working_state_r2_key) {
    const sourceObj = await getFeedBlob(c.env, source.working_state_r2_key);
    if (sourceObj) {
      const buf = await sourceObj.arrayBuffer();
      newKey = workingStateKey(newId);
      await putFeedBlob(c.env, newKey, buf, {
        contentType: 'application/json',
        contentEncoding: 'gzip',
      });
      newSize = buf.byteLength;
      newVersion = 1;
    }
  }

  await c.env.DB.prepare(
    `INSERT INTO feed_project
       (id, slug, name, description, owner_type, owner_id,
        working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
        archived_at, deleted_at, created_at, updated_at, locked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0)`,
  )
    .bind(
      newId,
      finalSlug,
      newName,
      source.description ?? null,
      ownerType,
      ownerId,
      newKey,
      newVersion,
      newSize,
      newKey ? now : null,
      now,
      now,
    )
    .run();

  const row = await c.env.DB.prepare(
    `SELECT id, slug, name, description, owner_type, owner_id,
            working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
            archived_at, deleted_at, created_at, updated_at, brand_primary_color, locked,
            license_spdx
       FROM feed_project WHERE id = ?`,
  )
    .bind(newId)
    .first<ProjectRow>();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'project',
    subjectId: newId,
    action: 'project.duplicate',
    metadata: { sourceId: source.id, slug: finalSlug, name: newName, ownerType, ownerId },
    ip: clientIp(c.req.raw),
  });

  return c.json(shapeProject(row!), 201);
});

projectsRouter.get('/:id/working-state', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row } = await requireOwnedProject(c.env, user, id, 'viewer');
  // How many saved versions this feed has. The client needs it on BOTH the
  // success path and the 404 path: an editor that opens to an empty canvas has
  // to be able to say "…but N saved versions exist, restore one" instead of
  // silently showing a blank feed (the state 16 prod feeds were found in).
  const snapshotCount = await countSnapshots(c.env, row.id);

  // Two very different 404s, and they must never look the same again:
  //   - no key at all      → the feed has genuinely never been saved. Normal.
  //   - key set, blob gone → REAL DATA LOSS. Should be impossible; if it ever
  //     happens we need to hear about it immediately, not in a quarterly sweep.
  if (!row.working_state_r2_key) {
    throw notFound('No working state yet', { reason: 'never_saved', snapshotCount });
  }

  const object = await getFeedBlob(c.env, row.working_state_r2_key);
  if (!object) {
    console.error('[working-state] R2 blob missing for a project that has one recorded', {
      projectId: row.id,
      slug: row.slug,
      key: row.working_state_r2_key,
      version: row.working_state_version,
      size: row.working_state_size,
      snapshotCount,
    });
    throw notFound('Working state blob missing', { reason: 'blob_missing', snapshotCount });
  }

  c.header('Content-Type', 'application/json');
  c.header('X-Working-State-Version', String(row.working_state_version));
  c.header('X-Snapshot-Count', String(snapshotCount));
  // Decompress in the worker. Manually-set Content-Encoding on a Worker
  // response isn't auto-decompressed by browser fetch (only transport-layer
  // negotiated encodings are), so the client receives raw gzip bytes and
  // JSON.parse fails with "Could not load feed". Streaming through
  // DecompressionStream gives the client plain JSON; CF's edge re-gzips on
  // the wire if the client sent Accept-Encoding: gzip.
  const decompressed = object.body.pipeThrough(new DecompressionStream('gzip'));
  return c.body(decompressed);
});

projectsRouter.put('/:id/working-state', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row } = await requireOwnedProject(c.env, user, id, 'editor');

  // A locked feed can't be saved over — this is what protects the published
  // demo feed (and any agency's live feed). The editor opens locked feeds as a
  // detached draft so it never even attempts this, but enforce it server-side
  // too so a stale client or a direct API call can't bypass the lock.
  if (row.locked === 1) {
    throw conflict('This feed is locked. Unlock it before saving, or use Save As to fork it.');
  }

  const ifMatchHeader = c.req.header('If-Match');
  const ifMatch = ifMatchHeader != null ? parseInt(ifMatchHeader, 10) : NaN;
  if (!Number.isFinite(ifMatch) || ifMatch !== row.working_state_version) {
    throw new ApiError(409, 'conflict', 'Working state has been updated elsewhere', {
      currentVersion: row.working_state_version,
    });
  }

  const contentEncoding = c.req.header('Content-Encoding');
  if (contentEncoding !== 'gzip') {
    throw validationFailed('Content-Encoding: gzip required');
  }

  const buf = await c.req.raw.arrayBuffer();
  const size = buf.byteLength;
  if (size === 0) throw validationFailed('Empty body');
  const saveQuotas = await getOwnerQuotas(c.env, row.owner_type as OwnerType, row.owner_id);
  if (size > saveQuotas.blobBytes) {
    throw new ApiError(413, 'quota_exceeded', `Working state exceeds ${saveQuotas.blobBytes} bytes`, {
      kind: 'blob',
      used: size,
      limit: saveQuotas.blobBytes,
    });
  }

  const key = workingStateKey(row.id);
  await putFeedBlob(c.env, key, buf, {
    contentType: 'application/json',
    contentEncoding: 'gzip',
  });

  const now = Date.now();
  const result = await c.env.DB.prepare(
    `UPDATE feed_project
        SET working_state_version = working_state_version + 1,
            working_state_size = ?,
            working_state_updated_at = ?,
            updated_at = ?,
            working_state_r2_key = ?
      WHERE id = ? AND working_state_version = ?`,
  )
    .bind(size, now, now, key, row.id, row.working_state_version)
    .run();

  const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  if (changes === 0) {
    const fresh = await c.env.DB.prepare(
      `SELECT working_state_version FROM feed_project WHERE id = ?`,
    )
      .bind(row.id)
      .first<{ working_state_version: number }>();
    throw new ApiError(409, 'conflict', 'Working state was updated concurrently', {
      currentVersion: fresh?.working_state_version ?? row.working_state_version,
    });
  }

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'project',
    subjectId: row.id,
    action: 'project.save_working_state',
    metadata: { size, version: row.working_state_version + 1 },
    ip: clientIp(c.req.raw),
  });

  // Refresh the route-map thumbnail off the response path. Gated on a geometry
  // hash inside maybeRegenerateThumbnail, so routine autosaves that don't touch
  // route shapes don't re-hit Mapbox. Best-effort — never breaks the save.
  c.executionCtx.waitUntil(
    (async () => {
      const state = await parseFeedStateFromGzip(buf);
      if (state) await maybeRegenerateThumbnail(c.env, row.id, state);
    })().catch((err) => console.error('[thumbnail] save-trigger error', err)),
  );

  return c.json({ workingStateVersion: row.working_state_version + 1 });
});

projectsRouter.post('/:id/snapshots', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row } = await requireOwnedProject(c.env, user, id, 'editor');
  await requireOwnerFeature(c.env, row.owner_type as OwnerType, row.owner_id, 'snapshot_history', user);

  let parsed: Record<string, string | File | (string | File)[]>;
  try {
    parsed = (await c.req.parseBody({ all: false })) as Record<string, string | File | (string | File)[]>;
  } catch {
    throw validationFailed('Invalid multipart body');
  }

  const statePart = parsed['state'];
  const metaPart = parsed['meta'];
  if (!(statePart instanceof File) && !(statePart instanceof Blob)) {
    throw validationFailed('Missing state file');
  }
  if (typeof metaPart !== 'string') {
    throw validationFailed('Missing meta JSON');
  }

  let metaObj: unknown;
  try {
    metaObj = JSON.parse(metaPart);
  } catch {
    throw validationFailed('Invalid meta JSON');
  }
  const metaResult = snapshotMetaSchema.safeParse(metaObj);
  if (!metaResult.success) {
    throw validationFailed('Invalid meta', { issues: metaResult.error.issues });
  }
  const meta = metaResult.data;

  const ownerQuotas = await getOwnerQuotas(c.env, row.owner_type as OwnerType, row.owner_id);
  const snapshotsUsed = await countSnapshots(c.env, row.id);
  const { warning } = enforceQuota(c.env, 'snapshots', snapshotsUsed, ownerQuotas.snapshotsPerProject);
  setQuotaWarningHeader(c, warning);

  const stateBuf = await (statePart as Blob).arrayBuffer();
  const stateSize = stateBuf.byteLength;
  if (stateSize === 0) throw validationFailed('Empty state file');
  enforceBlobSize(stateSize, ownerQuotas.blobBytes);

  const snapshotId = ulid();
  const stateKey = snapshotStateKey(row.id, snapshotId);
  await putFeedBlob(c.env, stateKey, stateBuf, {
    contentType: 'application/json',
    contentEncoding: 'gzip',
  });

  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO feed_snapshot
       (id, project_id, label, created_by_user_id, state_r2_key, zip_r2_key, zip_size,
        summary_json, validation_errors, validation_warnings, created_at)
     VALUES (?, ?, ?, ?, ?, '', 0, ?, ?, ?, ?)`,
  )
    .bind(
      snapshotId,
      row.id,
      meta.label ?? null,
      user.id,
      stateKey,
      JSON.stringify(meta.summary),
      meta.validationErrors,
      meta.validationWarnings,
      now,
    )
    .run();

  // ── Backstop: seed the working state when the feed has never had one ──────
  //
  // "Save a version" used to write ONLY the version, so a user who treated it
  // as Save ended up with all their content in an immutable snapshot and a feed
  // that opens as a blank canvas. The web client now saves the working state
  // FIRST (see services/versionSave.ts), which makes this branch a no-op for
  // it — but the route is public API, and any other caller deserves the same
  // guarantee.
  //
  // Deliberately narrow: only when `working_state_r2_key IS NULL`, i.e. there
  // is literally nothing to overwrite and no version to conflict with. A feed
  // that HAS a working state is left strictly alone — the server cannot tell a
  // stale live state from an intentionally-different one, and clobbering it
  // would be the same class of bug pointing the other way. Locked feeds are
  // skipped for the same reason a direct PUT is refused on them.
  let seededWorkingStateVersion: number | null = null;
  if (!row.working_state_r2_key && row.locked !== 1) {
    const wsKey = workingStateKey(row.id);
    await putFeedBlob(c.env, wsKey, stateBuf, {
      contentType: 'application/json',
      contentEncoding: 'gzip',
    });
    // Guarded on the version we read, so a real save that raced us wins and
    // this becomes a no-op rather than resetting their counter.
    const seeded = await c.env.DB.prepare(
      `UPDATE feed_project
          SET working_state_r2_key = ?,
              working_state_version = working_state_version + 1,
              working_state_size = ?,
              working_state_updated_at = ?,
              updated_at = ?
        WHERE id = ? AND working_state_r2_key IS NULL AND working_state_version = ?`,
    )
      .bind(wsKey, stateSize, now, now, row.id, row.working_state_version)
      .run();
    if (((seeded.meta as { changes?: number } | undefined)?.changes ?? 0) > 0) {
      seededWorkingStateVersion = row.working_state_version + 1;
    }
  }

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'snapshot',
    subjectId: snapshotId,
    action: 'project.create_snapshot',
    metadata: {
      projectId: row.id,
      label: meta.label ?? null,
      size: stateSize,
      ...(seededWorkingStateVersion !== null ? { seededWorkingState: true } : {}),
    },
    ip: clientIp(c.req.raw),
  });

  return c.json({
    snapshot: {
      id: snapshotId,
      label: meta.label ?? null,
      createdAt: now,
      summary: meta.summary,
      validationErrors: meta.validationErrors,
      validationWarnings: meta.validationWarnings,
    },
    // Present only when this request seeded the working state. The client
    // adopts it as its If-Match token so the next Save doesn't 409 against a
    // version it never saw.
    ...(seededWorkingStateVersion !== null
      ? { workingStateVersion: seededWorkingStateVersion }
      : {}),
  });
});

projectsRouter.get('/:id/snapshots', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row } = await requireOwnedProject(c.env, user, id, 'viewer');
  await requireOwnerFeature(c.env, row.owner_type as OwnerType, row.owner_id, 'snapshot_history', user);

  const result = await c.env.DB.prepare(
    `SELECT id, project_id, label, created_by_user_id, state_r2_key, zip_r2_key, zip_size,
            summary_json, validation_errors, validation_warnings, created_at
       FROM feed_snapshot WHERE project_id = ? ORDER BY created_at DESC`,
  )
    .bind(row.id)
    .all<SnapshotRow>();

  return c.json({
    snapshots: (result.results ?? []).map(shapeSnapshot),
  });
});

projectsRouter.get('/:id/snapshots/:vid/state', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const vid = c.req.param('vid');
  const { row } = await requireOwnedProject(c.env, user, id, 'viewer');
  await requireOwnerFeature(c.env, row.owner_type as OwnerType, row.owner_id, 'snapshot_history', user);
  const snapshot = await requireOwnedSnapshot(c.env, row.id, vid);

  const object = await getFeedBlob(c.env, snapshot.state_r2_key);
  if (!object) throw notFound('Snapshot state missing');

  c.header('Content-Type', 'application/json');
  const decompressed = object.body.pipeThrough(new DecompressionStream('gzip'));
  return c.body(decompressed);
});

projectsRouter.post('/:id/snapshots/:vid/restore', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const vid = c.req.param('vid');
  const { row } = await requireOwnedProject(c.env, user, id, 'editor');
  await requireOwnerFeature(c.env, row.owner_type as OwnerType, row.owner_id, 'snapshot_history', user);
  // Restoring a snapshot overwrites working state, so it's blocked on a locked
  // feed for the same reason a direct save is.
  if (row.locked === 1) {
    throw conflict('This feed is locked. Unlock it before restoring a snapshot.');
  }
  const snapshot = await requireOwnedSnapshot(c.env, row.id, vid);

  const source = await getFeedBlob(c.env, snapshot.state_r2_key);
  if (!source) throw notFound('Snapshot state missing');
  const buf = await source.arrayBuffer();
  const size = buf.byteLength;

  const key = workingStateKey(row.id);
  await putFeedBlob(c.env, key, buf, {
    contentType: 'application/json',
    contentEncoding: 'gzip',
  });

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE feed_project
        SET working_state_version = working_state_version + 1,
            working_state_size = ?,
            working_state_updated_at = ?,
            updated_at = ?,
            working_state_r2_key = ?
      WHERE id = ?`,
  )
    .bind(size, now, now, key, row.id)
    .run();

  const after = await c.env.DB.prepare(
    `SELECT working_state_version FROM feed_project WHERE id = ?`,
  )
    .bind(row.id)
    .first<{ working_state_version: number }>();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'project',
    subjectId: row.id,
    action: 'project.restore_snapshot',
    metadata: { snapshotId: snapshot.id },
    ip: clientIp(c.req.raw),
  });

  return c.json({ workingStateVersion: after?.working_state_version ?? row.working_state_version + 1 });
});

projectsRouter.delete('/:id/snapshots/:vid', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const vid = c.req.param('vid');
  const { row } = await requireOwnedProject(c.env, user, id, 'editor');
  await requireOwnerFeature(c.env, row.owner_type as OwnerType, row.owner_id, 'snapshot_history', user);
  const snapshot = await requireOwnedSnapshot(c.env, row.id, vid);

  // Snapshot deletes were silently failing with "Something went wrong" when
  // the snapshot had ever been published. publication_history.snapshot_id
  // references feed_snapshot(id) with no ON DELETE clause, so audit rows
  // (which intentionally outlive a publish/unpublish cycle) blocked the
  // DELETE on a foreign-key constraint.
  //
  // The publication table itself has the same gap; if the user hasn't
  // unpublished, refuse with a clear 409 instead of letting the constraint
  // produce a confusing client-side error.
  const stillPublished = await c.env.DB.prepare(
    `SELECT 1 FROM publication WHERE project_id = ? AND snapshot_id = ?`,
  ).bind(row.id, snapshot.id).first<{ '1': number }>();
  if (stillPublished) {
    throw conflict('This snapshot is currently published. Unpublish the feed first.');
  }

  // NULL out the snapshot reference on any history rows so the audit trail
  // ("publish at T", "unpublish at T+1") survives but the snapshot can be
  // removed. snapshot_id was declared nullable in migration 0003 (originally
  // version_id, renamed in 0012).
  await c.env.DB.prepare(
    `UPDATE publication_history SET snapshot_id = NULL WHERE snapshot_id = ?`,
  ).bind(snapshot.id).run();

  await deleteFeedBlob(c.env, snapshot.state_r2_key);
  if (snapshot.zip_r2_key) {
    await deleteFeedBlob(c.env, snapshot.zip_r2_key);
  }
  await c.env.DB.prepare(`DELETE FROM feed_snapshot WHERE id = ? AND project_id = ?`)
    .bind(snapshot.id, row.id)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'snapshot',
    subjectId: snapshot.id,
    action: 'project.delete_snapshot',
    metadata: { projectId: row.id },
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

// GET /api/projects/:id/audit — append-only event log for this project.
// Gated on project ownership; reuses the same visibility rule as the editor.
projectsRouter.get('/:id/audit', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row } = await requireOwnedProject(c.env, user, id, 'viewer');

  const limitRaw = c.req.query('limit');
  const before = c.req.query('before');
  let limit = limitRaw ? parseInt(limitRaw, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;

  const binds: unknown[] = [row.id];
  let beforeClause = '';
  if (before) {
    beforeClause = ' AND id < ?';
    binds.push(before);
  }
  binds.push(limit);

  const result = await c.env.DB.prepare(
    `SELECT id, actor_user_id, subject_type, subject_id, action, metadata_json, created_at
       FROM audit_event
      WHERE subject_type = 'project' AND subject_id = ?${beforeClause}
      ORDER BY id DESC
      LIMIT ?`,
  )
    .bind(...binds)
    .all<{
      id: string;
      actor_user_id: string | null;
      subject_type: string;
      subject_id: string | null;
      action: string;
      metadata_json: string | null;
      created_at: number;
    }>();

  const events = (result.results ?? []).map((r) => ({
    id: r.id,
    actorUserId: r.actor_user_id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    action: r.action,
    metadataJson: r.metadata_json,
    createdAt: r.created_at,
  }));

  return c.json({ events });
});

projectsRouter.post('/import', async (c) => {
  const user = c.var.user!;
  const body = await parseJson(c, importSchema);

  const imported: unknown[] = [];
  const skipped: { name: string; reason: string }[] = [];

  const importQuotas = await getOwnerQuotas(c.env, 'user', user.id);
  for (const item of body.projects) {
    const used = await countProjects(c.env, 'user', user.id);
    if (used >= importQuotas.projects) {
      skipped.push({ name: item.name, reason: 'quota_exceeded' });
      continue;
    }

    let decoded: Uint8Array;
    try {
      decoded = base64ToBytes(item.workingState);
    } catch {
      skipped.push({ name: item.name, reason: 'invalid_base64' });
      continue;
    }
    if (decoded.byteLength === 0) {
      skipped.push({ name: item.name, reason: 'empty_state' });
      continue;
    }
    if (decoded.byteLength > importQuotas.blobBytes) {
      skipped.push({ name: item.name, reason: 'too_large' });
      continue;
    }

    let desiredSlug: string;
    if (item.slug !== undefined && isValidSlug(item.slug)) {
      desiredSlug = item.slug;
    } else {
      desiredSlug = slugify(item.name);
    }
    const finalSlug = await uniqueSlug(c.env, 'user', user.id, desiredSlug);

    const projectId = ulid();
    const now = Date.now();
    const key = workingStateKey(projectId);

    await putFeedBlob(c.env, key, decoded, {
      contentType: 'application/json',
      contentEncoding: 'gzip',
    });

    await c.env.DB.prepare(
      `INSERT INTO feed_project
         (id, slug, name, description, owner_type, owner_id,
          working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
          archived_at, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?, 1, ?, ?, NULL, NULL, ?, ?)`,
    )
      .bind(
        projectId,
        finalSlug,
        item.name,
        item.description ?? null,
        user.id,
        key,
        decoded.byteLength,
        now,
        now,
        now,
      )
      .run();

    const row = await c.env.DB.prepare(
      `SELECT id, slug, name, description, owner_type, owner_id,
              working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
              archived_at, deleted_at, created_at, updated_at, brand_primary_color, locked,
              license_spdx
         FROM feed_project WHERE id = ?`,
    )
      .bind(projectId)
      .first<ProjectRow>();

    imported.push(shapeProject(row!));
  }

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'user',
    subjectId: user.id,
    action: 'project.imported_from_local',
    metadata: { count: imported.length, skipped: skipped.length },
    ip: clientIp(c.req.raw),
  });

  return c.json({ imported, skipped });
});

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/\s+/g, '');
  const bin = atob(normalized);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLICATION, DRAFT LINKS, CATALOGS, RT FEEDS — §5/§6 of BACKEND_REQUIREMENTS
// ═══════════════════════════════════════════════════════════════════════════

// SPDX license identifier for the feed. `null` clears it; omitting the key
// leaves whatever the last publish recorded. (There is no ntdId here: an
// agency's NTD ID is agency.external_id, carried inside the feed state.)
const licenseSpdxField = z.string().min(1).max(64).nullable().optional();

const publishJsonSchema = z.object({
  snapshotId: z.string().min(1),
  ignoreWarnings: z.boolean().optional(),
  ignoreRtBreakage: z.boolean().optional(),
  ignoreAgencyChurn: z.boolean().optional(),
  licenseSpdx: licenseSpdxField,
});

// A scheduled publish runs the SAME gates as an immediate one — but at schedule
// time, while the user is present to acknowledge them (the cron has nobody to
// ask). So it takes the same ignore flags, and they are persisted on the row for
// the cron to replay. See worker/migrations/0025_scheduled_publish_acks.sql.
const schedulePublishSchema = z.object({
  snapshotId: z.string().min(1),
  scheduledFor: z.number().int().positive(), // unix ms, must be in the future
  ignoreWarnings: z.boolean().optional(),
  ignoreRtBreakage: z.boolean().optional(),
  ignoreAgencyChurn: z.boolean().optional(),
});

const draftLinkCreateSchema = z.object({
  snapshotId: z.string().min(1),
  ttlDays: z.number().int().positive().max(365).optional(),
});

const catalogCreateSchema = z.object({
  catalog: z.enum(['mobility_db', 'transit_land']),
});

// Open-catalog listing opt-in (issue #47). publisherType is REQUIRED — a feed
// is listed only after its owner affirmatively declares whether it is an
// official (published by/on behalf of the operating agency) or community
// (third-party-maintained) feed. There is no default; opting out is DELETE.
const catalogListingSchema = z.object({
  publisherType: z.enum(['official', 'community']),
});

const rtFeedItemSchema = z.object({
  kind: z.enum(['vehicle_positions', 'trip_updates', 'alerts']),
  url: z.string().url().max(2000).refine((u) => u.startsWith('https://'), 'URL must be https://'),
});
const rtFeedsPutSchema = z.object({
  feeds: z.array(rtFeedItemSchema).max(10),
});

interface PublicationRow {
  project_id: string;
  snapshot_id: string;
  published_by_user_id: string | null;
  published_at: number;
  canonical_slug: string;
  zip_r2_key: string;
}

async function loadPublication(env: Env, projectId: string): Promise<PublicationRow | null> {
  return env.DB.prepare(
    `SELECT project_id, snapshot_id, published_by_user_id, published_at, canonical_slug, zip_r2_key
       FROM publication WHERE project_id = ?`,
  )
    .bind(projectId)
    .first<PublicationRow>();
}

/**
 * Take a published feed down: drop the publication pointer (the canonical URL
 * on FEEDS_ORIGIN stops serving immediately), append an 'unpublish' history
 * row, and audit it.
 *
 * The single implementation behind BOTH `POST /:id/unpublish` and the combined
 * `DELETE /:id?unpublish=1` — a delete-then-unpublish that drifted from the
 * standalone unpublish is exactly how a feed ends up orphaned and still live.
 *
 * The caller passes the already-loaded publication row (or null); this is a
 * no-op when the project isn't published.
 */
async function unpublishProject(
  env: Env,
  projectId: string,
  existing: PublicationRow | null,
  actorUserId: string,
  ip: string,
): Promise<void> {
  if (!existing) return;

  const now = Date.now();
  await env.DB.prepare(`DELETE FROM publication WHERE project_id = ?`).bind(projectId).run();
  await env.DB.prepare(
    `INSERT INTO publication_history (id, project_id, snapshot_id, action, actor_user_id, created_at)
     VALUES (?, ?, ?, 'unpublish', ?, ?)`,
  )
    .bind(ulid(), projectId, existing.snapshot_id, actorUserId, now)
    .run();

  await logAudit(env, {
    actorUserId,
    subjectType: 'publication',
    subjectId: projectId,
    action: 'project.unpublish',
    metadata: { snapshotId: existing.snapshot_id },
    ip,
  });
}

interface ScheduledPublishRow {
  id: string;
  snapshot_id: string;
  scheduled_for: number;
  ignore_warnings: number;
  ignore_rt_breakage: number;
  ignore_agency_churn: number;
  status: string;
  failure_reason: string | null;
  created_at: number;
}

// Most-recent scheduled-publish row for a project (any status). The client
// shows it only when 'pending' (with a Cancel) or 'failed' (with the reason).
async function loadLatestSchedule(env: Env, projectId: string): Promise<ScheduledPublishRow | null> {
  return env.DB.prepare(
    `SELECT id, snapshot_id, scheduled_for, ignore_warnings, ignore_rt_breakage, ignore_agency_churn,
            status, failure_reason, created_at
       FROM scheduled_publish WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(projectId)
    .first<ScheduledPublishRow>();
}

function serializeSchedule(s: ScheduledPublishRow) {
  return {
    id: s.id,
    snapshotId: s.snapshot_id,
    scheduledFor: s.scheduled_for,
    ignoreWarnings: s.ignore_warnings === 1,
    // The ID-stability gates the user acknowledged at schedule time; the cron
    // replays exactly these into performPublish and nothing more.
    ignoreRtBreakage: s.ignore_rt_breakage === 1,
    ignoreAgencyChurn: s.ignore_agency_churn === 1,
    status: s.status,
    failureReason: s.failure_reason,
  };
}

// ─── POST /api/projects/:id/publish ────────────────────────────────────────────
//
// Two request shapes:
//   1. multipart/form-data with `meta` (JSON) and `zip` (file) — used when the
//      snapshot row doesn't yet carry a rendered ZIP in R2 (the common case
//      today; Phase 2's snapshot path only stores state, not the ZIP).
//   2. application/json with `{ snapshotId, ignoreWarnings?, ignoreRtBreakage? }`
//      — used when the snapshot row already has `zip_r2_key` populated.
projectsRouter.post('/:id/publish', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
  const now = Date.now();

  // Feature + quota gating: managed publishing is paid-tier only. Republishing
  // an existing publication for this project doesn't consume a new slot.
  const existingPublication = await loadPublication(c.env, project.id);
  await requirePublishAccess(
    c.env,
    project.owner_type as OwnerType,
    project.owner_id,
    { isNewPublication: !existingPublication, actor: user },
  );

  const projectQuotas = await getOwnerQuotas(c.env, project.owner_type as OwnerType, project.owner_id);

  const contentType = c.req.header('Content-Type') ?? '';
  let snapshotId: string;
  let ignoreWarnings: boolean;
  let ignoreRtBreakage: boolean;
  let ignoreAgencyChurn: boolean;
  // `undefined` = not supplied (leave the recorded license alone);
  // `null` = explicitly cleared.
  let licenseSpdx: string | null | undefined;
  let incomingZip: ArrayBuffer | null = null;

  if (contentType.includes('multipart/form-data')) {
    let parsed: Record<string, string | File | (string | File)[]>;
    try {
      parsed = (await c.req.parseBody({ all: false })) as Record<string, string | File | (string | File)[]>;
    } catch {
      throw validationFailed('Invalid multipart body');
    }
    const metaPart = parsed['meta'];
    const zipPart = parsed['zip'];
    if (typeof metaPart !== 'string') throw validationFailed('Missing meta JSON');
    if (!(zipPart instanceof File) && !(zipPart instanceof Blob)) {
      throw validationFailed('Missing zip file');
    }
    let metaObj: unknown;
    try { metaObj = JSON.parse(metaPart); } catch { throw validationFailed('Invalid meta JSON'); }
    const metaResult = publishJsonSchema.safeParse(metaObj);
    if (!metaResult.success) {
      throw validationFailed('Invalid meta', { issues: metaResult.error.issues });
    }
    snapshotId = metaResult.data.snapshotId;
    ignoreWarnings = metaResult.data.ignoreWarnings ?? false;
    ignoreRtBreakage = metaResult.data.ignoreRtBreakage ?? false;
    ignoreAgencyChurn = metaResult.data.ignoreAgencyChurn ?? false;
    licenseSpdx = metaResult.data.licenseSpdx;
    incomingZip = await (zipPart as Blob).arrayBuffer();
    if (incomingZip.byteLength === 0) throw validationFailed('Empty zip');
    enforceBlobSize(incomingZip.byteLength, projectQuotas.blobBytes);
  } else {
    const body = await parseJson(c, publishJsonSchema);
    snapshotId = body.snapshotId;
    ignoreWarnings = body.ignoreWarnings ?? false;
    ignoreRtBreakage = body.ignoreRtBreakage ?? false;
    ignoreAgencyChurn = body.ignoreAgencyChurn ?? false;
    licenseSpdx = body.licenseSpdx;
  }

  const snapshot = await requireOwnedSnapshot(c.env, project.id, snapshotId);

  // Shared publish core (also used by the scheduled-publish cron). The route
  // owns gating + body parsing above; performPublish runs the validation gate,
  // ID-stability check, ZIP copy, pointer flip, history, audit, and background
  // catalog + thumbnail work.
  const { canonicalUrl } = await performPublish(c.env, {
    project: { id: project.id, slug: project.slug, name: project.name },
    snapshot,
    existingPublication,
    ignoreWarnings,
    ignoreRtBreakage,
    ignoreAgencyChurn,
    licenseSpdx,
    actorUserId: user.id,
    incomingZip,
    feedsOrigin: c.env.FEEDS_ORIGIN,
    runBackground: (p) => c.executionCtx.waitUntil(p),
    ip: clientIp(c.req.raw),
    now,
  });

  return c.json({
    publication: {
      projectId: project.id,
      snapshotId: snapshot.id,
      publishedAt: now,
      canonicalUrl,
    },
  });
});

// ─── POST /api/projects/:id/unpublish ──────────────────────────────────────────
projectsRouter.post('/:id/unpublish', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');

  // Idempotent — unpublishProject() is a no-op when there's nothing published.
  const existing = await loadPublication(c.env, project.id);
  await unpublishProject(c.env, project.id, existing, user.id, clientIp(c.req.raw));

  return c.body(null, 204);
});

// ─── POST /api/projects/:id/publish/rollback ───────────────────────────────────
projectsRouter.post('/:id/publish/rollback', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
  const body = await parseJson(c, publishJsonSchema);
  const snapshot = await requireOwnedSnapshot(c.env, project.id, body.snapshotId);

  // We require either (a) an already-published ZIP in the publication slot
  // (i.e. we rolled off this snapshot, now rolling back), or (b) a rendered
  // ZIP on the snapshot row. If neither, the client must use the multipart
  // publish endpoint instead.
  const pubKey = publicationZipKey(project.id, snapshot.id);
  const existingPubObj = await getFeedBlob(c.env, pubKey);
  let sourceKey: string | null = null;
  if (existingPubObj) {
    sourceKey = pubKey;
  } else if (snapshot.zip_r2_key) {
    const snapshotObj = await getFeedBlob(c.env, snapshot.zip_r2_key);
    if (snapshotObj) sourceKey = snapshot.zip_r2_key;
  }
  if (!sourceKey) {
    throw validationFailed('No rendered ZIP available for this snapshot. Re-publish with a zip upload.');
  }

  if (sourceKey !== pubKey) {
    const source = await getFeedBlob(c.env, sourceKey);
    if (!source) throw notFound('Rendered ZIP missing');
    const buf = await source.arrayBuffer();
    await putFeedBlob(c.env, pubKey, buf, { contentType: 'application/zip' });
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO publication (project_id, snapshot_id, published_by_user_id, published_at, canonical_slug, zip_r2_key)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       snapshot_id = excluded.snapshot_id,
       published_by_user_id = excluded.published_by_user_id,
       published_at = excluded.published_at,
       canonical_slug = excluded.canonical_slug,
       zip_r2_key = excluded.zip_r2_key`,
  )
    .bind(project.id, snapshot.id, user.id, now, project.slug, pubKey)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO publication_history (id, project_id, snapshot_id, action, actor_user_id, created_at)
     VALUES (?, ?, ?, 'rollback', ?, ?)`,
  )
    .bind(ulid(), project.id, snapshot.id, user.id, now)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.publish',
    metadata: { snapshotId: snapshot.id, rollback: true },
    ip: clientIp(c.req.raw),
  });

  const canonicalUrl = `${c.env.FEEDS_ORIGIN.replace(/\/$/, '')}/${project.slug}/gtfs.zip`;
  return c.json({
    publication: {
      projectId: project.id,
      snapshotId: snapshot.id,
      publishedAt: now,
      canonicalUrl,
    },
  });
});

// ─── GET /api/projects/:id/publish/history ─────────────────────────────────────
projectsRouter.get('/:id/publish/history', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'viewer');

  const history = await c.env.DB.prepare(
    `SELECT id, snapshot_id, action, actor_user_id, created_at
       FROM publication_history
       WHERE project_id = ?
       ORDER BY created_at DESC`,
  )
    .bind(project.id)
    .all<{ id: string; snapshot_id: string | null; action: string; actor_user_id: string | null; created_at: number }>();

  const current = await loadPublication(c.env, project.id);
  const latestSchedule = await loadLatestSchedule(c.env, project.id);
  return c.json({
    history: (history.results ?? []).map((r) => ({
      id: r.id,
      snapshotId: r.snapshot_id,
      action: r.action,
      actorUserId: r.actor_user_id,
      createdAt: r.created_at,
    })),
    current: current
      ? { snapshotId: current.snapshot_id, publishedAt: current.published_at }
      : null,
    scheduled: latestSchedule ? serializeSchedule(latestSchedule) : null,
  });
});

// ─── POST /api/projects/:id/publish/schedule ───────────────────────────────────
// Schedule a snapshot to publish at a future time. The */15 cron
// (worker/cron/tasks.ts → publishDueSchedules) fires it via performPublish.
// At most one pending schedule per project — re-scheduling replaces the prior.
projectsRouter.post('/:id/publish/schedule', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
  const now = Date.now();

  // Same gating as an immediate publish — managed publishing is paid-tier, and
  // a new scheduled publish consumes a published-feed slot if not already live.
  const existingPublication = await loadPublication(c.env, project.id);
  await requirePublishAccess(
    c.env,
    project.owner_type as OwnerType,
    project.owner_id,
    { isNewPublication: !existingPublication, actor: user },
  );
  const projectQuotas = await getOwnerQuotas(c.env, project.owner_type as OwnerType, project.owner_id);

  // Two request shapes, mirroring the publish route: multipart (meta + a freshly
  // rendered zip) or JSON. The cron has no client to render the GTFS ZIP at fire
  // time and the worker can't render one, so we MUST capture the rendered ZIP now
  // and persist it on the snapshot row (snapshots are created with zip_r2_key='').
  const contentType = c.req.header('Content-Type') ?? '';
  let snapshotId: string;
  let scheduledFor: number;
  let ignoreWarnings: boolean;
  let ignoreRtBreakage: boolean;
  let ignoreAgencyChurn: boolean;
  let incomingZip: ArrayBuffer | null = null;
  if (contentType.includes('multipart/form-data')) {
    const parsed = (await c.req.parseBody({ all: false })) as Record<string, string | File>;
    const metaPart = parsed['meta'];
    const zipPart = parsed['zip'];
    if (typeof metaPart !== 'string') throw validationFailed('Missing meta JSON');
    const metaResult = schedulePublishSchema.safeParse(JSON.parse(metaPart));
    if (!metaResult.success) throw validationFailed('Invalid meta', { issues: metaResult.error.issues });
    snapshotId = metaResult.data.snapshotId;
    scheduledFor = metaResult.data.scheduledFor;
    ignoreWarnings = metaResult.data.ignoreWarnings ?? false;
    ignoreRtBreakage = metaResult.data.ignoreRtBreakage ?? false;
    ignoreAgencyChurn = metaResult.data.ignoreAgencyChurn ?? false;
    if (zipPart && typeof zipPart !== 'string') {
      incomingZip = await (zipPart as Blob).arrayBuffer();
      if (incomingZip.byteLength === 0) throw validationFailed('Empty zip');
      enforceBlobSize(incomingZip.byteLength, projectQuotas.blobBytes);
    }
  } else {
    const body = await parseJson(c, schedulePublishSchema);
    snapshotId = body.snapshotId;
    scheduledFor = body.scheduledFor;
    ignoreWarnings = body.ignoreWarnings ?? false;
    ignoreRtBreakage = body.ignoreRtBreakage ?? false;
    ignoreAgencyChurn = body.ignoreAgencyChurn ?? false;
  }

  if (scheduledFor <= now + 60_000) {
    throw validationFailed('scheduledFor must be at least a minute in the future.');
  }

  // Snapshot must exist and pass the validation gate now (it's immutable, so the
  // gate result is stable until the cron fires).
  const snapshot = await requireOwnedSnapshot(c.env, project.id, snapshotId);
  if (snapshot.validation_errors > 0 && !ignoreWarnings) {
    throw validationFailed('Feed has validation errors. Fix them or pass ignoreWarnings=true to schedule anyway.', {
      validationErrors: snapshot.validation_errors,
      validationWarnings: snapshot.validation_warnings,
    });
  }

  // ID-stability gates — the SAME evaluation performPublish runs, but here, while
  // the user is at the keyboard. Without this, a scheduled publish that churns an
  // agency_id (or breaks an RT feed) would fail unattended at fire time with no
  // way to have acknowledged it in advance. The 409s are identical, so the
  // client's existing acknowledge-and-retry modals work unchanged; the retry
  // carries ignoreRtBreakage/ignoreAgencyChurn, which we persist below.
  //
  // Runs BEFORE any write, so a 409 leaves the existing pending schedule and the
  // snapshot's stored ZIP untouched.
  await assertIdStable(c.env, {
    projectId: project.id,
    snapshot,
    existingPublication,
    ignoreRtBreakage,
    ignoreAgencyChurn,
  });

  // Persist the rendered ZIP on the snapshot so the cron can publish it. If no
  // zip was supplied, the snapshot must already carry one (e.g. re-scheduling).
  if (incomingZip) {
    const zipKey = snapshotZipKey(project.id, snapshot.id);
    await putFeedBlob(c.env, zipKey, incomingZip, { contentType: 'application/zip' });
    await c.env.DB.prepare(
      `UPDATE feed_snapshot SET zip_r2_key = ?, zip_size = ? WHERE id = ?`,
    ).bind(zipKey, incomingZip.byteLength, snapshot.id).run();
  } else if (!snapshot.zip_r2_key) {
    throw validationFailed('Open the feed in the editor when scheduling so we can render the GTFS ZIP to publish later.');
  }

  // Replace any existing pending schedule (one pending per project).
  await c.env.DB.prepare(
    `UPDATE scheduled_publish SET status = 'cancelled', executed_at = ? WHERE project_id = ? AND status = 'pending'`,
  ).bind(now, project.id).run();

  const schedId = ulid();
  await c.env.DB.prepare(
    `INSERT INTO scheduled_publish (id, project_id, snapshot_id, scheduled_for, ignore_warnings,
                                    ignore_rt_breakage, ignore_agency_churn, status, scheduled_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(
      schedId,
      project.id,
      snapshot.id,
      scheduledFor,
      ignoreWarnings ? 1 : 0,
      ignoreRtBreakage ? 1 : 0,
      ignoreAgencyChurn ? 1 : 0,
      user.id,
      now,
    )
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.schedule_publish',
    metadata: { snapshotId: snapshot.id, scheduledFor, ignoreRtBreakage, ignoreAgencyChurn },
    ip: clientIp(c.req.raw),
  });

  return c.json({
    scheduled: {
      id: schedId,
      snapshotId: snapshot.id,
      scheduledFor,
      ignoreWarnings,
      ignoreRtBreakage,
      ignoreAgencyChurn,
      status: 'pending',
      failureReason: null,
    },
  });
});

// ─── DELETE /api/projects/:id/publish/schedule ─────────────────────────────────
// Cancel the project's pending scheduled publish (idempotent).
projectsRouter.delete('/:id/publish/schedule', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE scheduled_publish SET status = 'cancelled', executed_at = ? WHERE project_id = ? AND status = 'pending'`,
  ).bind(now, project.id).run();
  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.cancel_scheduled_publish',
    metadata: {},
    ip: clientIp(c.req.raw),
  });
  return c.json({ cancelled: true });
});

// ─── Draft links ───────────────────────────────────────────────────────────────

projectsRouter.post('/:id/draft-links', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
  const now = Date.now();

  // Draft links are a managed-hosting feature (paid tier only) — see
  // FREEMIUM_PLAN.md §6.
  await requireDraftLinkAccess(c.env, project.owner_type as OwnerType, project.owner_id, user);

  const draftQuotas = await getOwnerQuotas(c.env, project.owner_type as OwnerType, project.owner_id);

  const contentType = c.req.header('Content-Type') ?? '';
  let snapshotId: string;
  let ttlDays: number;
  let incomingZip: ArrayBuffer | null = null;

  if (contentType.includes('multipart/form-data')) {
    let parsed: Record<string, string | File | (string | File)[]>;
    try {
      parsed = (await c.req.parseBody({ all: false })) as Record<string, string | File | (string | File)[]>;
    } catch {
      throw validationFailed('Invalid multipart body');
    }
    const metaPart = parsed['meta'];
    const zipPart = parsed['zip'];
    if (typeof metaPart !== 'string') throw validationFailed('Missing meta JSON');
    if (!(zipPart instanceof File) && !(zipPart instanceof Blob)) {
      throw validationFailed('Missing zip file');
    }
    let metaObj: unknown;
    try { metaObj = JSON.parse(metaPart); } catch { throw validationFailed('Invalid meta JSON'); }
    const metaResult = draftLinkCreateSchema.safeParse(metaObj);
    if (!metaResult.success) throw validationFailed('Invalid meta', { issues: metaResult.error.issues });
    snapshotId = metaResult.data.snapshotId;
    ttlDays = metaResult.data.ttlDays ?? 30;
    incomingZip = await (zipPart as Blob).arrayBuffer();
    if (incomingZip.byteLength === 0) throw validationFailed('Empty zip');
    enforceBlobSize(incomingZip.byteLength, draftQuotas.blobBytes);
  } else {
    const body = await parseJson(c, draftLinkCreateSchema);
    snapshotId = body.snapshotId;
    ttlDays = body.ttlDays ?? 30;
  }

  const snapshot = await requireOwnedSnapshot(c.env, project.id, snapshotId);

  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const key = draftZipKey(project.id, tokenHash);

  if (incomingZip) {
    await putFeedBlob(c.env, key, incomingZip, { contentType: 'application/zip' });
  } else {
    if (!snapshot.zip_r2_key) {
      throw validationFailed('This snapshot has no rendered ZIP. Create a draft link with multipart form instead.');
    }
    const source = await getFeedBlob(c.env, snapshot.zip_r2_key);
    if (!source) throw notFound('Rendered ZIP missing from storage');
    const buf = await source.arrayBuffer();
    await putFeedBlob(c.env, key, buf, { contentType: 'application/zip' });
  }

  const expiresAt = now + ttlDays * 24 * 60 * 60 * 1000;
  await c.env.DB.prepare(
    `INSERT INTO draft_link (token_hash, project_id, snapshot_id, created_by_user_id, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(tokenHash, project.id, snapshot.id, user.id, expiresAt, now)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.create_draft_link',
    metadata: { snapshotId: snapshot.id, expiresAt },
    ip: clientIp(c.req.raw),
  });

  const url = `${c.env.FEEDS_ORIGIN.replace(/\/$/, '')}/${project.slug}/draft/${token}.zip`;
  return c.json({ url, token, tokenHash, expiresAt });
});

projectsRouter.get('/:id/draft-links', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'viewer');
  const now = Date.now();

  const rows = await c.env.DB.prepare(
    `SELECT token_hash, snapshot_id, expires_at, created_at
       FROM draft_link
       WHERE project_id = ?
         AND revoked_at IS NULL
         AND expires_at > ?
       ORDER BY created_at DESC`,
  )
    .bind(project.id, now)
    .all<{ token_hash: string; snapshot_id: string; expires_at: number; created_at: number }>();

  return c.json({
    links: (rows.results ?? []).map((r) => ({
      tokenHash: r.token_hash,
      snapshotId: r.snapshot_id,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    })),
  });
});

projectsRouter.delete('/:id/draft-links/:tokenHash', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const tokenHash = c.req.param('tokenHash');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');

  const row = await c.env.DB.prepare(
    `SELECT token_hash, project_id, revoked_at FROM draft_link WHERE token_hash = ? AND project_id = ?`,
  )
    .bind(tokenHash, project.id)
    .first<{ token_hash: string; project_id: string; revoked_at: number | null }>();
  if (!row) throw notFound('Draft link not found');

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE draft_link SET revoked_at = ? WHERE token_hash = ?`,
  )
    .bind(now, tokenHash)
    .run();
  // Best-effort: remove the R2 blob so it can't leak via a stale URL.
  await deleteFeedBlob(c.env, draftZipKey(project.id, tokenHash));

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.revoke_draft_link',
    metadata: { tokenHash },
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

// ─── Catalog submissions (BE-80..83) ───────────────────────────────────────────

projectsRouter.post('/:id/catalog-submissions', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
  // Mobility Database / transit.land submission is a paid feature.
  await requireOwnerFeature(c.env, project.owner_type as OwnerType, project.owner_id, 'mobility_db_submit', user);
  const body = await parseJson(c, catalogCreateSchema);
  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO project_catalog_submission
       (project_id, catalog, external_feed_id, opted_in_at, last_submitted_at, status, last_error)
     VALUES (?, ?, NULL, ?, NULL, 'pending', NULL)
     ON CONFLICT(project_id, catalog) DO UPDATE SET
       opted_in_at = excluded.opted_in_at,
       status = 'pending',
       last_error = NULL`,
  )
    .bind(project.id, body.catalog, now)
    .run();

  const row = await c.env.DB.prepare(
    `SELECT project_id, catalog, external_feed_id, opted_in_at, last_submitted_at, status, last_error
       FROM project_catalog_submission WHERE project_id = ? AND catalog = ?`,
  )
    .bind(project.id, body.catalog)
    .first<{
      project_id: string;
      catalog: string;
      external_feed_id: string | null;
      opted_in_at: number;
      last_submitted_at: number | null;
      status: string;
      last_error: string | null;
    }>();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.catalog_opt_in',
    metadata: { catalog: body.catalog },
    ip: clientIp(c.req.raw),
  });

  return c.json({
    submission: row && {
      projectId: row.project_id,
      catalog: row.catalog,
      externalFeedId: row.external_feed_id,
      optedInAt: row.opted_in_at,
      lastSubmittedAt: row.last_submitted_at,
      status: row.status,
      lastError: row.last_error,
    },
  });
});

projectsRouter.get('/:id/catalog-submissions', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'viewer');

  const rows = await c.env.DB.prepare(
    `SELECT project_id, catalog, external_feed_id, opted_in_at, last_submitted_at, status, last_error
       FROM project_catalog_submission WHERE project_id = ? ORDER BY catalog`,
  )
    .bind(project.id)
    .all<{
      project_id: string;
      catalog: string;
      external_feed_id: string | null;
      opted_in_at: number;
      last_submitted_at: number | null;
      status: string;
      last_error: string | null;
    }>();

  return c.json({
    submissions: (rows.results ?? []).map((r) => ({
      projectId: r.project_id,
      catalog: r.catalog,
      externalFeedId: r.external_feed_id,
      optedInAt: r.opted_in_at,
      lastSubmittedAt: r.last_submitted_at,
      status: r.status,
      lastError: r.last_error,
    })),
  });
});

projectsRouter.delete('/:id/catalog-submissions/:catalog', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const catalog = c.req.param('catalog');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
  if (catalog !== 'mobility_db' && catalog !== 'transit_land') {
    throw validationFailed('Unknown catalog');
  }
  await c.env.DB.prepare(
    `DELETE FROM project_catalog_submission WHERE project_id = ? AND catalog = ?`,
  )
    .bind(project.id, catalog)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.catalog_opt_out',
    metadata: { catalog },
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

// ─── Open-catalog listing (issue #47) ──────────────────────────────────────────
//
// The PULL-model opt-in: list this feed in feeds.<zone>/catalog.json, which
// MobilityData / TransitLand scan on their own cadence. Distinct from the dead
// PUSH machinery above (project_catalog_submission → the MDB v1 API, which 405s
// on third-party writes). State lives on feed_project.catalog_publisher_type:
// NULL = not listed; 'official' | 'community' = listed with that declaration.
// Opt-out (DELETE) clears it, dropping the feed from the endpoint on next scan.

projectsRouter.get('/:id/catalog-listing', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'viewer');

  const row = await c.env.DB.prepare(
    `SELECT catalog_publisher_type, mdb_source_id FROM feed_project WHERE id = ?`,
  )
    .bind(project.id)
    .first<{ catalog_publisher_type: string | null; mdb_source_id: number | null }>();

  return c.json({
    listing: {
      listed: row?.catalog_publisher_type != null,
      publisherType: row?.catalog_publisher_type ?? null,
      mdbSourceId: row?.mdb_source_id ?? null,
    },
  });
});

projectsRouter.put('/:id/catalog-listing', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
  const body = await parseJson(c, catalogListingSchema);

  await c.env.DB.prepare(
    `UPDATE feed_project SET catalog_publisher_type = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(body.publisherType, Date.now(), project.id)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.catalog_opt_in',
    metadata: { catalog: 'open_catalog', publisherType: body.publisherType },
    ip: clientIp(c.req.raw),
  });

  return c.json({ listing: { listed: true, publisherType: body.publisherType } });
});

projectsRouter.delete('/:id/catalog-listing', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');

  await c.env.DB.prepare(
    `UPDATE feed_project SET catalog_publisher_type = NULL, updated_at = ? WHERE id = ?`,
  )
    .bind(Date.now(), project.id)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.catalog_opt_out',
    metadata: { catalog: 'open_catalog' },
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

// ─── RT feed URLs (BE-87..89) ──────────────────────────────────────────────────

projectsRouter.get('/:id/rt-feeds', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'viewer');

  // Only external (managed=0) feeds belong to this editor; the managed Service
  // Alerts row is owned by the alerts feature.
  const rows = await c.env.DB.prepare(
    `SELECT id, kind, url FROM project_rt_feed WHERE project_id = ? AND managed = 0 ORDER BY created_at`,
  )
    .bind(project.id)
    .all<{ id: string; kind: string; url: string }>();
  return c.json({ feeds: rows.results ?? [] });
});

projectsRouter.put('/:id/rt-feeds', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
  const body = await parseJson(c, rtFeedsPutSchema);
  const now = Date.now();

  // Replace only external feeds; never touch the managed Service Alerts row.
  await c.env.DB.prepare(`DELETE FROM project_rt_feed WHERE project_id = ? AND managed = 0`)
    .bind(project.id)
    .run();
  for (const feed of body.feeds) {
    await c.env.DB.prepare(
      `INSERT INTO project_rt_feed (id, project_id, kind, url, created_at, managed) VALUES (?, ?, ?, ?, ?, 0)`,
    )
      .bind(ulid(), project.id, feed.kind, feed.url, now)
      .run();
  }

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.rt_feeds_update',
    metadata: { count: body.feeds.length },
    ip: clientIp(c.req.raw),
  });

  const rows = await c.env.DB.prepare(
    `SELECT id, kind, url FROM project_rt_feed WHERE project_id = ? AND managed = 0 ORDER BY created_at`,
  )
    .bind(project.id)
    .all<{ id: string; kind: string; url: string }>();
  return c.json({ feeds: rows.results ?? [] });
});

projectsRouter.delete('/:id/rt-feeds/:rtId', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const rtId = c.req.param('rtId');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');

  const row = await c.env.DB.prepare(
    `SELECT id FROM project_rt_feed WHERE id = ? AND project_id = ? AND managed = 0`,
  )
    .bind(rtId, project.id)
    .first<{ id: string }>();
  if (!row) throw notFound('RT feed not found');
  await c.env.DB.prepare(`DELETE FROM project_rt_feed WHERE id = ?`).bind(rtId).run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.rt_feed_delete',
    metadata: { rtId },
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

// ─── Embed impression counts (EM-131 / EM-135) ──────────────────────────────────
//
// Owner-facing rollup of the privacy-respecting embed view counters written by
// the public beacon (worker/embeds/beacon.ts → embed_impression). No PII is
// stored or returned — only aggregate counts per (day, kind, target). Gated by
// project access (viewer is enough; it's read-only) plus the owner's `embeds`
// entitlement, matching the rest of the embed surface.
projectsRouter.get('/:id/embed-impressions', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'viewer');
  await requireOwnerFeature(c.env, project.owner_type as OwnerType, project.owner_id, 'embeds', user);

  // Optional ?days=N window (default 30, max 365). Counts are bucketed by UTC day.
  const daysParam = parseInt(c.req.query('days') ?? '30', 10);
  const days = Number.isFinite(daysParam) ? Math.min(365, Math.max(1, daysParam)) : 30;
  const sinceDay = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);

  const rows = await c.env.DB.prepare(
    `SELECT day, kind, target, views
       FROM embed_impression
      WHERE project_id = ? AND day >= ?
      ORDER BY day DESC, kind, target`,
  )
    .bind(project.id, sinceDay)
    .all<{ day: string; kind: string; target: string; views: number }>();

  const results = rows.results ?? [];
  let total = 0;
  const byKind: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  // Per-target rollup keyed by `${kind}:${target}` so the UI can show the top
  // routes/stops by views.
  const byTarget: Record<string, { kind: string; target: string; views: number }> = {};
  for (const r of results) {
    total += r.views;
    byKind[r.kind] = (byKind[r.kind] ?? 0) + r.views;
    byDay[r.day] = (byDay[r.day] ?? 0) + r.views;
    if (r.target) {
      const key = `${r.kind}:${r.target}`;
      const cur = byTarget[key] ?? { kind: r.kind, target: r.target, views: 0 };
      cur.views += r.views;
      byTarget[key] = cur;
    }
  }
  const topTargets = Object.values(byTarget).sort((a, b) => b.views - a.views).slice(0, 25);

  return c.json({
    window_days: days,
    since: sinceDay,
    total,
    by_kind: byKind,
    by_day: byDay,
    top_targets: topTargets,
  });
});

// Keep snapshotZipKey imported — future Phase 2 work will begin writing ZIPs
// into snapshot slots, at which point publish's JSON body path exercises it.
void snapshotZipKey;
