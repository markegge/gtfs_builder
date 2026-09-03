// /api/projects/:id/snapshots — create via multipart, list, fetch state,
// restore to working state, delete.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient } from './_client';
import {
  applyMigrations,
  env as testEnv,
  gzip,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

async function loggedInClient(email: string) {
  const user = await seedUser({ email });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return client;
}

async function postSnapshot(
  client: ReturnType<typeof makeClient>,
  projectId: string,
  state: unknown,
  meta: Record<string, unknown>,
): Promise<{ snapshot: { id: string; label: string | null } }> {
  const form = new FormData();
  const stateBuf = await gzip(JSON.stringify(state));
  form.append('state', new Blob([stateBuf], { type: 'application/json' }), 'state.json.gz');
  form.append('meta', JSON.stringify(meta));
  const res = await client.post(`/api/projects/${projectId}/snapshots`, undefined, { body: form });
  return client.json(res);
}

describe('/api/projects/:id/snapshots', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('POST snapshot with multipart + list returns the new snapshot', async () => {
    const client = await loggedInClient('ver1@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Feed' }),
    );
    const created = await postSnapshot(
      client,
      proj.id,
      { routes: [{ id: 'r1' }] },
      { label: 'First cut', summary: { routes: 1 }, validationErrors: 0, validationWarnings: 0 },
    );
    expect(created.snapshot.id).toBeTruthy();
    expect(created.snapshot.label).toBe('First cut');

    const list = await client.json<{ snapshots: { id: string; label: string | null }[] }>(
      await client.get(`/api/projects/${proj.id}/snapshots`),
    );
    expect(list.snapshots).toHaveLength(1);
    expect(list.snapshots[0].label).toBe('First cut');
  });

  it('GET snapshot state returns the stored blob (gzipped)', async () => {
    const client = await loggedInClient('ver2@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Feed' }),
    );
    const v = await postSnapshot(
      client,
      proj.id,
      { message: 'hello snapshots' },
      { summary: {}, validationErrors: 0, validationWarnings: 0 },
    );

    const state = await client.get(`/api/projects/${proj.id}/snapshots/${v.snapshot.id}/state`);
    expect(state.status).toBe(200);
    // Worker decompresses server-side and streams plain JSON. See the
    // matching note on GET /working-state in projects.sync.test.ts.
    expect(await state.json()).toEqual({ message: 'hello snapshots' });
  });

  it('restore copies a snapshot\'s state into working state and bumps the version counter', async () => {
    const client = await loggedInClient('ver3@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Restore' }),
    );
    const v = await postSnapshot(
      client,
      proj.id,
      { from: 'snapshot' },
      { summary: {}, validationErrors: 0, validationWarnings: 0 },
    );

    const restore = await client.post(`/api/projects/${proj.id}/snapshots/${v.snapshot.id}/restore`);
    const body = await client.json<{ workingStateVersion: number }>(restore);
    expect(body.workingStateVersion).toBeGreaterThanOrEqual(1);

    const ws = await client.get(`/api/projects/${proj.id}/working-state`);
    expect(ws.status).toBe(200);
    expect(await ws.json()).toEqual({ from: 'snapshot' });
  });

  it('DELETE removes the snapshot from listing and from R2', async () => {
    const client = await loggedInClient('ver4@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'DelVer' }),
    );
    const v = await postSnapshot(
      client,
      proj.id,
      { keep: false },
      { summary: {}, validationErrors: 0, validationWarnings: 0 },
    );

    // Sanity: the R2 blob exists.
    const r2before = await testEnv.FEEDS.get(`projects/${proj.id}/snapshots/${v.snapshot.id}/state.json.gz`);
    expect(r2before).not.toBeNull();

    const del = await client.delete(`/api/projects/${proj.id}/snapshots/${v.snapshot.id}`);
    expect(del.status).toBe(204);

    const list = await client.json<{ snapshots: unknown[] }>(
      await client.get(`/api/projects/${proj.id}/snapshots`),
    );
    expect(list.snapshots).toHaveLength(0);

    const r2after = await testEnv.FEEDS.get(`projects/${proj.id}/snapshots/${v.snapshot.id}/state.json.gz`);
    expect(r2after).toBeNull();
  });

  // ── "Save a version" must not leave the live feed behind ─────────────────
  //
  // The bug: a snapshot POST wrote the version and nothing else, so a user who
  // treated "Save a version" as Save ended up with their content in an
  // immutable snapshot and a feed that opens blank. The web client now saves
  // the working state first, but the route is public API — this is the
  // server-side backstop for every other caller.
  describe('working-state backstop', () => {
    it('seeds the working state when the feed has never had one', async () => {
      const client = await loggedInClient('seed1@example.com');
      const proj = await client.json<{ id: string; workingStateVersion: number }>(
        await client.post('/api/projects', { name: 'Never saved' }),
      );
      expect(proj.workingStateVersion).toBe(0);
      // Precondition: opening this feed right now gives you nothing.
      expect((await client.get(`/api/projects/${proj.id}/working-state`)).status).toBe(404);

      const created = await postSnapshot(
        client,
        proj.id,
        { routes: [{ route_id: 'R1' }], stops: [] },
        { summary: {}, validationErrors: 0, validationWarnings: 0 },
      );
      // The new version token is handed back so the client's If-Match stays fresh.
      expect((created as { workingStateVersion?: number }).workingStateVersion).toBe(1);

      // …and the live feed is no longer blank.
      const ws = await client.get(`/api/projects/${proj.id}/working-state`);
      expect(ws.status).toBe(200);
      expect(await ws.json()).toEqual({ routes: [{ route_id: 'R1' }], stops: [] });
    });

    it('NEVER overwrites a working state that already exists', async () => {
      const client = await loggedInClient('seed2@example.com');
      const proj = await client.json<{ id: string }>(
        await client.post('/api/projects', { name: 'Already saved' }),
      );
      const live = { routes: [{ route_id: 'LIVE' }] };
      await client.put(`/api/projects/${proj.id}/working-state`, undefined, {
        body: await gzip(JSON.stringify(live)),
        headers: { 'Content-Encoding': 'gzip', 'If-Match': '0', 'Content-Type': 'application/json' },
      });

      // A snapshot of some OTHER state (e.g. a stale tab) must not clobber it —
      // the server cannot tell a stale live state from an intentional one.
      const created = await postSnapshot(
        client,
        proj.id,
        { routes: [{ route_id: 'SNAPSHOT' }] },
        { summary: {}, validationErrors: 0, validationWarnings: 0 },
      );
      expect((created as { workingStateVersion?: number }).workingStateVersion).toBeUndefined();

      const ws = await client.get(`/api/projects/${proj.id}/working-state`);
      expect(await ws.json()).toEqual(live);
      expect(ws.headers.get('X-Working-State-Version')).toBe('1');
    });
  });

  it('POST snapshot with missing meta returns 422', async () => {
    const client = await loggedInClient('ver5@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Invalid' }),
    );
    const form = new FormData();
    form.append('state', new Blob([await gzip('{}')], { type: 'application/json' }), 'state.json.gz');
    // no meta part
    const res = await client.post(`/api/projects/${proj.id}/snapshots`, undefined, { body: form });
    expect(res.status).toBe(422);
  });
});
