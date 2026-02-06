import type { Env, IngestEmailRequest, IngestBatchResponse, VectorMetadata } from '../types';

/**
 * Ingest a batch of emails with source tracking
 */
export async function ingestEmailsWithSource(
  emails: IngestEmailRequest[],
  sourceId: string | null,
  userId: string,
  env: Env
): Promise<IngestBatchResponse> {
  const results: IngestBatchResponse = {
    processed: 0,
    failed: 0,
    errors: [],
  };

  for (const email of emails) {
    try {
      await ingestSingleEmail(email, sourceId, userId, env);
      results.processed++;
    } catch (e) {
      results.failed++;
      results.errors.push({
        message_id: email.message_id,
        error: e instanceof Error ? e.message : 'Unknown error',
      });
    }
  }

  return results;
}

/**
 * Ingest a single email
 */
async function ingestSingleEmail(
  email: IngestEmailRequest,
  sourceId: string | null,
  userId: string,
  env: Env
): Promise<void> {
  const emailId = crypto.randomUUID();

  // 1. Ensure sender contact exists (scoped to user)
  const fromContact = await getOrCreateContact(email.from_email, email.from_name, userId, env);

  // 2. Ensure recipient contacts exist (scoped to user)
  const toContacts = await Promise.all(
    email.to.map(r => getOrCreateContact(r.email, r.name, userId, env))
  );
  const ccContacts = await Promise.all(
    (email.cc || []).map(r => getOrCreateContact(r.email, r.name, userId, env))
  );

  // 3. Determine thread ID
  const threadId = await resolveThreadId(email, userId, env);

  // 4. Insert email with source_id and user_id (OR IGNORE to handle duplicate message_id)
  const insertResult = await env.DB.prepare(`
    INSERT OR IGNORE INTO emails (id, message_id, thread_id, subject, body_text, body_html, sent_at, from_contact_id, has_attachments, source_id, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    emailId,
    email.message_id,
    threadId,
    email.subject,
    email.body_text,
    email.body_html || null,
    email.sent_at,
    fromContact.id,
    0,
    sourceId,
    userId
  ).run();

  // Skip if duplicate message_id
  if (insertResult.meta.changes === 0) {
    return;
  }

  // 5. Insert recipients
  for (const contact of toContacts) {
    await env.DB.prepare(`
      INSERT INTO email_recipients (email_id, contact_id, recipient_type)
      VALUES (?, ?, 'to')
    `).bind(emailId, contact.id).run();
  }
  for (const contact of ccContacts) {
    await env.DB.prepare(`
      INSERT INTO email_recipients (email_id, contact_id, recipient_type)
      VALUES (?, ?, 'cc')
    `).bind(emailId, contact.id).run();
  }

  // 6. Handle attachments
  let storedAttachments = 0;
  if (email.attachments?.length) {
    if (!env.ATTACHMENTS?.put) {
      console.warn('ATTACHMENTS binding not configured; skipping attachments for:', emailId);
    } else {
      for (const attachment of email.attachments) {
        try {
          const attachmentId = crypto.randomUUID();
          const r2Key = `${userId}/${emailId}/${attachmentId}/${attachment.filename}`;

          // Upload to R2
          const content = Uint8Array.from(atob(attachment.content_base64), c => c.charCodeAt(0));
          await env.ATTACHMENTS.put(r2Key, content, {
            customMetadata: {
              email_id: emailId,
              user_id: userId,
              filename: attachment.filename,
              content_type: attachment.content_type,
            },
          });

          // Record in DB
          await env.DB.prepare(`
            INSERT INTO attachments (id, email_id, filename, content_type, size, r2_key)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(
            attachmentId,
            emailId,
            attachment.filename,
            attachment.content_type,
            attachment.size,
            r2Key
          ).run();

          storedAttachments++;
        } catch (e) {
          console.error('Failed to store attachment for:', emailId, e);
        }
      }
    }
  }

  if (storedAttachments > 0) {
    await env.DB.prepare(
      'UPDATE emails SET has_attachments = 1 WHERE id = ? AND user_id = ?'
    ).bind(emailId, userId).run();
  }

  // 7. Create vector embedding
  await createEmbedding(emailId, email, fromContact.email, userId, env);

  // 8. Update contact stats
  await updateContactStats(fromContact.id, email.sent_at, userId, env);
}

/**
 * Get or create a contact by email address (scoped to user)
 */
