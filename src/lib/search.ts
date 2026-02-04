import type { Env, SearchRequest, SearchResponse, SearchResult, VectorMetadata } from '../types';

/**
 * QMD-inspired hybrid search pipeline
 *
 * Steps:
 * 1. Query Expansion - LLM generates alternative search terms
 * 2. Parallel Retrieval - BM25 (FTS5) + Vector (Vectorize) search
 * 3. RRF Fusion - Merge results using Reciprocal Rank Fusion
 * 4. LLM Re-ranking - Score candidates with language model
 * 5. Position-Aware Blending - Final score based on position
 */
export async function hybridSearch(
  request: SearchRequest,
  userId: string,
  env: Env
): Promise<SearchResponse> {
  const startTime = Date.now();
  const { query, filters, limit = 20, offset = 0 } = request;

  // Step 1: Query Expansion
  const expandedQueries = await expandQuery(query, env);

  // Step 2: Parallel Retrieval
  const [ftsResults, vectorResults] = await Promise.all([
    searchFTS(expandedQueries, filters, userId, env),
    searchVectors(expandedQueries, filters, userId, env),
  ]);

  // Step 3: RRF Fusion
  const fused = reciprocalRankFusion(ftsResults, vectorResults, { k: 60 });

  // Apply top-rank bonuses (QMD technique)
  if (fused.length > 0 && fused[0].score !== undefined) fused[0].score += 0.05;
  fused.slice(1, 3).forEach(r => { if (r.score !== undefined) r.score += 0.02; });

  // Step 4: LLM Re-ranking (top 30 candidates)
  const candidates = fused.slice(0, 30);
  const reranked = await rerankWithLLM(query, candidates, env);

  // Step 5: Position-Aware Score Blending
  const final = positionAwareBlend(reranked);

  // Apply offset and limit
  const results = final.slice(offset, offset + limit);

  return {
    results,
    total: final.length,
    query_expanded: expandedQueries,
    search_time_ms: Date.now() - startTime,
  };
}

/**
 * Step 1: Query Expansion
 * Uses LLM to generate alternative search queries with synonyms
 */
async function expandQuery(query: string, env: Env): Promise<string[]> {
  try {
    const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
      prompt: `Generate 1 alternative search query for finding emails related to: "${query}"
Focus on synonyms, related business terms, and common variations.
Return only the alternative query on a single line, no explanation or numbering.`,
      max_tokens: 100,
    });

    const expanded = (response as any).response?.trim();
    if (expanded && expanded.length > 0 && expanded.length < 200) {
      return [query, expanded];
    }
  } catch (e) {
    console.error('Query expansion failed:', e);
  }

  return [query];
}

/**
 * Step 2a: Full-Text Search using D1 FTS5 (filtered by user)
 */
async function searchFTS(
  queries: string[],
  filters: SearchRequest['filters'],
  userId: string,
  env: Env
): Promise<IntermediateResult[]> {
  // Build FTS query
  const ftsQuery = queries
    .map(q => q.split(/\s+/).filter(w => w.length > 2).join(' AND '))
    .join(' OR ');

  if (!ftsQuery) return [];

  let sql = `
    SELECT
      e.id as email_id,
      e.subject,
      snippet(emails_fts, 1, '<mark>', '</mark>', '...', 32) as snippet,
      c.email as from_email,
      c.name as from_name,
      e.sent_at,
      bm25(emails_fts) as bm25_score
    FROM emails_fts
    JOIN emails e ON emails_fts.rowid = e.rowid
    JOIN contacts c ON e.from_contact_id = c.id
    WHERE emails_fts MATCH ?
      AND e.user_id = ?
      AND (e.source_id IS NULL OR e.source_id IN (
        SELECT id FROM email_sources WHERE is_included_in_search = 1 AND user_id = ?
      ))
  `;

  const params: any[] = [ftsQuery, userId, userId];

  // Apply filters
  if (filters?.from_contact_id) {
    sql += ' AND e.from_contact_id = ?';
    params.push(filters.from_contact_id);
  }
  if (filters?.company_id) {
    sql += ' AND c.company_id = ?';
    params.push(filters.company_id);
  }
  if (filters?.date_from) {
    sql += ' AND e.sent_at >= ?';
    params.push(filters.date_from);
  }
  if (filters?.date_to) {
    sql += ' AND e.sent_at <= ?';
    params.push(filters.date_to);
  }
  if (filters?.has_attachments !== undefined) {
    sql += ' AND e.has_attachments = ?';
    params.push(filters.has_attachments ? 1 : 0);
  }
  if (filters?.source_ids?.length) {
    sql += ` AND e.source_id IN (${filters.source_ids.map(() => '?').join(',')})`;
    params.push(...filters.source_ids);
  }

  sql += ' ORDER BY bm25(emails_fts) LIMIT 50';

  try {
    const results = await env.DB.prepare(sql).bind(...params).all();

    return normalizeScores(
      (results.results || []).map((r: any, rank: number) => ({
        email_id: r.email_id,
        subject: r.subject,
        snippet: r.snippet || '',
        from_email: r.from_email,
        from_name: r.from_name,
        sent_at: r.sent_at,
        raw_score: Math.abs(r.bm25_score), // BM25 returns negative
        rank,
        source: 'fts' as const,
      }))
    );
  } catch (e) {
    console.error('FTS search failed:', e);
    return [];
  }
}

