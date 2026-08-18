-- P0 setup for PLAN.md — run this once in the Supabase SQL editor
-- (Project → SQL Editor → New query → paste → Run)

create table voice_memos (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  deleted_at  timestamptz,
  source_name text,
  source      text default 'mac',      -- 'mac' | 'pwa'
  path        text,                    -- 'A' | 'B' | 'C' | 'D' | 'E' | 'cp_…'
  category    text,                    -- Ollama-Rohwert, nur informativ
  title       text,
  summary     text,
  transcript  text,
  body_html   text,                    -- Editor-Output der PWA
  done        boolean default false    -- Nur relevant für Pfad E (To-Do)
);

-- Idempotenz: re-syncende iCloud-Dateien / LaunchAgent-Neustarts
-- überschreiben statt zu duplizieren.
create unique index voice_memos_source_name_uniq
  on voice_memos (source_name) where source_name is not null;

create index voice_memos_created_idx on voice_memos (created_at desc);

alter table voice_memos enable row level security;
create policy "allow all" on voice_memos for all using (true) with check (true);

alter publication supabase_realtime add table voice_memos;

-- Optional, P4 (custom paths across devices) — not needed for P0/P1, safe to skip for now:
--
-- create table voice_paths (
--   id         text primary key,        -- 'cp_<ts>'
--   name       text not null,
--   color_idx  int  not null default 0,
--   created_at timestamptz default now()
-- );
-- alter table voice_paths enable row level security;
-- create policy "allow all" on voice_paths for all using (true) with check (true);
-- alter publication supabase_realtime add table voice_paths;