async function getOrCreateContact(
  email: string,
  name: string | undefined,
  userId: string,
  env: Env
): Promise<{ id: string; email: string }> {
  const normalizedEmail = email.toLowerCase().trim();

  // Check if exists for this user
  const existing = await env.DB.prepare(
    'SELECT id, email FROM contacts WHERE email = ? AND user_id = ?'
  ).bind(normalizedEmail, userId).first<{ id: string; email: string }>();

  if (existing) {
    // Update name if we have one and they don't
    if (name) {
      await env.DB.prepare(
        'UPDATE contacts SET name = COALESCE(name, ?) WHERE id = ?'
      ).bind(name, existing.id).run();
    }
    return existing;
  }

  // Create new contact
  const contactId = crypto.randomUUID();
  const domain = normalizedEmail.split('@')[1];

  // Ensure company exists (scoped to user)
  const company = await getOrCreateCompany(domain, userId, env);

  await env.DB.prepare(`
    INSERT INTO contacts (id, email, name, company_id, first_seen, last_seen, email_count, user_id)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), 0, ?)
  `).bind(contactId, normalizedEmail, name || null, company?.id || null, userId).run();

  return { id: contactId, email: normalizedEmail };
}

/**
 * Get or create a company by domain (scoped to user)
 */
async function getOrCreateCompany(
  domain: string,
  userId: string,
  env: Env
): Promise<{ id: string; domain: string } | null> {
  // Skip common email providers
  const skipDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com'];
  if (skipDomains.includes(domain.toLowerCase())) {
    return null;
  }

  const normalizedDomain = domain.toLowerCase();

  // Check if exists for this user
  const existing = await env.DB.prepare(
    'SELECT id, domain FROM companies WHERE domain = ? AND user_id = ?'
  ).bind(normalizedDomain, userId).first<{ id: string; domain: string }>();

  if (existing) return existing;

  // Create new company
  const companyId = crypto.randomUUID();

  // Extract company name from domain (basic heuristic)
  const companyName = normalizedDomain
    .replace(/\.(com|net|org|io|co|au|uk|nz).*$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

  await env.DB.prepare(`
    INSERT INTO companies (id, domain, name, total_emails, first_contact, last_contact, user_id)
    VALUES (?, ?, ?, 0, datetime('now'), datetime('now'), ?)
  `).bind(companyId, normalizedDomain, companyName, userId).run();

  return { id: companyId, domain: normalizedDomain };
}

/**
 * Resolve thread ID from In-Reply-To / References headers
 */
async function resolveThreadId(
  email: IngestEmailRequest,
  userId: string,
  env: Env
): Promise<string | null> {
  // Check In-Reply-To first
  if (email.in_reply_to) {
    const parent = await env.DB.prepare(
      'SELECT thread_id FROM emails WHERE message_id = ? AND user_id = ?'
    ).bind(email.in_reply_to, userId).first<{ thread_id: string | null }>();

    if (parent?.thread_id) return parent.thread_id;
  }

  // Check References
  if (email.references?.length) {
    for (const ref of email.references) {
      const parent = await env.DB.prepare(
        'SELECT thread_id, id FROM emails WHERE message_id = ? AND user_id = ?'
      ).bind(ref, userId).first<{ thread_id: string | null; id: string }>();

      if (parent) {
        // Use existing thread_id or create one from the first message
        return parent.thread_id || parent.id;
      }
    }
  }

  // No thread found - will be null (standalone email)
  return null;
}

/**
 * Create vector embedding for semantic search
 * Gracefully skips if Vectorize is not available (local dev mode)
 */
async function createEmbedding(
  emailId: string,
  email: IngestEmailRequest,
  fromEmail: string,
  userId: string,
  env: Env
): Promise<void> {
  // Skip if Vectorize is not available (local dev mode)
  if (!env.VECTORIZE?.upsert) {
    console.log('Vectorize not available, skipping embedding for:', emailId);
    return;
  }

  try {
    // Create text for embedding: subject + first 1000 chars of body
    const textToEmbed = `${email.subject}\n\n${email.body_text.slice(0, 1000)}`;

    // Generate embedding
    const embeddingResult = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
      text: textToEmbed,
    });

    const embedding = (embeddingResult as any).data[0];

    // Store in Vectorize with user_id in metadata
    const metadata = {
      email_id: emailId,
      subject: email.subject,
      sent_at: email.sent_at,
      from_email: fromEmail,
      user_id: userId,
    };

    await env.VECTORIZE.upsert([
      {
        id: emailId,
        values: embedding,
        metadata: metadata as unknown as Record<string, string>,
      },
    ]);
  } catch (e) {
    console.error('Failed to create embedding for:', emailId, e);
    // Don't fail the entire ingestion if embedding fails
  }
}

/**
 * Update contact statistics after new email
 */
