# Email Intelligence - Project Documentation

AI-powered hybrid search system for email archives with multi-user support, built on Cloudflare's edge platform. Inspired by Tobi Lütke's QMD (Query Modification Disambiguation) approach.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Cloudflare Workers + Hono.js + TypeScript |
| Frontend | Next.js 14+ (App Router) + React + TailwindCSS |
| Database | Cloudflare D1 (SQLite) |
| Vector Search | Cloudflare Vectorize (BGE-base-en-v1.5, 768-dim) |
| AI | Cloudflare Workers AI (Llama 3.8B for query expansion & re-ranking) |
| File Storage | Cloudflare R2 (email attachments) |
| Sessions | Cloudflare KV Namespace |
| Queue | Cloudflare Queue (async email processing) |

## Directory Structure

```
/email-intelligence/
├── src/
│   ├── workers/
│   │   └── index.ts              # Main API routes (~1,350 lines)
│   ├── lib/
│   │   ├── auth.ts               # PBKDF2 password hashing, session tokens
│   │   ├── search.ts             # 5-step hybrid search pipeline
│   │   ├── ingest.ts             # Email ingestion (sequential + parallel)
│   │   └── sources.ts            # Email source management
│   └── types/
│       └── index.ts              # TypeScript interfaces
├── frontend/
│   └── src/
│       ├── app/                  # Next.js pages
│       │   ├── page.tsx          # Search page (/)
│       │   ├── login/            # Authentication
│       │   ├── contacts/         # Contact list & detail pages
│       │   ├── companies/        # Company list & detail pages
│       │   ├── analytics/        # Dashboard
│       │   └── import/           # File upload & source management
│       ├── components/
│       │   └── Navigation.tsx    # Main nav bar
│       └── lib/
│           ├── api.ts            # API client functions
│           └── auth.tsx          # Auth context provider
├── migrations/
│   ├── 001_initial.sql           # Core schema
│   ├── 002_email_sources.sql     # Source tracking
│   ├── 003_users.sql             # User table
│   ├── 004_user_isolation.sql    # User isolation columns
│   └── 005_sources_user_id.sql   # Source user isolation
├── scripts/                      # Python ingestion scripts (PST, MBOX)
├── wrangler.toml                 # Cloudflare configuration
└── agents.md                     # This file
```

## API Endpoints

### Authentication (Public)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create new user account |
| POST | `/api/auth/login` | Authenticate, returns session token |
| POST | `/api/auth/logout` | Invalidate session |
| GET | `/api/auth/verify` | Validate current session |
| GET | `/api/auth/check` | Check if any users exist (setup detection) |

### Search (Authenticated)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/search` | Hybrid search (FTS + vector + LLM rerank) |
| GET | `/api/search/quick?q=` | Quick FTS-only autocomplete |

### Emails (Authenticated)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/emails/:id` | Full email with recipients, attachments, thread |
| GET | `/api/emails/:id/attachments/:attachmentId` | Download attachment |

### Contacts (Authenticated)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/contacts` | List contacts with pagination & search |
| GET | `/api/contacts/:id` | Contact timeline with stats |

### Companies (Authenticated)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/companies` | List companies with contact counts |
| GET | `/api/companies/:id` | Company details with contacts and emails |

### Analytics (Authenticated)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/analytics?days=30` | Summary stats, top contacts/companies, volume |

### Email Sources (Authenticated)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sources` | List all sources for user |
| POST | `/api/sources` | Create new source |
| GET | `/api/sources/:id` | Get source details |
| PATCH | `/api/sources/:id` | Toggle search inclusion |
| DELETE | `/api/sources/:id` | Delete source and all emails |
| POST | `/api/sources/:id/start` | Mark processing started |
| POST | `/api/sources/:id/complete` | Mark processing complete/failed |
| POST | `/api/sources/:id/upload` | Upload MBOX file |
| POST | `/api/sources/:id/upload-chunk` | Upload single chunk (large files) |
| POST | `/api/sources/:id/process` | Start background processing |

## Hybrid Search Pipeline

The search uses a 5-step QMD-inspired architecture:

### Step 1: Query Expansion
- Uses Llama 3.8B to generate synonyms/variations
- Example: "pricing discussion" → ["pricing discussion", "cost conversation"]

### Step 2: Parallel Retrieval
- **FTS Search**: D1 FTS5 with BM25 ranking (top 50)
- **Vector Search**: Cloudflare Vectorize with BGE embeddings (top 100)

### Step 3: RRF Fusion (Reciprocal Rank Fusion)
- Formula: `score = Σ 1/(k + rank)` where k=60
- Merges FTS and Vector results, handles duplicates

### Step 4: LLM Re-ranking
- Top 30 candidates scored by Llama 3.8B (0-10 scale)
- Based on query, subject, and snippet

### Step 5: Position-Aware Score Blending
- Top 3: 75% retrieval, 25% rerank
- 4-10: 60% retrieval, 40% rerank
- 11+: 40% retrieval, 60% rerank

### Search Filters
- `from_contact_id` - Filter by sender
- `company_id` - Filter by company
- `date_from`, `date_to` - Date range
- `has_attachments` - Attachment filter
- `source_ids` - Filter by specific sources

## Database Schema

### Core Tables

**users**
- `id`, `email` (unique), `password_hash`, `name`, `created_at`, `last_login`

**companies**
- `id`, `domain` (unique), `name`, `total_emails`, `first_contact`, `last_contact`, `user_id`

**contacts**
- `id`, `email` (unique), `name`, `company_id` (FK), `first_seen`, `last_seen`, `email_count`, `user_id`

**emails**
- `id`, `message_id` (unique), `thread_id`, `subject`, `body_text`, `body_html`, `sent_at`, `from_contact_id` (FK), `has_attachments`, `source_id` (FK), `user_id`

