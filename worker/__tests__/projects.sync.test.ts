// /api/projects/:id/working-state — optimistic-concurrency save/load round-trip.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
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

async function loggedInClient(email: string, plan: 'free' | 'agency' | 'enterprise' = 'agency') {
  const user = await seedUser({ email, plan });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return client;
}

describe('/api/projects/:id/working-state', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('GET returns 404 when no working-state blob has been written yet', async () => {
    const client = await loggedInClient('sync1@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Empty' }),
    );
    const res = await client.get(`/api/projects/${proj.id}/working-state`);
    expect(res.status).toBe(404);
    // The two 404s must be distinguishable. This one is the boring case.
    const body = (await res.json()) as { reason?: string; snapshotCount?: number };
    expect(body.reason).toBe('never_saved');
    expect(body.snapshotCount).toBe(0);
  });

  // A recorded working_state_r2_key whose R2 object is gone is REAL DATA LOSS.
  // It used to return the same bare 404 as "never saved", which meant the
  // client reported it to the user as an ordinary empty feed and filed it in
  // telemetry under the same label. Both halves of that are fixed here.
  it('GET distinguishes a MISSING blob from a never-saved feed, and logs it', async () => {
    const client = await loggedInClient('syncmissing@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Lost' }),
    );
    await client.put(`/api/projects/${proj.id}/working-state`, undefined, {
      body: await gzip(JSON.stringify({ routes: [{ route_id: 'R1' }] })),
      headers: { 'Content-Encoding': 'gzip', 'If-Match': '0', 'Content-Type': 'application/json' },
    });
    // Delete the blob out from under D1 — the exact shape of the loss.
    await testEnv.FEEDS.delete(`projects/${proj.id}/working-state.json.gz`);

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await client.get(`/api/projects/${proj.id}/working-state`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { reason?: string };
      expect(body.reason).toBe('blob_missing');
      // This branch should never fire in production; when it does we need to
      // hear about it immediately, not find it in a quarterly sweep.
      expect(errorLog).toHaveBeenCalled();
      expect(String(errorLog.mock.calls[0][0])).toContain('[working-state]');
    } finally {
      errorLog.mockRestore();
    }
  });

  it('GET reports the saved-version count so the client can warn on a blank canvas', async () => {
    const client = await loggedInClient('synccount@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Counted' }),
    );
    await client.put(`/api/projects/${proj.id}/working-state`, undefined, {
      body: await gzip(JSON.stringify({ routes: [] })),
      headers: { 'Content-Encoding': 'gzip', 'If-Match': '0', 'Content-Type': 'application/json' },
    });

    const before = await client.get(`/api/projects/${proj.id}/working-state`);
    expect(before.headers.get('X-Snapshot-Count')).toBe('0');

    const form = new FormData();
    form.append(
      'state',
      new Blob([await gzip(JSON.stringify({ routes: [{ route_id: 'R1' }] }))]),
      'state.json.gz',
    );
    form.append('meta', JSON.stringify({ summary: {}, validationErrors: 0, validationWarnings: 0 }));
    await client.post(`/api/projects/${proj.id}/snapshots`, undefined, { body: form });

    const after = await client.get(`/api/projects/${proj.id}/working-state`);
    expect(after.headers.get('X-Snapshot-Count')).toBe('1');
    // Same number on the detail route, which is what the 404 path reads.
    const detail = await client.json<{ snapshotCount: number }>(
      await client.get(`/api/projects/${proj.id}`),
    );
    expect(detail.snapshotCount).toBe(1);
  });

  it('PUT with If-Match: 0 succeeds and returns workingStateVersion: 1', async () => {
    const client = await loggedInClient('sync2@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Save' }),
    );

    const payload = JSON.stringify({ routes: [], stops: [] });
    const body = await gzip(payload);

    const put = await client.put(`/api/projects/${proj.id}/working-state`, undefined, {
      body,
      headers: { 'Content-Encoding': 'gzip', 'If-Match': '0', 'Content-Type': 'application/json' },
    });
    expect(put.status).toBe(200);
    const parsed = await client.json<{ workingStateVersion: number }>(put);
    expect(parsed.workingStateVersion).toBe(1);
  });

  it('GET after PUT returns the gzipped body and X-Working-State-Version header', async () => {
    const client = await loggedInClient('sync3@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Round Trip' }),
    );

    const payload = JSON.stringify({ hello: 'world', n: 42 });
    await client.put(`/api/projects/${proj.id}/working-state`, undefined, {
      body: await gzip(payload),
      headers: { 'Content-Encoding': 'gzip', 'If-Match': '0' },
    });

    const getRes = await client.get(`/api/projects/${proj.id}/working-state`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('X-Working-State-Version')).toBe('1');
    // Worker decompresses the R2 blob and streams plain JSON to the client —
    // a manually-set Content-Encoding header on a Worker response isn't
    // auto-decoded by browser fetch, so we send the bytes raw. CF's edge
    // re-gzips on the wire when the client sends Accept-Encoding: gzip.
    expect(await getRes.json()).toEqual({ hello: 'world', n: 42 });
  });

  it('stale If-Match on second write returns 409 conflict with currentVersion', async () => {
    const client = await loggedInClient('sync4@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Race' }),
    );

    await client.put(`/api/projects/${proj.id}/working-state`, undefined, {
      body: await gzip(JSON.stringify({ first: true })),
      headers: { 'Content-Encoding': 'gzip', 'If-Match': '0' },
    });

    // Second write still with If-Match: 0 — now the server is at version 1.
    const stale = await client.put(`/api/projects/${proj.id}/working-state`, undefined, {
      body: await gzip(JSON.stringify({ second: true })),
      headers: { 'Content-Encoding': 'gzip', 'If-Match': '0' },
    });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { error: string; currentVersion: number };
    expect(body.error).toBe('conflict');
    expect(body.currentVersion).toBe(1);
  });

  it('missing If-Match header returns 409 (spec requires it)', async () => {
    const client = await loggedInClient('sync5@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'NoEtag' }),
    );

    const res = await client.put(`/api/projects/${proj.id}/working-state`, undefined, {
      body: await gzip(JSON.stringify({ anything: true })),
      headers: { 'Content-Encoding': 'gzip' },
    });
    expect(res.status).toBe(409);
  });

  it('oversize body is rejected with 413', async () => {
    // Free plan caps the blob at 20 MB (per quotas.ts). Send 21 MB.
    const client = await loggedInClient('sync6@example.com', 'free');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Huge' }),
    );

    // Build a >20 MB incompressible body. Random bytes gzip to ~same size.
    const raw = new Uint8Array(21 * 1024 * 1024);
    crypto.getRandomValues(raw.subarray(0, 1024));
    // Fill the rest with pseudo-random from the seed so gzip can't squash it.
    for (let i = 1024; i < raw.length; i += 1024) raw.set(raw.subarray(0, 1024), i);
    // Not actually gzipped content — but server doesn't verify, just sends the raw bytes
    // through R2 with content-encoding: gzip. Size check happens pre-write.
    const res = await client.put(`/api/projects/${proj.id}/working-state`, undefined, {
      body: raw,
      headers: { 'Content-Encoding': 'gzip', 'If-Match': '0' },
    });
    // Implementation returns 413 on >plan.blobBytes. (A 409 would mean the
    // concurrency guard tripped first — check that didn't happen.)
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('quota_exceeded');
  });
});
