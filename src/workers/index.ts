import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, SearchRequest, IngestEmailRequest, ContactTimeline, AnalyticsSummary } from '../types';
import { hybridSearch } from '../lib/search';
import { ingestEmailsWithSource } from '../lib/ingest';
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
} from '../lib/auth';

type Variables = {
  userId: string;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

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

  const token = createToken(user.id);
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

  const token = createToken(user.id);
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
  `).bind(query + '*', userId).all();

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

  // Recent emails with this company
  const recentEmails = await c.env.DB.prepare(`
    SELECT e.id, e.subject, e.sent_at, ct.email as from_email
    FROM emails e
    JOIN contacts ct ON e.from_contact_id = ct.id
    WHERE ct.company_id = ? AND e.user_id = ?
    ORDER BY e.sent_at DESC
    LIMIT 20
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
  const sources = await listSources(userId, c.env);
  return c.json({ sources });
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

  const source = await createSource(body as any, userId, c.env);
  return c.json(source);
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
 * Upload a chunk of a large file
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
  const chunkIndex = parseInt(formData.get('chunkIndex') as string || '0');
  const totalChunks = parseInt(formData.get('totalChunks') as string || '1');

  console.log(`[UploadChunk] Chunk ${chunkIndex + 1}/${totalChunks}, size: ${file?.size || 0}`);

  if (!file) {
    return c.json({ error: 'No file chunk provided' }, 400);
  }

  const chunkContent = await file.text();

  // Store chunk in KV
  await c.env.CACHE.put(`upload:${sourceId}:chunk:${chunkIndex}`, chunkContent, { expirationTtl: 3600 });

  console.log(`[UploadChunk] Chunk ${chunkIndex + 1} stored`);

  return c.json({
    success: true,
    chunkIndex,
    totalChunks,
    chunkSize: chunkContent.length,
  });
});

/**
 * POST /api/sources/:id/process
 * Start processing uploaded chunks
 */
app.post('/api/sources/:id/process', async (c) => {
  console.log('[Process] Starting processing');
  const userId = c.get('userId');
  const sourceId = c.req.param('id');

  const source = await getSource(sourceId, userId, c.env);
  if (!source) {
    return c.json({ error: 'Source not found' }, 404);
  }

  const body = await c.req.json<{ totalChunks: number }>();
  const totalChunks = body.totalChunks || 1;

  console.log(`[Process] Processing ${totalChunks} chunks for source ${sourceId}`);

  // Mark source as processing
  await updateSourceStatus(sourceId, 'processing', userId, c.env, { emails_total: 0 });

  // Process in background
  c.executionCtx.waitUntil(
    processUploadedChunks(sourceId, userId, totalChunks, c.env)
  );

  return c.json({
    success: true,
    message: 'Processing started',
    totalChunks,
  });
});

/**
 * Process uploaded chunks in background
 */
async function processUploadedChunks(
  sourceId: string,
  userId: string,
  totalChunks: number,
  env: Env
): Promise<void> {
  try {
    console.log(`[ProcessChunks] Reassembling ${totalChunks} chunks`);

    // Reassemble file from chunks
    let fileContent = '';
    for (let i = 0; i < totalChunks; i++) {
      const chunk = await env.CACHE.get(`upload:${sourceId}:chunk:${i}`);
      if (chunk) {
        fileContent += chunk;
        await env.CACHE.delete(`upload:${sourceId}:chunk:${i}`);
      }
    }

    console.log(`[ProcessChunks] File reassembled, size: ${fileContent.length}`);

    // Parse mbox and process emails
    const emails = parseMboxContent(fileContent);
    console.log(`[ProcessChunks] Parsed ${emails.length} emails`);

    // Update total count
    await env.DB.prepare(
      'UPDATE email_sources SET emails_total = ? WHERE id = ? AND user_id = ?'
    ).bind(emails.length, sourceId, userId).run();

    // Process in batches
    const batchSize = 25;
    let processed = 0;
    let failed = 0;

    for (let i = 0; i < emails.length; i += batchSize) {
      const batch = emails.slice(i, i + batchSize);

      const result = await ingestEmailsWithSource(batch, sourceId, userId, env);
      processed += result.processed;
      failed += result.failed;

      // Update progress
      await incrementProcessed(sourceId, result.processed, result.failed, userId, env);

      if (i % 100 === 0) {
        console.log(`[ProcessChunks] Progress: ${processed}/${emails.length}`);
      }
    }

    console.log(`[ProcessChunks] Complete: ${processed} processed, ${failed} failed`);

    // Mark as completed
    await updateSourceStatus(sourceId, 'completed', userId, env);

  } catch (e) {
    console.error('[ProcessChunks] Error:', e);
    await updateSourceStatus(sourceId, 'failed', userId, env, {
      error_message: e instanceof Error ? e.message : 'Processing failed',
    });
  }
}

/**
 * POST /api/sources/:id/upload
 * Upload mbox file for server-side processing (for small files)
 * Returns immediately, processes in background
 */