async function updateContactStats(
  contactId: string,
  sentAt: string,
  userId: string,
  env: Env
): Promise<void> {
  await env.DB.prepare(`
    UPDATE contacts SET
      email_count = email_count + 1,
      last_seen = MAX(last_seen, ?)
    WHERE id = ? AND user_id = ?
  `).bind(sentAt, contactId, userId).run();

  // Also update company stats
  await env.DB.prepare(`
    UPDATE companies SET
      total_emails = total_emails + 1,
      last_contact = MAX(last_contact, ?)
    WHERE id = (SELECT company_id FROM contacts WHERE id = ? AND user_id = ?)
      AND user_id = ?
  `).bind(sentAt, contactId, userId, userId).run();
}

// ═══════════════════════════════════════════════════════════════════
// PARALLEL PROCESSING FOR QUEUE CONSUMER
// ═══════════════════════════════════════════════════════════════════

/**
 * Process emails in parallel with batched DB operations and embeddings
 */
export async function ingestEmailsParallel(
  emails: IngestEmailRequest[],
  sourceId: string | null,
  userId: string,
  env: Env
): Promise<IngestBatchResponse> {
  const results: IngestBatchResponse = {
    processed: 0,
    failed: 0,
    errors: [],
  };

  if (emails.length === 0) return results;

  // 1. Deduplicate contacts across batch (in-memory)
  const uniqueEmails = new Set<string>();
  for (const email of emails) {
    uniqueEmails.add(email.from_email.toLowerCase());
    email.to.forEach(r => uniqueEmails.add(r.email.toLowerCase()));
    (email.cc || []).forEach(r => uniqueEmails.add(r.email.toLowerCase()));
  }

  // 2. Batch-fetch existing contacts and create missing ones
  const contactMap = await batchGetOrCreateContacts(
    Array.from(uniqueEmails),
    emails,
    userId,
    env
  );

  // 3. Process emails in parallel (groups of 10)
  const chunks = chunkArray(emails, 10);
  const processedEmails: { id: string; email: IngestEmailRequest }[] = [];

  for (const chunk of chunks) {
    const chunkResults = await Promise.all(
      chunk.map(async (email) => {
        try {
          const emailId = await ingestSingleEmailOptimized(email, sourceId, userId, contactMap, env);
          processedEmails.push({ id: emailId, email });
          return { success: true as const };
        } catch (e) {
          return {
            success: false as const,
            error: e instanceof Error ? e.message : 'Unknown error',
            messageId: email.message_id,
          };
        }
      })
    );

    for (const r of chunkResults) {
      if (r.success) {
        results.processed++;
      } else {
        results.failed++;
        results.errors.push({
          message_id: r.messageId || 'unknown',
          error: r.error || 'Unknown error',
        });
      }
    }
  }

  // 4. Batch create embeddings for successfully processed emails
  if (processedEmails.length > 0) {
    await batchCreateEmbeddings(processedEmails, contactMap, userId, env);
  }

  return results;
}

/**
 * Ingest a single email with pre-resolved contacts (no embedding - done in batch)
 */
