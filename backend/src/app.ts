import http from 'http';
import { parse as parseUrl } from 'url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import jwt from 'jsonwebtoken';
import { WebSocketServer, WebSocket } from 'ws';
import { env } from './config/env';
import { router } from './routes';
import { errorHandler } from './middleware/errorHandler';
import { db } from './shared/db/pool';
import { wsManager } from './services/wsManager';
import * as deepgramService from './services/deepgramService';
import { triggerLLMEvaluation } from './services/llmEvaluationService';
import { JWTPayload } from './shared/types/auth';

const app = express();

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN }));
app.use(express.json());
app.use(morgan('dev'));

app.use('/api', router);

app.use(errorHandler);

// ── WebSocket server attached to the same HTTP server ─────────────────────────

export function attachWebSocket(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/interview' });

  wss.on('connection', async (ws: WebSocket, req) => {
    const { query } = parseUrl(req.url ?? '', true);
    const sessionId = query.sessionId as string | undefined;
    const token = query.token as string | undefined;

    const reject = (reason: string) => {
      try {
        ws.send(JSON.stringify({ type: 'error', message: reason }));
      } catch {}
      ws.terminate();
    };

    if (!sessionId || !token) {
      reject('sessionId and token query params are required');
      return;
    }

    // Verify JWT + DB token_version (same logic as authenticate middleware)
    let decoded: JWTPayload;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET) as JWTPayload;
    } catch {
      reject('Invalid or expired token');
      return;
    }

    try {
      const { rows } = await db.query<{ token_version: number; status: string }>(
        'SELECT token_version, status FROM identity.users WHERE id = $1',
        [decoded.id],
      );
      if (rows.length === 0) { reject('User not found'); return; }
      if (rows[0].status === 'SUSPENDED') { reject('Account suspended'); return; }
      if (rows[0].token_version !== decoded.tokenVersion) { reject('Token revoked'); return; }
    } catch {
      reject('Auth check failed');
      return;
    }

    // Fix 4: verify the session belongs to the authenticated user
    try {
      const { rows: sessionRows } = await db.query<{ student_id: string }>(
        'SELECT student_id FROM session.interview_sessions WHERE id = $1',
        [sessionId],
      );
      if (sessionRows.length === 0) { reject('Session not found'); return; }
      if (sessionRows[0].student_id !== decoded.id) { reject('Access denied'); return; }
    } catch {
      reject('Session ownership check failed');
      return;
    }

    wsManager.register(sessionId, ws);
    console.log(`[ws] connected  session=${sessionId}`);

    ws.on('message', async (data: import('ws').RawData, isBinary: boolean) => {
      if (isBinary) {
        // Binary frame: raw MediaRecorder audio chunk → forward to Deepgram
        deepgramService.sendAudio(sessionId, data as Buffer);
        return;
      }

      // JSON control message
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === 'audio_start') {
        deepgramService.openSession(
          sessionId,
          {
            questionText: String(msg.questionText ?? ''),
            difficulty: (msg.difficulty as 'EASY' | 'MEDIUM' | 'ADVANCED') ?? 'EASY',
            turnNumber: Number(msg.turnNumber ?? 1),
            studentId: decoded.id,
            domain: msg.domain ? String(msg.domain) : undefined,
          },
          async (transcript, meta) => {
            try {
              await triggerLLMEvaluation(sessionId, transcript, meta);
            } catch (err) {
              console.error('[ws] LLM evaluation error:', err);
            }
          },
        ).catch((err) => {
          console.error('[ws] openSession error:', err);
        });
      } else if (msg.type === 'audio_end') {
        deepgramService.closeSession(sessionId);
      }
    });

    ws.on('close', () => {
      deepgramService.closeSession(sessionId);
      wsManager.unregister(sessionId);
      console.log(`[ws] disconnected session=${sessionId}`);
    });

    ws.on('error', () => {
      deepgramService.closeSession(sessionId);
      wsManager.unregister(sessionId);
    });
  });

  return wss;
}

export default app;