/**
 * Step 2b: Vector Search using Cloudflare Vectorize (filtered by user)
 */
async function searchVectors(
  queries: string[],
  filters: SearchRequest['filters'],
  userId: string,
  env: Env
): Promise<IntermediateResult[]> {
  try {
    // Embed queries
    const embeddings = await Promise.all(
      queries.map(async q => {
        const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
          text: q,
        });
        return (result as any).data[0];
      })
    );

    // Search with each embedding
    const allResults = await Promise.all(
      embeddings.map(async embedding => {
        const results = await env.VECTORIZE.query(embedding, {
          topK: 100, // Get more results since we'll filter by user_id
          returnMetadata: 'all',
        });
        return results.matches || [];
      })
    );

    // Deduplicate and filter by user_id (post-filter since Vectorize metadata filtering is limited)
    const seen = new Map<string, IntermediateResult>();

    allResults.flat().forEach((match, idx) => {
      const metadata = match.metadata as unknown as (VectorMetadata & { user_id?: string });
      const emailId = metadata?.email_id || match.id;

      // Filter by user_id if present in metadata
      if (metadata?.user_id && metadata.user_id !== userId) {
        return;
      }

      if (!seen.has(emailId) || (match.score || 0) > (seen.get(emailId)?.raw_score || 0)) {
        seen.set(emailId, {
          email_id: emailId,
          subject: metadata?.subject || '',
          snippet: '',
          from_email: metadata?.from_email || '',
          from_name: null,
          sent_at: metadata?.sent_at || '',
          raw_score: match.score || 0,
          rank: idx,
          source: 'vector' as const,
        });
      }
    });

    // Additional filtering: verify emails belong to user via DB
    const emailIds = Array.from(seen.keys());
    if (emailIds.length > 0) {
      const placeholders = emailIds.map(() => '?').join(',');
      const validEmails = await env.DB.prepare(
        `SELECT id FROM emails WHERE id IN (${placeholders}) AND user_id = ?`
      ).bind(...emailIds, userId).all<{ id: string }>();

      const validIds = new Set((validEmails.results || []).map(e => e.id));

      // Remove emails that don't belong to user
      for (const emailId of emailIds) {
        if (!validIds.has(emailId)) {
          seen.delete(emailId);
        }
      }
    }

    return normalizeScores(Array.from(seen.values()));
  } catch (e) {
    console.error('Vector search failed:', e);
    return [];
  }
}

/**
 * Step 3: Reciprocal Rank Fusion
 * Merges FTS and Vector results using RRF formula: score = Σ 1/(k + rank)
 */
