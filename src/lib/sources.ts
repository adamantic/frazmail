import type { Env } from '../types';

export interface EmailSource {
  id: string;
  name: string;
  email_address: string | null;
  source_type: 'gmail' | 'outlook' | 'mbox' | 'pst' | 'api';
  file_name: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  emails_total: number;
  emails_processed: number;
  emails_failed: number;
  is_included_in_search: boolean;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  user_id: string;
}

export interface CreateSourceRequest {
  name: string;
  email_address?: string;
  source_type: EmailSource['source_type'];
  file_name?: string;
}

/**
 * Create a new email source
 */
export async function createSource(
  request: CreateSourceRequest,
  userId: string,
  env: Env
): Promise<EmailSource> {
  const id = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO email_sources (id, name, email_address, source_type, file_name, status, user_id)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).bind(
    id,
    request.name,
    request.email_address || null,
    request.source_type,
    request.file_name || null,
    userId
  ).run();

  return getSource(id, userId, env) as Promise<EmailSource>;
}

/**
 * Get a source by ID (filtered by user)
 */
export async function getSource(id: string, userId: string, env: Env): Promise<EmailSource | null> {
  const result = await env.DB.prepare(
    'SELECT * FROM email_sources WHERE id = ? AND user_id = ?'
  ).bind(id, userId).first<EmailSource>();

  return result || null;
}

/**
 * List all sources for a user
 */
export async function listSources(userId: string, env: Env): Promise<EmailSource[]> {
  const result = await env.DB.prepare(
    'SELECT * FROM email_sources WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all<EmailSource>();

  return result.results || [];
}

/**
 * Update source status
 */
export async function updateSourceStatus(
  id: string,
  status: EmailSource['status'],
  userId: string,
  env: Env,
  extra?: {
    emails_total?: number;
    emails_processed?: number;
    emails_failed?: number;
    error_message?: string;
  }
): Promise<void> {
  let sql = 'UPDATE email_sources SET status = ?';
  const params: any[] = [status];

  if (status === 'processing') {
    sql += ', started_at = datetime("now")';
  } else if (status === 'completed' || status === 'failed') {
    sql += ', completed_at = datetime("now")';
  }

  if (extra?.emails_total !== undefined) {
    sql += ', emails_total = ?';
    params.push(extra.emails_total);
  }
  if (extra?.emails_processed !== undefined) {
    sql += ', emails_processed = ?';
    params.push(extra.emails_processed);
  }
  if (extra?.emails_failed !== undefined) {
    sql += ', emails_failed = ?';
    params.push(extra.emails_failed);
  }
  if (extra?.error_message !== undefined) {
    sql += ', error_message = ?';
    params.push(extra.error_message);
  }

  sql += ' WHERE id = ? AND user_id = ?';
  params.push(id, userId);

  await env.DB.prepare(sql).bind(...params).run();
}

/**
 * Increment processed count
 */
export async function incrementProcessed(
  id: string,
  processed: number,
  failed: number,
  userId: string,
  env: Env
): Promise<void> {
  await env.DB.prepare(`
    UPDATE email_sources SET
      emails_processed = emails_processed + ?,
      emails_failed = emails_failed + ?
    WHERE id = ? AND user_id = ?
  `).bind(processed, failed, id, userId).run();
}

/**
 * Toggle source inclusion in search
 */
export async function toggleSourceInSearch(
  id: string,
  included: boolean,
  userId: string,
  env: Env
): Promise<void> {
  await env.DB.prepare(
    'UPDATE email_sources SET is_included_in_search = ? WHERE id = ? AND user_id = ?'
  ).bind(included ? 1 : 0, id, userId).run();
}

/**
 * Delete a source and all its related data (full cascade)
 */
export async function deleteSource(id: string, userId: string, env: Env): Promise<void> {
  // Get all email IDs for this source
  const emailRows = await env.DB.prepare(
    'SELECT id FROM emails WHERE source_id = ? AND user_id = ?'
  ).bind(id, userId).all<{ id: string }>();

  const emailIds = (emailRows.results || []).map(r => r.id);

  if (emailIds.length > 0) {
    // Process in chunks to stay within query limits
    const chunkSize = 50;
    for (let i = 0; i < emailIds.length; i += chunkSize) {
      const chunk = emailIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');

      // Delete email_recipients for these emails
      await env.DB.prepare(
        `DELETE FROM email_recipients WHERE email_id IN (${placeholders})`
      ).bind(...chunk).run();

      // Get and delete attachments (DB records + R2 objects)
      const attachments = await env.DB.prepare(
        `SELECT id, r2_key FROM attachments WHERE email_id IN (${placeholders})`
      ).bind(...chunk).all<{ id: string; r2_key: string }>();

      if (attachments.results?.length) {
        // Delete R2 objects
        for (const att of attachments.results) {
          try {
            await env.ATTACHMENTS.delete(att.r2_key);
          } catch (e) {
            console.error(`Failed to delete R2 object ${att.r2_key}:`, e);
          }
        }
        // Delete attachment DB records
        await env.DB.prepare(
          `DELETE FROM attachments WHERE email_id IN (${placeholders})`
        ).bind(...chunk).run();
      }

      // Delete vector embeddings
      if (env.VECTORIZE?.deleteByIds) {
        try {
          await env.VECTORIZE.deleteByIds(chunk);
        } catch (e) {
          console.error('Failed to delete vector embeddings:', e);
        }
      }
    }
  }

  // Delete emails
  await env.DB.prepare(
    'DELETE FROM emails WHERE source_id = ? AND user_id = ?'
  ).bind(id, userId).run();

  // Delete any remaining upload chunks from R2
  const uploadPrefix = `uploads/${id}/`;
  const listed = await env.ATTACHMENTS.list({ prefix: uploadPrefix });
  for (const obj of listed.objects) {
    await env.ATTACHMENTS.delete(obj.key);
  }

  // Delete source record
  await env.DB.prepare(
    'DELETE FROM email_sources WHERE id = ? AND user_id = ?'
  ).bind(id, userId).run();
}

/**
 * Get IDs of sources included in search for a user
 */
export async function getIncludedSourceIds(userId: string, env: Env): Promise<string[]> {
  const result = await env.DB.prepare(
    'SELECT id FROM email_sources WHERE is_included_in_search = 1 AND user_id = ?'
  ).bind(userId).all<{ id: string }>();

  return (result.results || []).map(r => r.id);
}
