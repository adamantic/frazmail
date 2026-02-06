import type { Context, Next } from 'hono';
import type { Env, User } from '../types';

const TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

interface TokenPayload {
  user_id: string;
  exp: number;
  iat: number;
}

/**
 * Import HMAC key from AUTH_SECRET for token signing
 */
async function getSigningKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/**
 * Convert ArrayBuffer to hex string
 */
function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Hash password using Web Crypto API (PBKDF2)
 */
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const hash = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  // Combine salt and hash for storage
  const combined = new Uint8Array(salt.length + new Uint8Array(hash).length);
  combined.set(salt);
  combined.set(new Uint8Array(hash), salt.length);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Verify password against stored hash
 */
async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const combined = Uint8Array.from(atob(storedHash), c => c.charCodeAt(0));

    // Extract salt (first 16 bytes)
    const salt = combined.slice(0, 16);
    const storedHashBytes = combined.slice(16);

    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveBits']
    );

    const hash = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-256',
      },
      keyMaterial,
      256
    );

    // Constant-time comparison to prevent timing attacks
    const hashBytes = new Uint8Array(hash);
    if (hashBytes.length !== storedHashBytes.length) return false;

    let diff = 0;
    for (let i = 0; i < hashBytes.length; i++) {
      diff |= hashBytes[i] ^ storedHashBytes[i];
    }

    return diff === 0;
  } catch {
    return false;
  }
}

/**
 * Create HMAC-signed auth token with user_id
 */
export async function createToken(userId: string, env: Env): Promise<string> {
  const payload: TokenPayload = {
    user_id: userId,
    iat: Date.now(),
    exp: Date.now() + TOKEN_EXPIRY,
  };
  const payloadB64 = btoa(JSON.stringify(payload));
  const key = await getSigningKey(env.AUTH_SECRET);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${bufToHex(signature)}`;
}

/**
 * Verify token signature and expiration
 */
export async function verifyToken(token: string, env: Env): Promise<boolean> {
  try {
    const dotIndex = token.indexOf('.');
    if (dotIndex === -1) return false;

    const payloadB64 = token.substring(0, dotIndex);
    const signatureHex = token.substring(dotIndex + 1);

    const key = await getSigningKey(env.AUTH_SECRET);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      hexToBuf(signatureHex),
      new TextEncoder().encode(payloadB64)
    );
    if (!valid) return false;

    const payload: TokenPayload = JSON.parse(atob(payloadB64));
    return payload.exp > Date.now();
  } catch {
    return false;
  }
}

/**
 * Extract user_id from a verified token
 */
export async function getUserIdFromToken(token: string, env: Env): Promise<string | null> {
  try {
    const isValid = await verifyToken(token, env);
    if (!isValid) return null;

    const dotIndex = token.indexOf('.');
    const payloadB64 = token.substring(0, dotIndex);
    const payload: TokenPayload = JSON.parse(atob(payloadB64));
    return payload.user_id;
  } catch {
    return null;
  }
}

/**
 * Create a new user
 */
export async function createUser(
  email: string,
  password: string,
  name: string | null,
  env: Env
): Promise<User> {
  const id = crypto.randomUUID();
  const normalizedEmail = email.toLowerCase().trim();
  const passwordHash = await hashPassword(password);

  await env.DB.prepare(`
    INSERT INTO users (id, email, password_hash, name)
    VALUES (?, ?, ?, ?)
  `).bind(id, normalizedEmail, passwordHash, name).run();

  return {
    id,
    email: normalizedEmail,
    name,
    created_at: new Date().toISOString(),
  };
}

/**
 * Authenticate user with email and password
 */
export async function authenticateUser(
  email: string,
  password: string,
  env: Env
): Promise<User | null> {
  const normalizedEmail = email.toLowerCase().trim();

  const user = await env.DB.prepare(`
    SELECT id, email, password_hash, name, created_at
    FROM users WHERE email = ?
  `).bind(normalizedEmail).first<{
    id: string;
    email: string;
    password_hash: string;
    name: string | null;
    created_at: string;
  }>();

  if (!user) return null;

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return null;

  // Update last login
  await env.DB.prepare(
    'UPDATE users SET last_login = datetime("now") WHERE id = ?'
  ).bind(user.id).run();

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    created_at: user.created_at,
  };
}

/**
 * Get user by ID
 */
export async function getUserById(id: string, env: Env): Promise<User | null> {
  const user = await env.DB.prepare(`
    SELECT id, email, name, created_at FROM users WHERE id = ?
  `).bind(id).first<User>();

  return user || null;
}

/**
 * Check if any users exist (for first-time setup)
 */
export async function hasUsers(env: Env): Promise<boolean> {
  const result = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM users'
  ).first<{ count: number }>();

  return (result?.count || 0) > 0;
}

/**
 * Find or create a user via OAuth (Google).
 * - If oauth_provider + oauth_id match → return existing user
 * - If email matches an existing user → link OAuth columns and return user
 * - Otherwise → create new user with password_hash = NULL
 */
export async function findOrCreateOAuthUser(
  googleId: string,
  email: string,
  name: string | null,
  env: Env
): Promise<User> {
  const normalizedEmail = email.toLowerCase().trim();

  // 1. Check by OAuth identity
  const existing = await env.DB.prepare(`
    SELECT id, email, name, created_at FROM users
    WHERE oauth_provider = 'google' AND oauth_id = ?
  `).bind(googleId).first<User>();

  if (existing) return existing;

  // 2. Check by email — link OAuth to existing account
  const byEmail = await env.DB.prepare(`
    SELECT id, email, name, created_at FROM users WHERE email = ?
  `).bind(normalizedEmail).first<User>();

  if (byEmail) {
    await env.DB.prepare(`
      UPDATE users SET oauth_provider = 'google', oauth_id = ? WHERE id = ?
    `).bind(googleId, byEmail.id).run();
    return byEmail;
  }

  // 3. Create new OAuth-only user (no password)
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO users (id, email, name, password_hash, oauth_provider, oauth_id)
    VALUES (?, ?, ?, NULL, 'google', ?)
  `).bind(id, normalizedEmail, name, googleId).run();

  return { id, email: normalizedEmail, name, created_at: new Date().toISOString() };
}

/**
 * Check if email is already registered
 */
export async function emailExists(email: string, env: Env): Promise<boolean> {
  const normalizedEmail = email.toLowerCase().trim();
  const result = await env.DB.prepare(
    'SELECT 1 FROM users WHERE email = ?'
  ).bind(normalizedEmail).first();

  return !!result;
}

/**
 * Store session token with user_id
 */
export async function storeSession(token: string, userId: string, env: Env): Promise<void> {
  if (env.SESSIONS) {
    await env.SESSIONS.put(`session:${token}`, userId, {
      expirationTtl: TOKEN_EXPIRY / 1000,
    });
  }
}

/**
 * Verify session and get user_id
 */
export async function verifySession(token: string, env: Env): Promise<string | null> {
  if (!(await verifyToken(token, env))) return null;

  const userId = await getUserIdFromToken(token, env);
  if (!userId) return null;

  if (env.SESSIONS) {
    const storedUserId = await env.SESSIONS.get(`session:${token}`);
    if (storedUserId !== userId) return null;
  }

  return userId;
}

/**
 * Invalidate session (logout)
 */
export async function invalidateSession(token: string, env: Env): Promise<void> {
  if (env.SESSIONS) {
    await env.SESSIONS.delete(`session:${token}`);
  }
}
