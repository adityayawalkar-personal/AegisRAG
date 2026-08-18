import { IncomingMessage, ServerResponse } from 'node:http';
import dotenv from 'dotenv';

dotenv.config();

export const API_AUTH_SECRET = process.env.API_AUTH_SECRET || 'aegisrag-secret-token-2026';

export function authenticateRequest(req: IncomingMessage): boolean {
  const apiKeyHeader = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];

  if (apiKeyHeader && apiKeyHeader === API_AUTH_SECRET) {
    return true;
  }

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token === API_AUTH_SECRET) {
      return true;
    }
  }

  return false;
}

export function sendUnauthorized(res: ServerResponse, reason: string = 'Unauthorized: Valid x-api-key or Bearer token required.'): void {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: reason }));
}
