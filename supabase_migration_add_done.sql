-- Migration: add the "done" column for the new To-Do (Path E) category.
-- Run once in the Supabase SQL editor if your table was created before
-- this column was added to supabase_schema.sql.

alter table voice_memos add column if not exists done boolean default false;
