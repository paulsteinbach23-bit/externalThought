-- PLAN V2, V2-P0 — run this once in the Supabase SQL editor.
-- Adds `captures` and `idea_documents` alongside the existing `voice_memos`
-- table (kept as-is, read-only from here on — see PLAN V2's locked decisions).

create table idea_documents (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  deleted_at  timestamptz,
  title       text not null,
  body_html   text,
  canvas      jsonb not null default '{"nodes":[],"edges":[]}',
  viewport    jsonb                              -- {panX,panY,zoom}
);

create table captures (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),
  deleted_at        timestamptz,
  source_name       text,
  source            text default 'pwa',        -- 'mac' | 'pwa'
  kind              text not null check (kind in ('todo','idea')),
  transcript        text not null,
  title             text,
  done              boolean default false,      -- todo only
  due_date          date,                        -- todo only, optional (V2-P4)
  filed             boolean default false,       -- idea only: pulled into a doc
  idea_document_id  uuid references idea_documents(id),
  legacy_path       text                         -- migration provenance, V2-P2
);

create unique index captures_source_name_uniq
  on captures (source_name) where source_name is not null;

create index captures_created_idx on captures (created_at desc);
create index idea_documents_created_idx on idea_documents (created_at desc);

alter table captures enable row level security;
create policy "allow all" on captures for all using (true) with check (true);
alter publication supabase_realtime add table captures;

alter table idea_documents enable row level security;
create policy "allow all" on idea_documents for all using (true) with check (true);
alter publication supabase_realtime add table idea_documents;
