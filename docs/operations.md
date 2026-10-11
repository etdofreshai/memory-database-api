# Operating the direct memory service

## Backup before changes

Use the running PostgreSQL version's `pg_dump -Fc` for a consistent logical
snapshot, and `pg_dumpall --globals-only` for roles. Save them with mode 0600 in
a dated directory on a different volume from the source. The database contains
all message versions, source metadata, tokens and ingestion state: protect it
like the original archive.

Back up `/memory` separately: its attachment bytes are not part of PostgreSQL.
Preserve the service specifications and record the backup start/completion times.
The attachment archive is a file copy, not an atomic cross-resource snapshot.
Do not delete or rewrite attachments while this copy is running.

Verify hashes, `pg_restore --list`, complete archive decoding, and `gzip -t`/
`tar -tzf`. These checks are not a full restore drill. A full restore into an
isolated database should be identified separately when performed.

## Search upgrade

Apply `migrations/014-memory-read.sql` with psql and `ON_ERROR_STOP=1`, outside a
transaction. Use a long maintenance statement timeout for concurrent indexes.
Do not run all historical migrations blindly against production.

Run `node scripts/backfill-search.mjs` with the database URL after the migration.
It locks at most 1000 source rows per transaction and writes only derived search
passages. It is safe to rerun, and `AFTER_MESSAGE_ID` can resume from a logged
cursor. Require `complete:true` and `missing:0` before switching readers to the
new search route. The trigger maintains passages for subsequent source changes.

Each passage contains at most 12000 characters with a 300-character overlap.
Full records remain untouched. Searches match terms within a passage; distant
terms in different passages may need separate queries. Original record and
conversation endpoints retrieve the complete source content.

Deploy the API after its indexes and backfill are ready. Check actual public
HTTP responses and known recall queries. Rollback can redeploy the previous API
image without dropping new tables or deleting any archive content.

## Local ingestion

Keep readers read-only. Give every ingestor its own source-scoped write token.
Run session and iMessage ingestion on the host owning those files. Network
providers can run on the LAN server holding their authenticated state. Do not
activate a second writer for the same account without checking identities.

AI session ingestors report to `/api/sync-state/ai-session:HOST:SOURCE` and keep a
local last-sync file. A successful check with zero new records is healthy; an
old message timestamp by itself does not establish a failure. Treat missing
reports as unknown, not healthy. Keep interrupted/unconfirmed records pending.

The API and skill require no persistent gateway, LLM, vector service or agent
orchestrator. The optional management UI is not in the read path.
