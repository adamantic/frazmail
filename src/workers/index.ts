import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, SearchRequest, IngestEmailRequest, ContactTimeline, AnalyticsSummary, QueueMessage } from '../types';
import { hybridSearch } from '../lib/search';
import { ingestEmailsWithSource, ingestEmailsParallel } from '../lib/ingest';
import {
  createSource,
  getSource,
  listSources,
  updateSourceStatus,
  incrementProcessed,
  toggleSourceInSearch,
  deleteSource,
} from '../lib/sources';
import {
  createToken,
  verifySession,
  storeSession,
  invalidateSession,
  createUser,
  authenticateUser,
  hasUsers,
  emailExists,
  getUserById,
  findOrCreateOAuthUser,
} from '../lib/auth';

type Variables = {
  userId: string;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Global error handler
app.onError((err, c) => {
  console.error('[GlobalError]', err);
  return c.json({ error: err.message || 'Internal server error' }, 500);
});

// CORS for frontend
app.use('*', cors({
  origin: ['http://localhost:3000', 'https://email-intelligence.pages.dev', 'https://qmdemon.com', 'https://www.qmdemon.com', 'https://qmdemon.pages.dev'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposeHeaders: ['Content-Length', 'Content-Type'],
  maxAge: 86400,
  credentials: true,
}));

// Health check
app.get('/', (c) => c.json({ status: 'ok', service: 'email-intelligence' }));

// ═══════════════════════════════════════════════════════════════════
// AUTHENTICATION ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/auth/check
 * Check if any users exist (for first-time setup detection)
 */
app.get('/api/auth/check', async (c) => {
  const usersExist = await hasUsers(c.env);
  return c.json({ needs_setup: !usersExist });
});

/**
 * POST /api/auth/register
 * Register a new user
 */
app.post('/api/auth/register', async (c) => {
  const body = await c.req.json<{ email: string; password: string; name?: string }>();

  if (!body.email || !body.password) {
    return c.json({ error: 'Email and password are required' }, 400);
  }

  if (body.password.length < 6) {
    return c.json({ error: 'Password must be at least 6 characters' }, 400);
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(body.email)) {
    return c.json({ error: 'Invalid email format' }, 400);
  }

  // Check if email already exists
  if (await emailExists(body.email, c.env)) {
    return c.json({ error: 'Email already registered' }, 400);
  }

  const user = await createUser(body.email, body.password, body.name || null, c.env);

  const token = await createToken(user.id, c.env);
  await storeSession(token, user.id, c.env);

  return c.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
  });
});

/**
 * POST /api/auth/login
 * Login with email and password
 */
app.post('/api/auth/login', async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();

  if (!body.email || !body.password) {
    return c.json({ error: 'Email and password are required' }, 400);
  }

  const user = await authenticateUser(body.email, body.password, c.env);
  if (!user) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  const token = await createToken(user.id, c.env);
  await storeSession(token, user.id, c.env);

  return c.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
  });
});

/**
 * POST /api/auth/logout
 * Logout (invalidate session)
 */
app.post('/api/auth/logout', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    await invalidateSession(token, c.env);
  }
  return c.json({ success: true });
});

/**
 * GET /api/auth/verify
 * Verify current session is valid
 */
app.get('/api/auth/verify', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ valid: false }, 401);
  }

  const token = authHeader.slice(7);
  const userId = await verifySession(token, c.env);

  if (!userId) {
    return c.json({ valid: false }, 401);
  }

  const user = await getUserById(userId, c.env);
  return c.json({
    valid: true,
    user: user ? {
      id: user.id,
      email: user.email,
      name: user.name,
    } : null,
  });
});

/**
 * POST /api/auth/google/callback
 * Exchange Google OAuth authorization code for user session
 */
app.post('/api/auth/google/callback', async (c) => {
  const body = await c.req.json<{ code: string; redirect_uri: string }>();

  if (!body.code || !body.redirect_uri) {
    return c.json({ error: 'code and redirect_uri are required' }, 400);
  }

  // Exchange authorization code for access token
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: body.code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: body.redirect_uri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    console.error('[GoogleOAuth] Token exchange failed:', err);
    return c.json({ error: 'Failed to exchange authorization code' }, 400);
  }

  const tokenData = await tokenResponse.json<{ access_token: string }>();

  // Fetch user profile from Google
  const profileResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!profileResponse.ok) {
    return c.json({ error: 'Failed to fetch Google profile' }, 400);
  }

  const profile = await profileResponse.json<{ id: string; email: string; name: string }>();

  if (!profile.email) {
    return c.json({ error: 'Google account has no email address' }, 400);
  }

  // Find or create user
  const user = await findOrCreateOAuthUser(profile.id, profile.email, profile.name || null, c.env);

  const token = await createToken(user.id, c.env);
  await storeSession(token, user.id, c.env);

  return c.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
  });
});