function reciprocalRankFusion(
  ftsResults: IntermediateResult[],
  vectorResults: IntermediateResult[],
  { k = 60 }: { k?: number }
): IntermediateResult[] {
  const scores = new Map<string, { result: IntermediateResult; fts_score: number; vector_score: number; rrf: number }>();

  // Process FTS results
  ftsResults.forEach((r, rank) => {
    const existing = scores.get(r.email_id);
    const rrfScore = 1 / (k + rank + 1);

    if (existing) {
      existing.fts_score = r.normalized_score || 0;
      existing.rrf += rrfScore;
    } else {
      scores.set(r.email_id, {
        result: r,
        fts_score: r.normalized_score || 0,
        vector_score: 0,
        rrf: rrfScore,
      });
    }
  });

  // Process Vector results
  vectorResults.forEach((r, rank) => {
    const existing = scores.get(r.email_id);
    const rrfScore = 1 / (k + rank + 1);

    if (existing) {
      existing.vector_score = r.normalized_score || 0;
      existing.rrf += rrfScore;
      // Merge any missing fields from vector result
      if (!existing.result.snippet && r.snippet) {
        existing.result.snippet = r.snippet;
      }
    } else {
      scores.set(r.email_id, {
        result: r,
        fts_score: 0,
        vector_score: r.normalized_score || 0,
        rrf: rrfScore,
      });
    }
  });

  // Sort by RRF score and return
  return Array.from(scores.values())
    .sort((a, b) => b.rrf - a.rrf)
    .map(({ result, fts_score, vector_score, rrf }) => ({
      ...result,
      score: rrf,
      fts_score,
      vector_score,
    }));
}

/**
 * Step 4: LLM Re-ranking
 * Uses language model to score relevance of top candidates
 */
async function rerankWithLLM(
  query: string,
  candidates: IntermediateResult[],
  env: Env
): Promise<IntermediateResult[]> {
  // Process in batches to avoid rate limits
  const batchSize = 10;
  const results: IntermediateResult[] = [];

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);

    const scored = await Promise.all(
      batch.map(async (doc) => {
        try {
          const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
            prompt: `Rate how relevant this email is to the search query on a scale of 0-10.
Query: "${query}"
Email subject: "${doc.subject}"
Email preview: "${doc.snippet?.slice(0, 200) || 'No preview available'}"

Respond with only a single number from 0 to 10.`,
            max_tokens: 5,
          });

          const scoreText = (response as any).response?.trim();
          const score = parseInt(scoreText, 10);

          return {
            ...doc,
            rerank_score: isNaN(score) ? 5 : Math.min(10, Math.max(0, score)) / 10,
          };
        } catch (e) {
          return { ...doc, rerank_score: 0.5 };
        }
      })
    );

    results.push(...scored);
  }

  return results;
}

/**
 * Step 5: Position-Aware Score Blending
 * Trust retrieval more for top results, reranker more for lower results
 */
function positionAwareBlend(results: IntermediateResult[]): SearchResult[] {
  return results
    .map((result, i) => {
      let retrievalWeight: number;
      let rerankWeight: number;

      if (i < 3) {
        // Top 3: trust retrieval more (75/25)
        retrievalWeight = 0.75;
        rerankWeight = 0.25;
      } else if (i < 10) {
        // 4-10: balanced (60/40)
        retrievalWeight = 0.60;
        rerankWeight = 0.40;
      } else {
        // 11+: trust reranker more (40/60)
        retrievalWeight = 0.40;
        rerankWeight = 0.60;
      }

      const retrievalScore = result.score || 0;
      const rerankScore = result.rerank_score || 0.5;
      const finalScore = (retrievalScore * retrievalWeight) + (rerankScore * rerankWeight);

      return {
        email_id: result.email_id,
        subject: result.subject,
        snippet: result.snippet,
        from_email: result.from_email,
        from_name: result.from_name,
        sent_at: result.sent_at,
        score: finalScore,
        score_breakdown: {
          fts: result.fts_score || 0,
          vector: result.vector_score || 0,
          rerank: rerankScore,
        },
      };
    })
    .sort((a, b) => b.score - a.score);
}

// Helper: Normalize scores to 0-1 range
function normalizeScores(results: IntermediateResult[]): IntermediateResult[] {
  if (results.length === 0) return results;

  const maxScore = Math.max(...results.map(r => r.raw_score));
  const minScore = Math.min(...results.map(r => r.raw_score));
  const range = maxScore - minScore || 1;

  return results.map(r => ({
    ...r,
    normalized_score: (r.raw_score - minScore) / range,
  }));
}

// Internal type for intermediate results
interface IntermediateResult {
  email_id: string;
  subject: string;
  snippet: string;
  from_email: string;
  from_name: string | null;
  sent_at: string;
  raw_score: number;
  normalized_score?: number;
  rank: number;
  source: 'fts' | 'vector';
  score?: number;
  fts_score?: number;
  vector_score?: number;
  rerank_score?: number;
}
