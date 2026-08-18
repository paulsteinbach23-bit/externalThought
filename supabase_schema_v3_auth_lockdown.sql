-- V3 step 2 — backfill existing rows with your user_id, then lock RLS down
-- to per-user access. Run this AFTER supabase_schema_v3_auth.sql and AFTER
-- your first successful login (so auth.users actually has this row).
--
-- Your user_id (from `select id, email from auth.users;`):
--   1c591733-a4a5-4032-9c2c-408283df6e59

-- ── Backfill ──────────────────────────────────────
update voice_memos    set user_id = '1c591733-a4a5-4032-9c2c-408283df6e59' where user_id is null;
update captures       set user_id = '1c591733-a4a5-4032-9c2c-408283df6e59' where user_id is null;
update idea_documents set user_id = '1c591733-a4a5-4032-9c2c-408283df6e59' where user_id is null;

-- ── RLS lockdown — replaces the wide-open "allow all" policy on each table ──
drop policy if exists "allow all" on voice_memos;
create policy "user can access own rows" on voice_memos
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "allow all" on captures;
create policy "user can access own rows" on captures
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "allow all" on idea_documents;
create policy "user can access own rows" on idea_documents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