// Auth middleware for protected routes
const requireAuth = async (c: any, next: any) => {
  const path = c.req.path;

  // Skip auth for auth endpoints and health check
  if (path.startsWith('/api/auth/') || path === '/') {
    return next();
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.slice(7);
  const userId = await verifySession(token, c.env);

  if (!userId) {
    return c.json({ error: 'Invalid or expired session' }, 401);
  }

  // Attach userId to context for use in handlers
  c.set('userId', userId);

  return next();
};

// Apply auth middleware to all API routes
app.use('/api/*', requireAuth);

// ═══════════════════════════════════════════════════════════════════
// SEARCH ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

/**
 * POST /api/search
 * Hybrid search using QMD-inspired pipeline
 */
app.post('/api/search', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<SearchRequest>();

  if (!body.query || body.query.trim().length === 0) {
    return c.json({ error: 'Query is required' }, 400);
  }

  const results = await hybridSearch(body, userId, c.env);
  return c.json(results);
});

/**
 * GET /api/search/quick
 * Quick FTS-only search for autocomplete
 */
app.get('/api/search/quick', async (c) => {
  const userId = c.get('userId');
  const query = c.req.query('q');
  if (!query) {
    return c.json({ results: [] });
  }

  const results = await c.env.DB.prepare(`
    SELECT
      e.id,
      e.subject,
      snippet(emails_fts, 1, '', '', '...', 20) as snippet,
      ct.email as from_email,
      e.sent_at
    FROM emails_fts
    JOIN emails e ON emails_fts.rowid = e.rowid
    JOIN contacts ct ON e.from_contact_id = ct.id
    WHERE emails_fts MATCH ?
      AND e.user_id = ?
    ORDER BY bm25(emails_fts)
    LIMIT 10
  `).bind(`"${query.replace(/"/g, '""')}"*`, userId).all();

  return c.json({ results: results.results || [] });
});

// ═══════════════════════════════════════════════════════════════════
// EMAIL ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/emails/:id
 * Get full email by ID
 */
app.get('/api/emails/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  const email = await c.env.DB.prepare(`
    SELECT
      e.*,
      ct.email as from_email,
      ct.name as from_name,
      co.name as from_company
    FROM emails e
    JOIN contacts ct ON e.from_contact_id = ct.id
    LEFT JOIN companies co ON ct.company_id = co.id
    WHERE e.id = ? AND e.user_id = ?
  `).bind(id, userId).first();

  if (!email) {
    return c.json({ error: 'Email not found' }, 404);
  }

  // Get recipients
  const recipients = await c.env.DB.prepare(`
    SELECT ct.email, ct.name, er.recipient_type
    FROM email_recipients er
    JOIN contacts ct ON er.contact_id = ct.id
    WHERE er.email_id = ?
  `).bind(id).all();

  // Get attachments
  const attachments = await c.env.DB.prepare(`
    SELECT id, filename, content_type, size
    FROM attachments
    WHERE email_id = ?
  `).bind(id).all();

  // Get thread if exists
  let thread = null;
  if (email.thread_id) {
    const threadEmails = await c.env.DB.prepare(`
      SELECT e.id, e.subject, e.sent_at, ct.email as from_email
      FROM emails e
      JOIN contacts ct ON e.from_contact_id = ct.id
      WHERE (e.thread_id = ? OR e.id = ?) AND e.user_id = ?
      ORDER BY e.sent_at ASC
    `).bind(email.thread_id, email.thread_id, userId).all();

    thread = threadEmails.results || [];
  }

  return c.json({
    ...email,
    recipients: recipients.results || [],
    attachments: attachments.results || [],
    thread,
  });
});

/**
 * GET /api/emails/:id/attachments/:attachmentId
 * Download attachment
 */
app.get('/api/emails/:id/attachments/:attachmentId', async (c) => {
  const userId = c.get('userId');
  const emailId = c.req.param('id');
  const attachmentId = c.req.param('attachmentId');

  // Verify email belongs to user
  const email = await c.env.DB.prepare(
    'SELECT 1 FROM emails WHERE id = ? AND user_id = ?'
  ).bind(emailId, userId).first();

  if (!email) {
    return c.json({ error: 'Email not found' }, 404);
  }

  const attachment = await c.env.DB.prepare(`
    SELECT * FROM attachments WHERE id = ? AND email_id = ?
  `).bind(attachmentId, emailId).first<{ r2_key: string; filename: string; content_type: string }>();

  if (!attachment) {
    return c.json({ error: 'Attachment not found' }, 404);
  }

  if (!c.env.ATTACHMENTS) {
    return c.json({ error: 'Attachments storage is not configured' }, 501);
  }

  const object = await c.env.ATTACHMENTS.get(attachment.r2_key);
  if (!object) {
    return c.json({ error: 'Attachment file not found' }, 404);
  }

  return new Response(object.body, {
    headers: {
      'Content-Type': attachment.content_type,
      'Content-Disposition': `attachment; filename="${attachment.filename}"`,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════
// CONTACT ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/contacts
 * List contacts with pagination
 */
app.get('/api/contacts', async (c) => {
  const userId = c.get('userId');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const search = c.req.query('q');

  let sql = `
    SELECT ct.*, co.name as company_name, co.domain as company_domain
    FROM contacts ct
    LEFT JOIN companies co ON ct.company_id = co.id
    WHERE ct.user_id = ?
  `;
  const params: any[] = [userId];

  if (search) {
    sql += ' AND (ct.email LIKE ? OR ct.name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  sql += ' ORDER BY ct.email_count DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const contacts = await c.env.DB.prepare(sql).bind(...params).all();
  const countResult = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM contacts WHERE user_id = ?'
  ).bind(userId).first<{ count: number }>();

  return c.json({
    contacts: contacts.results || [],
    total: countResult?.count || 0,
  });
});

/**
 * GET /api/contacts/:id
 * Get contact details with timeline
 */
app.get('/api/contacts/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  const contact = await c.env.DB.prepare(`
    SELECT ct.*, co.name as company_name, co.domain as company_domain
    FROM contacts ct
    LEFT JOIN companies co ON ct.company_id = co.id
    WHERE ct.id = ? AND ct.user_id = ?
  `).bind(id, userId).first();

  if (!contact) {
    return c.json({ error: 'Contact not found' }, 404);
  }

  // Get email timeline
  const emails = await c.env.DB.prepare(`
    SELECT
      e.id,
      e.subject,
      e.sent_at,
      CASE WHEN e.from_contact_id = ? THEN 'received' ELSE 'sent' END as direction,
      substr(e.body_text, 1, 200) as snippet
    FROM emails e
    WHERE e.user_id = ? AND (
      e.from_contact_id = ?
      OR e.id IN (SELECT email_id FROM email_recipients WHERE contact_id = ?)
    )
    ORDER BY e.sent_at DESC
    LIMIT 100
  `).bind(id, userId, id, id).all();

  // Calculate stats
  const stats = await c.env.DB.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN from_contact_id = ? THEN 1 ELSE 0 END) as received,
      MIN(sent_at) as first_contact,
      MAX(sent_at) as last_contact
    FROM emails
    WHERE user_id = ? AND (
      from_contact_id = ?
      OR id IN (SELECT email_id FROM email_recipients WHERE contact_id = ?)
    )
  `).bind(id, userId, id, id).first();

  const timeline: ContactTimeline = {
    contact: contact as any,
    company: contact.company_id ? {
      id: contact.company_id as string,
      domain: contact.company_domain as string,
      name: contact.company_name as string | null,
      total_emails: 0,
      first_contact: '',
      last_contact: '',
    } : null,
    emails: (emails.results || []) as any[],
    stats: {
      total_emails: (stats as any)?.total || 0,
      received: (stats as any)?.received || 0,
      sent: ((stats as any)?.total || 0) - ((stats as any)?.received || 0),
      first_contact: (stats as any)?.first_contact || '',
      last_contact: (stats as any)?.last_contact || '',
      avg_response_time_hours: null,
    },
  };

  return c.json(timeline);
});

