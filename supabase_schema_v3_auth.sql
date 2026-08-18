-- V3 — per-user data isolation via Supabase Auth.
-- Run this in the Supabase SQL editor BEFORE logging into the app for the
-- first time. Column is nullable for now so existing rows don't break;
-- a follow-up backfill + RLS lockdown happens after your first login
-- (see CLAUDE.md / the auth rollout plan for the full sequence).

alter table voice_memos     add column if not exists user_id uuid references auth.users(id);
alter table captures        add column if not exists user_id uuid references auth.users(id);
alter table idea_documents  add column if not exists user_id uuid references auth.users(id);
