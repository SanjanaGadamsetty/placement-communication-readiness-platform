import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../shared/db/pool';
import { AppError } from '../shared/errors/AppError';
import { sendSuccess, sendError } from '../shared/helpers/response';
import { AuthRequest } from '../middleware/authenticate';
import { requireRole } from '../middleware/authorize';
import { cache } from '../services/cacheService';
import { sendStaffWelcomeEmail } from '../services/emailService';

export const adminRouter = Router();

const VALID_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED'] as const;

// ── POST /api/admin/users — create a new staff account ────────────────────────

const CreateUserSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email().transform((s) => s.toLowerCase()),
  role: z.enum(['FACULTY_MENTOR', 'TRAINER', 'PLACEMENT_COORDINATOR', 'PROGRAM_ADMIN']),
});

adminRouter.post(
  '/users',
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const parsed = CreateUserSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(422, 'Invalid request body', 'VALIDATION_ERROR');

      const { name, email, role } = parsed.data;

      // PROGRAM_ADMIN cannot create another PROGRAM_ADMIN
      if (role === 'PROGRAM_ADMIN' && req.user!.role !== 'SUPER_ADMIN') {
        throw new AppError(403, 'Only SUPER_ADMIN can create PROGRAM_ADMIN accounts', 'FORBIDDEN');
      }

      // Check email not already taken
      const { rows: existing } = await db.query(
        'SELECT id FROM identity.users WHERE email = $1',
        [email],
      );
      if (existing.length > 0) throw new AppError(409, 'Email already in use', 'EMAIL_CONFLICT');

      // Generate random 12-char password satisfying most "symbol + number" policies
      const rawPassword = crypto.randomBytes(9).toString('base64url').slice(0, 10) + '#1';
      const passwordHash = await bcrypt.hash(rawPassword, 12);

      const { rows } = await db.query(
        `INSERT INTO identity.users (name, email, password_hash, role, status)
         VALUES ($1, $2, $3, $4, 'ACTIVE')
         RETURNING id, name, email, role, created_at`,
        [name, email, passwordHash, role],
      );
      const newUser = rows[0];

      // Get creator's name for the welcome email
      const { rows: creatorRows } = await db.query<{ name: string }>(
        'SELECT name FROM identity.users WHERE id = $1',
        [req.user!.id],
      );
      const creatorName = creatorRows[0]?.name ?? 'An administrator';

      // Non-blocking — email failure never fails the HTTP request
      sendStaffWelcomeEmail({
        to: email,
        name,
        role,
        password: rawPassword,
        createdBy: creatorName,
      }).catch((err) => console.error('[emailService] Failed to send welcome email:', err));

      await cache.delPattern('admin:users:*');
      sendSuccess(res, { user: newUser }, 201);
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ── GET /api/admin/users (PROGRAM_ADMIN) ──────────────────────────────────────

adminRouter.get(
  '/users',
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const roleFilter = (req.query.role as string) ?? null;
      const statusFilter = (req.query.status as string) ?? null;
      const searchFilter = (req.query.search as string) ?? null;

      const key = `admin:users:${roleFilter}:${statusFilter}:${searchFilter}`;
      const cached = await cache.get<{ users: unknown[] }>(key);
      if (cached) { sendSuccess(res, cached); return; }

      const { rows } = await db.query(
        `SELECT id, name, email, role, status, created_at
         FROM identity.users
         WHERE ($1::text IS NULL OR role::text = $1)
           AND ($2::text IS NULL OR status::text = $2)
           AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%' OR email ILIKE '%' || $3 || '%')
         ORDER BY created_at DESC
         LIMIT 100`,
        [roleFilter, statusFilter, searchFilter]
      );
      const data = { users: rows };
      await cache.set(key, data, 120);
      sendSuccess(res, data);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ── PATCH /api/admin/users/:userId/role (PROGRAM_ADMIN) ───────────────────────

const roleSchema = z.object({
  role: z.enum(['STUDENT', 'FACULTY_MENTOR', 'PROGRAM_ADMIN', 'TRAINER', 'PLACEMENT_COORDINATOR']),
});

adminRouter.patch(
  '/users/:userId/role',
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { userId } = req.params;
      const parsed = roleSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(422, 'Invalid role value', 'VALIDATION_ERROR');

      // Prevent granting PROGRAM_ADMIN (privilege escalation without oversight).
      if (parsed.data.role === 'PROGRAM_ADMIN') {
        throw new AppError(403, 'Cannot grant PROGRAM_ADMIN role via this endpoint', 'FORBIDDEN');
      }

      // Fix 6: prevent demoting or modifying SUPER_ADMIN accounts
      const { rows: targetRows } = await db.query<{ role: string }>(
        'SELECT role FROM identity.users WHERE id = $1',
        [userId],
      );
      if (targetRows.length === 0) throw new AppError(404, 'User not found', 'NOT_FOUND');
      if (targetRows[0].role === 'SUPER_ADMIN') {
        throw new AppError(403, 'Cannot modify a SUPER_ADMIN account', 'FORBIDDEN');
      }

      const { rows } = await db.query(
        `UPDATE identity.users
         SET role = $1, token_version = token_version + 1, updated_at = now()
         WHERE id = $2
         RETURNING id, name, email, role`,
        [parsed.data.role, userId]
      );
      if (rows.length === 0) throw new AppError(404, 'User not found', 'NOT_FOUND');

      await cache.delPattern('admin:users:*');
      sendSuccess(res, { user: rows[0] });
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ── PATCH /api/admin/users/:userId/status (PROGRAM_ADMIN) ─────────────────────

const statusSchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
});

adminRouter.patch(
  '/users/:userId/status',
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { userId } = req.params;
      const parsed = statusSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(422, 'Invalid status value', 'VALIDATION_ERROR');

      const { rows } = await db.query(
        `UPDATE identity.users
         SET status = $1, updated_at = now()
         WHERE id = $2
         RETURNING id, name, email, status`,
        [parsed.data.status, userId]
      );
      if (rows.length === 0) throw new AppError(404, 'User not found', 'NOT_FOUND');

      await cache.delPattern('admin:users:*');
      sendSuccess(res, { user: rows[0] });
    } catch (err) {
      sendError(res, err);
    }
  }
);