// ═══════════════════════════════════════════════════════════════════
// COMPANY ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/companies
 * List companies with pagination
 */
app.get('/api/companies', async (c) => {
  const userId = c.get('userId');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const companies = await c.env.DB.prepare(`
    SELECT
      co.*,
      COUNT(DISTINCT ct.id) as contact_count
    FROM companies co
    LEFT JOIN contacts ct ON ct.company_id = co.id
    WHERE co.user_id = ?
    GROUP BY co.id
    ORDER BY co.total_emails DESC
    LIMIT ? OFFSET ?
  `).bind(userId, limit, offset).all();

  const countResult = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM companies WHERE user_id = ?'
  ).bind(userId).first<{ count: number }>();

  return c.json({
    companies: companies.results || [],
    total: countResult?.count || 0,
  });
});

/**
 * GET /api/companies/:id
 * Get company details with contacts
 */
app.get('/api/companies/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  const company = await c.env.DB.prepare(`
    SELECT * FROM companies WHERE id = ? AND user_id = ?
  `).bind(id, userId).first();

  if (!company) {
    return c.json({ error: 'Company not found' }, 404);
  }

  const contacts = await c.env.DB.prepare(`
    SELECT * FROM contacts WHERE company_id = ? AND user_id = ? ORDER BY email_count DESC
  `).bind(id, userId).all();

  // All emails with this company
  const recentEmails = await c.env.DB.prepare(`
    SELECT e.id, e.subject, e.sent_at, ct.email as from_email, ct.name as from_name
    FROM emails e
    JOIN contacts ct ON e.from_contact_id = ct.id
    WHERE ct.company_id = ? AND e.user_id = ?
    ORDER BY e.sent_at DESC
    LIMIT 500
  `).bind(id, userId).all();

  return c.json({
    company,
    contacts: contacts.results || [],
    recent_emails: recentEmails.results || [],
  });
});

// ═══════════════════════════════════════════════════════════════════
// ANALYTICS ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/analytics
 * Get analytics summary
 */
app.get('/api/analytics', async (c) => {
  const userId = c.get('userId');
  const days = parseInt(c.req.query('days') || '30');
  const dateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [totals, topContacts, topCompanies, volumeByDay] = await Promise.all([
    // Total counts
    c.env.DB.prepare(`
      SELECT
        COUNT(*) as total_emails,
        COUNT(DISTINCT from_contact_id) as unique_contacts
      FROM emails
      WHERE sent_at >= ? AND user_id = ?
    `).bind(dateFrom, userId).first(),

    // Top contacts
    c.env.DB.prepare(`
      SELECT ct.*, COUNT(*) as count
      FROM emails e
      JOIN contacts ct ON e.from_contact_id = ct.id
      WHERE e.sent_at >= ? AND e.user_id = ?
      GROUP BY ct.id
      ORDER BY count DESC
      LIMIT 10
    `).bind(dateFrom, userId).all(),

    // Top companies
    c.env.DB.prepare(`
      SELECT co.*, COUNT(*) as count
      FROM emails e
      JOIN contacts ct ON e.from_contact_id = ct.id
      JOIN companies co ON ct.company_id = co.id
      WHERE e.sent_at >= ? AND e.user_id = ?
      GROUP BY co.id
      ORDER BY count DESC
      LIMIT 10
    `).bind(dateFrom, userId).all(),

    // Volume by day
    c.env.DB.prepare(`
      SELECT date(sent_at) as date, COUNT(*) as count
      FROM emails
      WHERE sent_at >= ? AND user_id = ?
      GROUP BY date(sent_at)
      ORDER BY date ASC
    `).bind(dateFrom, userId).all(),
  ]);

  const analytics: AnalyticsSummary = {
    period: `${days} days`,
    total_emails: (totals as any)?.total_emails || 0,
    unique_contacts: (totals as any)?.unique_contacts || 0,
    unique_companies: (topCompanies.results || []).length,
    top_contacts: (topContacts.results || []).map((r: any) => ({
      contact: r,
      count: r.count,
    })),
    top_companies: (topCompanies.results || []).map((r: any) => ({
      company: r,
      count: r.count,
    })),
    volume_by_day: (volumeByDay.results || []) as any[],
    volume_by_hour: [],
  };

  return c.json(analytics);
});

// ═══════════════════════════════════════════════════════════════════
// SOURCE MANAGEMENT ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/sources
 * List all email sources
 */
app.get('/api/sources', async (c) => {
  const userId = c.get('userId');
  try {
    const sources = await listSources(userId, c.env);
    return c.json({ sources });
  } catch (e) {
    console.error('[ListSources] Error:', e);
    return c.json({ error: e instanceof Error ? e.message : 'Failed to list sources' }, 500);
  }
});

/**
 * POST /api/sources
 * Create a new email source
 */
app.post('/api/sources', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ name: string; source_type: string; email_address?: string; file_name?: string }>();

  if (!body.name || !body.source_type) {
    return c.json({ error: 'name and source_type are required' }, 400);
  }

  try {
    const source = await createSource(body as any, userId, c.env);
    return c.json(source);
  } catch (e) {
    console.error('[CreateSource] Error:', e);
    return c.json({ error: e instanceof Error ? e.message : 'Failed to create source' }, 500);
  }
});

/**
 * GET /api/sources/:id
 * Get source details
 */
app.get('/api/sources/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const source = await getSource(id, userId, c.env);

  if (!source) {
    return c.json({ error: 'Source not found' }, 404);
  }

  return c.json(source);
});

/**
 * PATCH /api/sources/:id
 * Update source (toggle search inclusion)
 */
app.patch('/api/sources/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json<{ is_included_in_search?: boolean }>();

  const source = await getSource(id, userId, c.env);
  if (!source) {
    return c.json({ error: 'Source not found' }, 404);
  }

  if (body.is_included_in_search !== undefined) {
    await toggleSourceInSearch(id, body.is_included_in_search, userId, c.env);
  }

  const updated = await getSource(id, userId, c.env);
  return c.json(updated);
});

/**
 * DELETE /api/sources/:id
 * Delete a source and all its emails
 */
app.delete('/api/sources/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  const source = await getSource(id, userId, c.env);
  if (!source) {
    return c.json({ error: 'Source not found' }, 404);
  }

  await deleteSource(id, userId, c.env);
  return c.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════
// INGESTION ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

/**
 * POST /api/ingest
 * Ingest batch of emails
 */
app.post('/api/ingest', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ emails: IngestEmailRequest[]; source_id?: string }>();

  if (!body.emails || !Array.isArray(body.emails)) {
    return c.json({ error: 'emails array is required' }, 400);
  }

  // Verify source belongs to user if provided
  if (body.source_id) {
    const source = await getSource(body.source_id, userId, c.env);
    if (!source) {
      return c.json({ error: 'Source not found' }, 404);
    }
  }

  const result = await ingestEmailsWithSource(body.emails, body.source_id || null, userId, c.env);

  // Update source progress if source_id provided
  if (body.source_id) {
    await incrementProcessed(body.source_id, result.processed, result.failed, userId, c.env);
  }

  return c.json(result);
});

/**
 * POST /api/sources/:id/start
 * Mark source as processing
 */
app.post('/api/sources/:id/start', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json<{ emails_total?: number }>();

  const source = await getSource(id, userId, c.env);
  if (!source) {
    return c.json({ error: 'Source not found' }, 404);
  }

  await updateSourceStatus(id, 'processing', userId, c.env, {
    emails_total: body.emails_total || 0,
  });

  return c.json({ success: true });
});

/**
 * POST /api/sources/:id/complete
 * Mark source as completed or failed
 */
app.post('/api/sources/:id/complete', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json<{ status: 'completed' | 'failed'; error_message?: string }>();

  const source = await getSource(id, userId, c.env);
  if (!source) {
    return c.json({ error: 'Source not found' }, 404);
  }

  await updateSourceStatus(id, body.status, userId, c.env, {
    error_message: body.error_message,
  });

  return c.json({ success: true });
});

/**
 * POST /api/sources/:id/upload-chunk
 * Upload a chunk of a large file to R2 (binary-safe, no TTL expiry)
 */
app.post('/api/sources/:id/upload-chunk', async (c) => {
  console.log('[UploadChunk] Received chunk upload request');
  const userId = c.get('userId');
  const sourceId = c.req.param('id');

  const source = await getSource(sourceId, userId, c.env);
  if (!source) {
    return c.json({ error: 'Source not found' }, 404);
  }

  let formData;
  try {
    formData = await c.req.formData();
  } catch (e) {
    console.error('[UploadChunk] Failed to parse form data:', e);
    return c.json({ error: 'Failed to parse form data' }, 400);
  }

  const fileValue = formData.get('file') as unknown;
  const file = fileValue instanceof File ? fileValue : null;
  const chunkIndexRaw = formData.get('chunkIndex');
  const totalChunksRaw = formData.get('totalChunks');
  const chunkIndex = Number.parseInt(typeof chunkIndexRaw === 'string' ? chunkIndexRaw : '0', 10);
  const totalChunks = Number.parseInt(typeof totalChunksRaw === 'string' ? totalChunksRaw : '1', 10);

  console.log(`[UploadChunk] Chunk ${chunkIndex + 1}/${totalChunks}, size: ${file?.size || 0}`);

  if (!file) {
    return c.json({ error: 'No file chunk provided' }, 400);
  }

  if (!Number.isFinite(chunkIndex) || !Number.isFinite(totalChunks) || totalChunks <= 0) {
    return c.json({ error: 'Invalid chunkIndex/totalChunks' }, 400);
  }

  if (chunkIndex < 0 || chunkIndex >= totalChunks) {
    return c.json({ error: 'chunkIndex out of range' }, 400);
  }

  // Use arrayBuffer() instead of text() to preserve binary content
  const chunkData = await file.arrayBuffer();

  // Store chunk in R2 (no TTL expiry, supports up to 5GB per object)
  const paddedIndex = String(chunkIndex).padStart(6, '0');
  const r2Key = `uploads/${sourceId}/chunk-${paddedIndex}`;
  await c.env.ATTACHMENTS.put(r2Key, chunkData);

  console.log(`[UploadChunk] Chunk ${chunkIndex + 1} stored in R2 (${chunkData.byteLength} bytes)`);

  return c.json({
    success: true,
    chunkIndex,
    totalChunks,
    chunkSize: chunkData.byteLength,
  });
});

/**
 * POST /api/sources/:id/process
 * Start processing uploaded chunks via queue
 */
app.post('/api/sources/:id/process', async (c) => {
  console.log('[Process] Starting processing');
  const userId = c.get('userId');
  const sourceId = c.req.param('id');

  const source = await getSource(sourceId, userId, c.env);
  if (!source) {
    return c.json({ error: 'Source not found' }, 404);
  }

  const body = await c.req.json<{ totalChunks?: number }>();
  const totalChunks = body.totalChunks ?? 1;

  if (typeof totalChunks !== 'number' || !Number.isFinite(totalChunks) || !Number.isInteger(totalChunks) || totalChunks <= 0) {
    return c.json({ error: 'Invalid totalChunks' }, 400);
  }

  console.log(`[Process] Enqueuing chunk 0/${totalChunks} for source ${sourceId} (chunks processed sequentially via chaining)`);

  // Mark source as processing
  await updateSourceStatus(sourceId, 'processing', userId, c.env, { emails_total: 0 });

  // Only enqueue the first chunk — each chunk will enqueue the next one
  // after it finishes, ensuring sequential processing required by the
  // carryover mechanism (mbox emails can span chunk boundaries).
  await c.env.EMAIL_QUEUE.sendBatch([{
    body: {
      type: 'process-chunk',
      sourceId,
      userId,
      chunkIndex: 0,
      totalChunks,
    },
  }]);

  return c.json({
    success: true,
    message: 'Processing enqueued',
    totalChunks,
  });
});

/**
 * POST /api/sources/:id/upload
 * Upload mbox file for server-side processing (for small files)
 * Stores in R2 as a single chunk and enqueues for processing
 */
app.post('/api/sources/:id/upload', async (c) => {
  console.log('[Upload] Received upload request');
  const userId = c.get('userId');
  const sourceId = c.req.param('id');

  const source = await getSource(sourceId, userId, c.env);
  if (!source) {
    return c.json({ error: 'Source not found' }, 404);
  }

  let formData;
  try {
    formData = await c.req.formData();
  } catch (e) {
    console.error('[Upload] Failed to parse form data:', e);
    return c.json({ error: 'Failed to parse form data: ' + (e instanceof Error ? e.message : 'Unknown error') }, 400);
  }

  const fileValue = formData.get('file') as unknown;
  const file = fileValue instanceof File ? fileValue : null;

  if (!file) {
    return c.json({ error: 'No file provided' }, 400);
  }

  // Use arrayBuffer() for binary-safe storage
  const fileData = await file.arrayBuffer();
  const fileSize = fileData.byteLength;

  // Store as single chunk in R2
  const r2Key = `uploads/${sourceId}/chunk-000000`;
  await c.env.ATTACHMENTS.put(r2Key, fileData);
  const totalChunks = 1;

  // Mark source as processing
  await updateSourceStatus(sourceId, 'processing', userId, c.env, { emails_total: 0 });

  // Enqueue chunk for processing via queue
  await c.env.EMAIL_QUEUE.sendBatch([{
    body: {
      type: 'process-chunk',
      sourceId,
      userId,
      chunkIndex: 0,
      totalChunks,
    } satisfies QueueMessage,
  }]);

  console.log(`[Upload] Stored ${fileSize} bytes in R2, enqueued for processing`);
  return c.json({
    success: true,
    message: 'Upload received, processing enqueued',
    fileSize,
    totalChunks,
  });
});

/**
 * Process a single uploaded chunk from R2.
 * Reads carryover from the previous chunk (stored in KV), parses emails,
 * enqueues process-email messages, and stores any trailing partial email
 * as carryover for the next chunk.
 */
async function processChunk(
  sourceId: string,
  userId: string,
  chunkIndex: number,
  totalChunks: number,
  env: Env
): Promise<void> {
  const paddedIndex = String(chunkIndex).padStart(6, '0');
  const r2Key = `uploads/${sourceId}/chunk-${paddedIndex}`;

  const r2Obj = await env.ATTACHMENTS.get(r2Key);
  if (!r2Obj) {
    throw new Error(`Missing upload chunk ${chunkIndex}/${totalChunks} at ${r2Key}`);
  }

  // Read chunk as text (mbox is text-based)
  const chunkText = await r2Obj.text();

  // Get carryover from previous chunk (if any)
  const carryoverKey = `carryover:${sourceId}`;
  const carryover = (await env.CACHE.get(carryoverKey)) || '';

  const content = carryover + chunkText;
  const isLastChunk = chunkIndex === totalChunks - 1;

  // Find all "From " boundaries
  const fromPattern = /^From /gm;
  const matches: number[] = [];
  let match;
  while ((match = fromPattern.exec(content)) !== null) {
    const lineEnd = content.indexOf('\n', match.index);
    const line = content.substring(match.index, lineEnd === -1 ? undefined : lineEnd);
    if (line.includes('@') || line.includes(' at ')) {
      matches.push(match.index);
    }
  }

  let emailCount = 0;
  const MAX_QUEUE_BODY_SIZE = 200 * 1024; // 200KB safety margin for 256KB queue limit
  const queueBatchSize = 25;
  let queueBatch: { body: QueueMessage }[] = [];

  const enqueueEmail = async (parsed: IngestEmailRequest) => {
    const bodySize = new TextEncoder().encode(JSON.stringify(parsed)).byteLength;

    if (bodySize > MAX_QUEUE_BODY_SIZE) {
      // Store oversized email body in R2 and send a reference
      const bodyR2Key = `uploads/${sourceId}/email-body-${crypto.randomUUID()}`;
      await env.ATTACHMENTS.put(bodyR2Key, parsed.body_text);

      queueBatch.push({
        body: {
          type: 'process-email-ref',
          sourceId,
          userId,
          r2Key: bodyR2Key,
          subject: parsed.subject,
          message_id: parsed.message_id,
          from_email: parsed.from_email,
          from_name: parsed.from_name,
          to: parsed.to,
          cc: parsed.cc,
          sent_at: parsed.sent_at,
          in_reply_to: parsed.in_reply_to,
          references: parsed.references,
        },
      });
    } else {
      queueBatch.push({
        body: {
          type: 'process-email',
          sourceId,
          userId,
          email: parsed,
        },
      });
    }

    emailCount++;

    if (queueBatch.length >= queueBatchSize) {
      await env.EMAIL_QUEUE.sendBatch(queueBatch);
      queueBatch = [];
    }
  };

  if (matches.length === 0) {
    // No boundaries - carry everything over (or discard if last chunk)
    console.log(`[ProcessChunk] Chunk ${chunkIndex + 1}/${totalChunks} for source ${sourceId}: no "From " boundaries found (content length: ${content.length}, first 200 chars: ${JSON.stringify(content.substring(0, 200))})`);
    if (!isLastChunk) {
      await env.CACHE.put(carryoverKey, content, { expirationTtl: 7200 });
    }
  } else {
    const lastMatchIndex = isLastChunk ? matches.length : matches.length - 1;

    let parseFailures = 0;
    for (let i = 0; i < lastMatchIndex; i++) {
      const start = matches[i];
      const end = i + 1 < matches.length ? matches[i + 1] : content.length;
      const emailRaw = content.substring(start, end);
      const firstNewline = emailRaw.indexOf('\n');
      if (firstNewline !== -1) {
        const parsed = parseEmailContent(emailRaw.substring(firstNewline + 1));
        if (parsed) {
          await enqueueEmail(parsed);
        } else {
          parseFailures++;
          if (parseFailures <= 3) {
            const snippet = emailRaw.substring(firstNewline + 1, firstNewline + 300);
            console.log(`[ProcessChunk] Parse returned null for email ${i + 1}, snippet: ${JSON.stringify(snippet)}`);
          }
        }
      }
    }
    if (parseFailures > 0) {
      console.log(`[ProcessChunk] Chunk ${chunkIndex + 1}/${totalChunks}: ${parseFailures}/${lastMatchIndex} emails failed to parse`);
    }

    if (isLastChunk && matches.length > 0) {
      // Process the very last email
      const lastStart = matches[matches.length - 1];
      const emailRaw = content.substring(lastStart);
      const firstNewline = emailRaw.indexOf('\n');
      if (firstNewline !== -1) {
        const parsed = parseEmailContent(emailRaw.substring(firstNewline + 1));
        if (parsed) await enqueueEmail(parsed);
      }
    }

    if (!isLastChunk) {
      // Carry over content from the last "From " boundary
      await env.CACHE.put(carryoverKey, content.substring(matches[matches.length - 1]), { expirationTtl: 7200 });
    }
  }

  // Flush remaining queue batch
  if (queueBatch.length > 0) {
    await env.EMAIL_QUEUE.sendBatch(queueBatch);
  }

  // Atomically increment emails_total
  await env.DB.prepare(
    'UPDATE email_sources SET emails_total = emails_total + ? WHERE id = ? AND user_id = ?'
  ).bind(emailCount, sourceId, userId).run();

  // Chain: enqueue the next chunk BEFORE deleting the current one from R2,
  // so that if sendBatch fails the retry can still read this chunk.
  if (isLastChunk) {
    await env.CACHE.delete(carryoverKey);

    // Check if any emails were found across all chunks
    const source = await env.DB.prepare(
      'SELECT emails_total FROM email_sources WHERE id = ? AND user_id = ?'
    ).bind(sourceId, userId).first<{ emails_total: number }>();

    if (source && source.emails_total === 0) {
      await env.DB.prepare(
        `UPDATE email_sources SET status = 'failed', error_message = 'No emails found in file. Check the file is a valid mbox (Gmail Takeout) export.', completed_at = datetime('now') WHERE id = ? AND user_id = ?`
      ).bind(sourceId, userId).run();
      console.log(`[ProcessChunk] Source ${sourceId}: no emails found in any chunk, marked as failed`);
    }
  } else {
    // Enqueue the next chunk to ensure sequential processing
    // (carryover mechanism requires chunks to be processed in order)
    await env.EMAIL_QUEUE.sendBatch([{
      body: {
        type: 'process-chunk',
        sourceId,
        userId,
        chunkIndex: chunkIndex + 1,
        totalChunks,
      },
    }]);
  }

  // Clean up: delete chunk from R2 only after next chunk is enqueued
  await env.ATTACHMENTS.delete(r2Key);

  console.log(`[ProcessChunk] Chunk ${chunkIndex + 1}/${totalChunks} for source ${sourceId}: found ${matches.length} boundaries, enqueued ${emailCount} emails`);
}

/**
 * Parse a single email's raw content
 */
function parseEmailContent(raw: string): IngestEmailRequest | null {
  try {
    // Normalize CRLF to LF (Gmail Takeout exports use CRLF)
    const normalized = raw.replace(/\r\n/g, '\n');

    const headerEndIndex = normalized.indexOf('\n\n');
    if (headerEndIndex === -1) return null;

    const headerSection = normalized.substring(0, headerEndIndex);
    const bodySection = normalized.substring(headerEndIndex + 2);

    const headers = parseEmailHeaders(headerSection);

    const fromHeader = headers['from'] || '';
    const fromMatch = fromHeader.match(/<([^>]+)>/) || fromHeader.match(/([\w.-]+@[\w.-]+)/);
    const fromEmail = fromMatch ? fromMatch[1].toLowerCase() : fromHeader.toLowerCase();
    const fromName = fromHeader.replace(/<[^>]+>/, '').trim().replace(/^"|"$/g, '');

    const toHeader = headers['to'] || '';
    const toRecipients = parseEmailRecipients(toHeader);

    const ccHeader = headers['cc'] || '';
    const ccRecipients = parseEmailRecipients(ccHeader);

    const messageId = (headers['message-id'] || `generated-${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/^<|>$/g, '');

    const subject = decodeEmailHeader(headers['subject'] || '(No Subject)');

    const dateHeader = headers['date'] || '';
    let sentAt = new Date().toISOString();
    if (dateHeader) {
      try {
        const parsed = new Date(dateHeader);
        if (!isNaN(parsed.getTime())) {
          sentAt = parsed.toISOString();
        }
      } catch {}
    }

    // Parse body
    let bodyText = bodySection;
    const contentType = headers['content-type'] || '';

    if (contentType.includes('multipart')) {
      const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/);
      if (boundaryMatch) {
        const boundary = boundaryMatch[1];
        const parts = bodySection.split('--' + boundary);
        for (const part of parts) {
          if (part.toLowerCase().includes('content-type: text/plain')) {
            const partHeaderEnd = part.indexOf('\n\n');
            if (partHeaderEnd !== -1) {
              bodyText = part.substring(partHeaderEnd + 2).trim();
              break;
            }
          }
        }
      }
    }

    // Decode if needed
    if (headers['content-transfer-encoding']?.toLowerCase() === 'quoted-printable') {
      bodyText = decodeQuotedPrintableContent(bodyText);
    } else if (headers['content-transfer-encoding']?.toLowerCase() === 'base64') {
      try {
        bodyText = atob(bodyText.replace(/\s/g, ''));
      } catch {}
    }

    if (!fromEmail || !fromEmail.includes('@')) return null;

    return {
      message_id: messageId,
      subject,
      body_text: bodyText.slice(0, 50000),
      sent_at: sentAt,
      from_email: fromEmail,
      from_name: fromName || undefined,
      to: toRecipients,
      cc: ccRecipients,
      in_reply_to: headers['in-reply-to']?.replace(/^<|>$/g, ''),
      references: (headers['references'] || '').split(/\s+/).filter(Boolean).map(r => r.replace(/^<|>$/g, '')),
    };
  } catch (e) {
    console.error('Failed to parse email:', e);
    return null;
  }
}

