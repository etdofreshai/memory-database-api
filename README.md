# Memory Database API

Direct, authenticated PostgreSQL-backed archive API. Local source ingestors own
writes; people and agents read through the same HTTP API. No model service,
vector database, or gateway is required.

## Read interface

- `GET /api/memory/search?q=...`: ranked word search; optional `source`, `sender`,
  `recipient`, `after`, `before`, `limit` (1–50), `mode=terms|phrase`, `include_noise`.
- `GET /api/memory/records/:uuid`: original record and attachment references.
- `GET /api/memory/records/:uuid/context?limit=5`: chronological neighbors in the
  same source conversation, up to 20 per side. Reports missing identity.
- `GET /api/memory/sources`: latest message timestamps and per-ingestor reports.
- `GET /api/transactions?date_from=...&date_to=...`: structured transactions;
  `after`/`before` are aliases. Supports merchant/category filters and pagination.
- `GET /api/attachments?q=...`: filename/OCR/summary search.
- `GET /api/attachments/:uuid/file`: authenticated original file retrieval.

The older `/api/messages` and `/api/messages/search` routes remain compatible;
legacy search is literal substring matching. `/api/messages/:uuid/history` is
record version history, not conversation context. There is no vector-search route.

Search excludes known injected instructions by default and downranks assistant
progress. It returns excerpts, original IDs and context URLs, not generated claims.
Original source text is always retained. See `skill/memory-database/` for the
GET-only Python client and portable agent skill. Put read credentials in that
skill's `.env` or environment; do not commit secrets.

## Writes and freshness

`POST /api/messages` and multipart `/api/messages/ingest` support
`conflict_mode=skip_existing|skip_or_append|skip_or_overwrite`. Use `skip_existing`
for immutable session events. Source-backed edits may use versioned append.
`PUT /api/sync-state/:key` records per-host/per-source progress. Reader tokens
cannot write. Source-scoped writer checks also apply to transactions, tasks,
sync state and attachment enrichment. A shared attachment requires permission
for every linked source. All ingestor tokens require explicit source scopes. Before deployment, scope
legacy tokens and align their source names with the ingestors.

## Deployment

Requires Node.js and PostgreSQL. `DATABASE_URL` is mandatory. `PORT` defaults to
3000. `DB_STATEMENT_TIMEOUT_MS` defaults to 15000; connection timeout is 5 seconds.

```sh
npm ci
npm run build
npm start
```

Take and verify backups before production changes. On an existing deployment,
apply `migrations/014-memory-read.sql` with psql outside a transaction before
deploying this version. It adds functions and concurrent partial indexes over
current messages without rewriting archive content. Allow a longer statement
timeout for index construction. Startup does not apply this heavy migration.
Keep `SKIP_MIGRATIONS=true` when schema changes are managed explicitly.

The tests exercise the actual PostgreSQL API. Run only against a disposable
database with the migrations and api_tokens table installed:

```sh
DATABASE_URL=postgresql://postgres@localhost:55434/postgres npm test
```

Operational procedures are in `docs/operations.md`.