app.post('/api/sources/:id/upload', async (c) => {
  console.log('[Upload] Received upload request');
  const userId = c.get('userId');
  const sourceId = c.req.param('id');
  console.log('[Upload] Source ID:', sourceId, 'User ID:', userId);

  const source = await getSource(sourceId, userId, c.env);
  if (!source) {
    console.log('[Upload] Source not found');
    return c.json({ error: 'Source not found' }, 404);
  }
  console.log('[Upload] Source found:', source.name);

  // Get file content
  console.log('[Upload] Parsing form data...');
  let formData;
  try {
    formData = await c.req.formData();
    console.log('[Upload] Form data parsed');
  } catch (e) {
    console.error('[Upload] Failed to parse form data:', e);
    return c.json({ error: 'Failed to parse form data: ' + (e instanceof Error ? e.message : 'Unknown error') }, 400);
  }

  const fileValue = formData.get('file') as unknown;
  const file = fileValue instanceof File ? fileValue : null;
  console.log('[Upload] File from form:', file ? `${file.name} (${file.size} bytes)` : String(fileValue));

  if (!file) {
    console.log('[Upload] No file in form data');
    return c.json({ error: 'No file provided' }, 400);
  }

  console.log('[Upload] Reading file content...');
  const fileContent = await file.text();
  const fileSize = fileContent.length;
  console.log('[Upload] File content read, size:', fileSize);

  // Store file in KV for processing (in chunks if large)
  const chunkSize = 1024 * 1024; // 1MB chunks (KV limit is 25MB per value)
  const totalChunks = Math.ceil(fileSize / chunkSize);
  console.log('[Upload] Storing', totalChunks, 'chunks in KV...');

  for (let i = 0; i < totalChunks; i++) {
    const chunk = fileContent.slice(i * chunkSize, (i + 1) * chunkSize);
    await c.env.CACHE.put(`upload:${sourceId}:${i}`, chunk, { expirationTtl: 3600 });
  }
  console.log('[Upload] Chunks stored');

  // Store metadata
  await c.env.CACHE.put(`upload:${sourceId}:meta`, JSON.stringify({
    totalChunks,
    fileSize,
    fileName: file.name,
    uploadedAt: new Date().toISOString(),
  }), { expirationTtl: 3600 });

  // Mark source as processing
  await updateSourceStatus(sourceId, 'processing', userId, c.env, { emails_total: 0 });
  console.log('[Upload] Source marked as processing');

  // Process in background using waitUntil
  console.log('[Upload] Starting background processing...');
  c.executionCtx.waitUntil(
    processUploadedFile(sourceId, userId, totalChunks, c.env)
  );

  console.log('[Upload] Returning success response');
  return c.json({
    success: true,
    message: 'Upload received, processing in background',
    fileSize,
    totalChunks,
  });
});

/**
 * Process uploaded mbox file in background
 */
async function processUploadedFile(
  sourceId: string,
  userId: string,
  totalChunks: number,
  env: Env
): Promise<void> {
  try {
    // Reassemble file from chunks
    let fileContent = '';
    for (let i = 0; i < totalChunks; i++) {
      const chunk = await env.CACHE.get(`upload:${sourceId}:${i}`);
      if (chunk) {
        fileContent += chunk;
        // Clean up chunk after reading
        await env.CACHE.delete(`upload:${sourceId}:${i}`);
      }
    }
    await env.CACHE.delete(`upload:${sourceId}:meta`);

    // Parse mbox and process emails
    const emails = parseMboxContent(fileContent);

    // Update total count
    await env.DB.prepare(
      'UPDATE email_sources SET emails_total = ? WHERE id = ? AND user_id = ?'
    ).bind(emails.length, sourceId, userId).run();

    // Process in batches
    const batchSize = 25;
    let processed = 0;
    let failed = 0;

    for (let i = 0; i < emails.length; i += batchSize) {
      const batch = emails.slice(i, i + batchSize);

      const result = await ingestEmailsWithSource(batch, sourceId, userId, env);
      processed += result.processed;
      failed += result.failed;

      // Update progress
      await incrementProcessed(sourceId, result.processed, result.failed, userId, env);
    }

    // Mark as completed
    await updateSourceStatus(sourceId, 'completed', userId, env);

  } catch (e) {
    console.error('Background processing failed:', e);
    await updateSourceStatus(sourceId, 'failed', userId, env, {
      error_message: e instanceof Error ? e.message : 'Processing failed',
    });
  }
}

/**
 * Parse mbox file content into email objects
 */
function parseMboxContent(content: string): IngestEmailRequest[] {
  const emails: IngestEmailRequest[] = [];
  const lines = content.split(/\r?\n/);

  let currentEmailLines: string[] = [];
  let inEmail = false;

  for (const line of lines) {
    // MBOX format: each email starts with "From " followed by email and timestamp
    if (line.startsWith('From ') && (line.includes('@') || line.includes(' at '))) {
      if (currentEmailLines.length > 0) {
        const parsed = parseEmailContent(currentEmailLines.join('\n'));
        if (parsed) emails.push(parsed);
      }
      currentEmailLines = [];
      inEmail = true;
    } else if (inEmail) {
      currentEmailLines.push(line);
    }
  }

  // Don't forget the last email
  if (currentEmailLines.length > 0) {
    const parsed = parseEmailContent(currentEmailLines.join('\n'));
    if (parsed) emails.push(parsed);
  }

  return emails;
}

/**
 * Parse a single email's raw content
 */
function parseEmailContent(raw: string): IngestEmailRequest | null {
  try {
    const headerEndIndex = raw.indexOf('\n\n');
    if (headerEndIndex === -1) return null;

    const headerSection = raw.substring(0, headerEndIndex);
    const bodySection = raw.substring(headerEndIndex + 2);

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
          if (part.includes('Content-Type: text/plain') || part.includes('content-type: text/plain')) {
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

// Export for Cloudflare Workers
export default app;