function parseEmailHeaders(headerSection: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = headerSection.split(/\r?\n/);
  let currentKey = '';
  let currentValue = '';

  for (const line of lines) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      currentValue += ' ' + line.trim();
    } else {
      if (currentKey) {
        headers[currentKey.toLowerCase()] = currentValue;
      }
      const colonIndex = line.indexOf(':');
      if (colonIndex !== -1) {
        currentKey = line.substring(0, colonIndex);
        currentValue = line.substring(colonIndex + 1).trim();
      }
    }
  }
  if (currentKey) {
    headers[currentKey.toLowerCase()] = currentValue;
  }

  return headers;
}

function parseEmailRecipients(header: string): { email: string; name?: string }[] {
  if (!header) return [];

  const recipients: { email: string; name?: string }[] = [];
  const parts = header.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);

  for (const part of parts) {
    const trimmed = part.trim();
    const emailMatch = trimmed.match(/<([^>]+)>/) || trimmed.match(/([\w.-]+@[\w.-]+)/);
    if (emailMatch) {
      const email = emailMatch[1].toLowerCase();
      const name = trimmed.replace(/<[^>]+>/, '').trim().replace(/^"|"$/g, '');
      recipients.push({ email, name: name || undefined });
    }
  }

  return recipients;
}

function decodeEmailHeader(value: string): string {
  return value.replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (match, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return atob(text);
      } else {
        return decodeQuotedPrintableContent(text.replace(/_/g, ' '));
      }
    } catch {
      return text;
    }
  });
}

