import { IncomingMessage, ServerResponse } from 'node:http';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Retrieves the API authentication secret from the environment.
 * Strict Security Gate: Throws immediately if API_AUTH_SECRET is not configured.
 */
export function getAuthSecret(): string {
  const secret = process.env.API_AUTH_SECRET;
  if (!secret || secret.trim() === '') {
    throw new Error(
      'FATAL: API_AUTH_SECRET environment variable is missing or empty. A secure random token must be configured in .env before running the server.'
    );
  }
  return secret.trim();
}

export function authenticateRequest(req: IncomingMessage): boolean {
  const expectedSecret = getAuthSecret();
  const apiKeyHeader = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];

  if (apiKeyHeader && typeof apiKeyHeader === 'string' && apiKeyHeader === expectedSecret) {
    return true;
  }

  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token === expectedSecret) {
      return true;
    }
  }

  return false;
}

export function sendUnauthorized(res: ServerResponse, reason: string = 'Unauthorized: Valid x-api-key or Bearer token required.'): void {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: reason }));
}