**email_recipients**
- `email_id` (FK), `contact_id` (FK), `recipient_type` ('to'|'cc'|'bcc')

**attachments**
- `id`, `email_id` (FK), `filename`, `content_type`, `size`, `r2_key`

**email_sources**
- `id`, `name`, `email_address`, `source_type`, `file_name`, `status`, `emails_total`, `emails_processed`, `emails_failed`, `is_included_in_search`, `error_message`, `user_id`

**emails_fts** (FTS5 virtual table)
- Indexes: `subject`, `body_text`
- Tokenizer: Porter + Unicode61

## Email Ingestion

### Queue-Based Processing (Production)
1. Frontend chunks file (1MB chunks)
2. Stores chunks in KV: `upload:{sourceId}:{chunkIndex}`
3. Backend parses MBOX format
4. Enqueues parsed emails to queue (batches of 25)
5. Queue consumer processes in parallel (groups of 10)
6. Creates contacts, embeddings, thread links
7. Updates progress incrementally
8. Marks complete when all processed

### Queue Configuration
```toml
[[queues.producers]]
binding = "EMAIL_QUEUE"
queue = "email-processing"

[[queues.consumers]]
queue = "email-processing"
max_batch_size = 50
max_batch_timeout = 30
max_retries = 3
```

### Parallel Ingestion (`ingestEmailsParallel`)
1. Deduplicate contacts across batch (in-memory)
2. Batch-fetch existing contacts from DB
3. Create missing contacts in parallel (groups of 10)
4. Process emails in parallel (groups of 10)
5. Batch create embeddings

### Thread Resolution
1. Check `In-Reply-To` header → use parent's thread_id
2. Check `References` array in order
3. If found, use parent's thread_id or parent's id
4. Otherwise: standalone email (no thread)

## Authentication

### Password Security
- **Algorithm**: PBKDF2 with SHA-256
- **Iterations**: 100,000
- **Salt**: 16 bytes (random)

### Session Tokens
- **Format**: Base64-encoded JSON (`user_id`, `iat`, `exp`)
- **Expiry**: 24 hours
- **Storage**: KV Namespace with TTL

## User Isolation

All data is scoped by `user_id`:
- Database: user_id columns on all tables
- Vector Search: user_id in metadata + post-filtering
- API: userId extracted from session token
- Attachments: R2 path includes user_id

## Cloudflare Bindings

```toml
# wrangler.toml
[[d1_databases]]
binding = "DB"
database_name = "email-db"

[[vectorize]]
binding = "VECTORIZE"
index_name = "email-vectors"

[ai]
binding = "AI"

[[kv_namespaces]]
binding = "CACHE"

[[kv_namespaces]]
binding = "SESSIONS"

[[queues.producers]]
binding = "EMAIL_QUEUE"
queue = "email-processing"
```

## Frontend Pages

| Route | Description |
|-------|-------------|
| `/` | Search page - inbox-style results |
| `/login` | Authentication (login/register) |
| `/contacts` | Contact list (table view) |
| `/contacts/[id]` | Contact timeline with email history |
| `/companies` | Company list (table view) |
| `/companies/[id]` | Company details with all emails |
| `/analytics` | Dashboard with charts |
| `/import` | Source management and file upload |

## Deployment

### Backend (Cloudflare Workers)
```bash
# Development
npx wrangler dev

# Production
npx wrangler deploy --env production
```

### Frontend (Cloudflare Pages)
```bash
# Build
npm run build:cf

# Deploy
npx wrangler pages deploy .vercel/output/static --project-name=qmdemon
```

### Production URLs
- **API**: api.qmdemon.com
- **Frontend**: qmdemon.pages.dev

## Database Migrations

Run migrations in order:
```bash
npx wrangler d1 execute email-db --file=./migrations/001_initial.sql
npx wrangler d1 execute email-db --file=./migrations/002_email_sources.sql
npx wrangler d1 execute email-db --file=./migrations/003_users.sql
npx wrangler d1 execute email-db --file=./migrations/004_user_isolation.sql
npx wrangler d1 execute email-db --file=./migrations/005_sources_user_id.sql
```

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/workers/index.ts` | All API routes, MBOX parsing, queue consumer |
| `src/lib/search.ts` | Hybrid search pipeline (FTS + Vector + LLM) |
| `src/lib/ingest.ts` | Email ingestion (sequential & parallel) |
| `src/lib/auth.ts` | Password hashing, token management |
| `src/lib/sources.ts` | Email source CRUD operations |
| `src/types/index.ts` | TypeScript interfaces (Env, requests, responses) |
| `frontend/src/lib/api.ts` | Frontend API client |
| `frontend/src/lib/auth.tsx` | Auth context provider |

## Environment Variables

Set in `wrangler.toml`:
```toml
[vars]
ENVIRONMENT = "development"

[env.production.vars]
ENVIRONMENT = "production"
```

Frontend (`.env.local`):
```
NEXT_PUBLIC_API_URL=http://localhost:8787
```

## Performance Characteristics

- **Queue batch size**: 50 messages
- **Parallel email processing**: 10 at a time
- **Contact batch queries**: 50 at a time
- **Search limits**: FTS=50, Vector=100, Rerank=30, Return=20
- **Email body text limit**: 50,000 characters
- **Embedding model**: BGE-base-en-v1.5 (768 dimensions)

## Common Tasks

### Create the queue (first time)
```bash
npx wrangler queues create email-processing
```

### Check queue status
```bash
npx wrangler queues list
```

### View logs
```bash
npx wrangler tail
```

### Query database
```bash
npx wrangler d1 execute email-db --command "SELECT COUNT(*) FROM emails"
```