async function ingestSingleEmailOptimized(
  email: IngestEmailRequest,
  sourceId: string | null,
  userId: string,
  contactMap: Map<string, { id: string; email: string }>,
  env: Env
): Promise<string> {
  const emailId = crypto.randomUUID();

  // Get contacts from pre-resolved map
  const fromContact = contactMap.get(email.from_email.toLowerCase());
  if (!fromContact) {
    throw new Error(`Contact not found for ${email.from_email}`);
  }

  const toContacts = email.to
    .map(r => contactMap.get(r.email.toLowerCase()))
    .filter((c): c is { id: string; email: string } => c !== undefined);

  const ccContacts = (email.cc || [])
    .map(r => contactMap.get(r.email.toLowerCase()))
    .filter((c): c is { id: string; email: string } => c !== undefined);

  // Determine thread ID
  const threadId = await resolveThreadId(email, userId, env);

  // Insert email with source_id and user_id (OR IGNORE to handle duplicate message_id)
  const insertResult = await env.DB.prepare(`
    INSERT OR IGNORE INTO emails (id, message_id, thread_id, subject, body_text, body_html, sent_at, from_contact_id, has_attachments, source_id, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    emailId,
    email.message_id,
    threadId,
    email.subject,
    email.body_text,
    email.body_html || null,
    email.sent_at,
    fromContact.id,
    0,
    sourceId,
    userId
  ).run();

  // Skip recipients and stats if duplicate
  if (insertResult.meta.changes === 0) {
    return emailId;
  }

  // Batch insert: email + recipients + stats update
  const statements: D1PreparedStatement[] = [];

  for (const contact of toContacts) {
    statements.push(
      env.DB.prepare(`INSERT INTO email_recipients (email_id, contact_id, recipient_type) VALUES (?, ?, 'to')`)
        .bind(emailId, contact.id)
    );
  }
  for (const contact of ccContacts) {
    statements.push(
      env.DB.prepare(`INSERT INTO email_recipients (email_id, contact_id, recipient_type) VALUES (?, ?, 'cc')`)
        .bind(emailId, contact.id)
    );
  }

  // Contact stats update
  statements.push(
    env.DB.prepare(`UPDATE contacts SET email_count = email_count + 1, last_seen = MAX(last_seen, ?) WHERE id = ? AND user_id = ?`)
      .bind(email.sent_at, fromContact.id, userId)
  );
  statements.push(
    env.DB.prepare(`UPDATE companies SET total_emails = total_emails + 1, last_contact = MAX(last_contact, ?) WHERE id = (SELECT company_id FROM contacts WHERE id = ? AND user_id = ?) AND user_id = ?`)
      .bind(email.sent_at, fromContact.id, userId, userId)
  );

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  return emailId;
}

/**
 * Batch get or create contacts for a list of email addresses
 */
async function batchGetOrCreateContacts(
  emailAddresses: string[],
  emails: IngestEmailRequest[],
  userId: string,
  env: Env
): Promise<Map<string, { id: string; email: string }>> {
  const contactMap = new Map<string, { id: string; email: string }>();

  if (emailAddresses.length === 0) return contactMap;

  // Batch query existing contacts (D1 has a limit on query size, so chunk if needed)
  const addressChunks = chunkArray(emailAddresses, 50);

  for (const chunk of addressChunks) {
    const placeholders = chunk.map(() => '?').join(',');
    const existing = await env.DB.prepare(`
      SELECT id, email FROM contacts
      WHERE email IN (${placeholders}) AND user_id = ?
    `).bind(...chunk, userId).all<{ id: string; email: string }>();

    for (const contact of existing.results || []) {
      contactMap.set(contact.email.toLowerCase(), contact);
    }
  }

  // Build name map from email headers for missing contacts
  const nameMap = buildNameMap(emails);

  // Create missing contacts in parallel (groups of 10)
  const missing = emailAddresses.filter(e => !contactMap.has(e.toLowerCase()));
  const missingChunks = chunkArray(missing, 10);

  for (const chunk of missingChunks) {
    await Promise.all(
      chunk.map(async (emailAddr) => {
        const contact = await getOrCreateContact(emailAddr, nameMap.get(emailAddr.toLowerCase()), userId, env);
        contactMap.set(emailAddr.toLowerCase(), contact);
      })
    );
  }

  return contactMap;
}

/**
 * Build a map of email addresses to names from email headers
 */
function buildNameMap(emails: IngestEmailRequest[]): Map<string, string | undefined> {
  const nameMap = new Map<string, string | undefined>();

  for (const email of emails) {
    if (email.from_name) {
      nameMap.set(email.from_email.toLowerCase(), email.from_name);
    }
    for (const r of email.to) {
      if (r.name && !nameMap.has(r.email.toLowerCase())) {
        nameMap.set(r.email.toLowerCase(), r.name);
      }
    }
    for (const r of email.cc || []) {
      if (r.name && !nameMap.has(r.email.toLowerCase())) {
        nameMap.set(r.email.toLowerCase(), r.name);
      }
    }
  }

  return nameMap;
}

/**
 * Batch create embeddings for multiple emails
 */
async function batchCreateEmbeddings(
  processedEmails: { id: string; email: IngestEmailRequest }[],
  contactMap: Map<string, { id: string; email: string }>,
  userId: string,
  env: Env
): Promise<void> {
  // Skip if Vectorize is not available (local dev mode)
  if (!env.VECTORIZE?.upsert) {
    console.log('Vectorize not available, skipping batch embeddings');
    return;
  }

  try {
    // Prepare texts for batch embedding
    const texts = processedEmails.map(({ email }) =>
      `${email.subject}\n\n${email.body_text.slice(0, 1000)}`
    );

    // Workers AI supports batch embedding
    const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
      text: texts,
    });

    const embeddings = (result as { data: number[][] }).data;

    // Upsert all vectors at once
    const vectors = processedEmails.map(({ id, email }, i) => ({
      id,
      values: embeddings[i],
      metadata: {
        email_id: id,
        subject: email.subject,
        sent_at: email.sent_at,
        from_email: email.from_email,
        user_id: userId,
      } as unknown as Record<string, string>,
    }));

    await env.VECTORIZE.upsert(vectors);
  } catch (e) {
    console.error('Failed to create batch embeddings:', e);
    // Don't fail the entire ingestion if embedding fails
  }
}

/**
 * Split an array into chunks of a given size
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
