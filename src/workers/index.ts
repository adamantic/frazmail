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
  allowHeaders: ['Content-Type', 'Authorization'],
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

// Export for Cloudflare Workers
export default app;
