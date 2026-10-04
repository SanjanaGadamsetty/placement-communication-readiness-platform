import { Router, Request, Response } from 'express';
import { db } from '../shared/db/pool';
import { sendSuccess, sendError } from '../shared/helpers/response';
import { cache } from '../services/cacheService';

export const orgRouter = Router();

// ── GET /api/org/institutions ─────────────────────────────────────────────────

orgRouter.get('/institutions', async (_req: Request, res: Response): Promise<void> => {
  try {
    const key = 'org:institutions:all';
    const cached = await cache.get<{ items: unknown[] }>(key);
    if (cached) { sendSuccess(res, cached); return; }

    const { rows } = await db.query(
      `SELECT id, name, code, type, created_at FROM org.institutions ORDER BY name`
    );
    const data = { items: rows };
    await cache.set(key, data, 3600);
    sendSuccess(res, data);
  } catch (err) {
    sendError(res, err);
  }
});

// ── GET /api/org/programs?institution_id= ────────────────────────────────────

orgRouter.get('/programs', async (req: Request, res: Response): Promise<void> => {
  try {
    const institutionId = (req.query.institution_id as string) ?? null;
    const key = `org:programs:${institutionId ?? 'all'}`;
    const cached = await cache.get<{ items: unknown[] }>(key);
    if (cached) { sendSuccess(res, cached); return; }

    const { rows } = await db.query(
      `SELECT id, institution_id, name, code, created_at FROM org.programs
       WHERE ($1::text IS NULL OR institution_id::text = $1)
       ORDER BY name`,
      [institutionId]
    );
    const data = { items: rows };
    await cache.set(key, data, 3600);
    sendSuccess(res, data);
  } catch (err) {
    sendError(res, err);
  }
});

// ── GET /api/org/batches?program_id= ─────────────────────────────────────────

orgRouter.get('/batches', async (req: Request, res: Response): Promise<void> => {
  try {
    const programId = (req.query.program_id as string) ?? null;
    const key = `org:batches:${programId ?? 'all'}`;
    const cached = await cache.get<{ items: unknown[] }>(key);
    if (cached) { sendSuccess(res, cached); return; }

    const { rows } = await db.query(
      `SELECT id, program_id, name, year, track, created_at FROM org.batches
       WHERE ($1::text IS NULL OR program_id::text = $1)
       ORDER BY year DESC, name`,
      [programId]
    );
    const data = { items: rows };
    await cache.set(key, data, 3600);
    sendSuccess(res, data);
  } catch (err) {
    sendError(res, err);
  }
});

// ── GET /api/org/subdivisions?batch_id= ──────────────────────────────────────

orgRouter.get('/subdivisions', async (req: Request, res: Response): Promise<void> => {
  try {
    const batchId = (req.query.batch_id as string) ?? null;
    const key = `org:subdivisions:${batchId ?? 'all'}`;
    const cached = await cache.get<{ items: unknown[] }>(key);
    if (cached) { sendSuccess(res, cached); return; }

    const { rows } = await db.query(
      `SELECT id, batch_id, name, type, created_at FROM org.subdivisions
       WHERE ($1::text IS NULL OR batch_id::text = $1)
       ORDER BY name`,
      [batchId]
    );
    const data = { items: rows };
    await cache.set(key, data, 3600);
    sendSuccess(res, data);
  } catch (err) {
    sendError(res, err);
  }
});