function decodeQuotedPrintableContent(text: string): string {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Export for Cloudflare Workers with queue consumer
export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    console.log(`[QueueConsumer] Processing batch of ${batch.messages.length} messages`);

    // Separate message types
    const chunkMessages: Message<Extract<QueueMessage, { type: 'process-chunk' }>>[] = [];
    const emailMessages: Message<QueueMessage>[] = [];

    for (const msg of batch.messages) {
      if (msg.body.type === 'process-chunk') {
        chunkMessages.push(msg as any);
      } else {
        emailMessages.push(msg);
      }
    }

    // Process chunk messages (parse mbox chunks into emails)
    for (const msg of chunkMessages) {
      try {
        await processChunk(
          msg.body.sourceId,
          msg.body.userId,
          msg.body.chunkIndex,
          msg.body.totalChunks,
          env
        );
        msg.ack();
      } catch (e) {
        console.error(`[QueueConsumer] Chunk processing failed:`, e);
        msg.retry();
      }
    }

    // Process email messages: group by sourceId for efficient progress updates
    if (emailMessages.length > 0) {
      const bySource = new Map<string, { userId: string; emails: IngestEmailRequest[] }>();

      for (const msg of emailMessages) {
        const body = msg.body;
        let email: IngestEmailRequest;

        if (body.type === 'process-email') {
          email = body.email;
        } else if (body.type === 'process-email-ref') {
          // Fetch oversized body from R2
          const r2Obj = await env.ATTACHMENTS.get(body.r2Key);
          const bodyText = r2Obj ? await r2Obj.text() : '';
          // Clean up the R2 object
          await env.ATTACHMENTS.delete(body.r2Key);

          email = {
            message_id: body.message_id,
            subject: body.subject,
            body_text: bodyText,
            from_email: body.from_email,
            from_name: body.from_name,
            to: body.to,
            cc: body.cc,
            sent_at: body.sent_at,
            in_reply_to: body.in_reply_to,
            references: body.references,
          };
        } else {
          msg.ack();
          continue;
        }

        const key = body.sourceId;
        if (!bySource.has(key)) {
          bySource.set(key, { userId: body.userId, emails: [] });
        }
        bySource.get(key)!.emails.push(email);
      }

      await Promise.all(
        Array.from(bySource.entries()).map(async ([sourceId, { userId, emails }]) => {
          try {
            const result = await ingestEmailsParallel(emails, sourceId, userId, env);
            await incrementProcessed(sourceId, result.processed, result.failed, userId, env);

            // Atomic completion check: only mark completed if the UPDATE actually changes a row
            const completionResult = await env.DB.prepare(`
              UPDATE email_sources
              SET status = 'completed', completed_at = datetime('now')
              WHERE id = ? AND user_id = ? AND status = 'processing'
                AND emails_total > 0
                AND emails_processed + emails_failed >= emails_total
            `).bind(sourceId, userId).run();

            if (completionResult.meta.changes > 0) {
              console.log(`[QueueConsumer] Source ${sourceId} completed`);
            }
          } catch (e) {
            console.error(`[QueueConsumer] Error processing source ${sourceId}:`, e);
          }
        })
      );

      // Ack all email messages
      for (const msg of emailMessages) {
        msg.ack();
      }
    }

    console.log(`[QueueConsumer] Batch processed successfully`);
  },
};
