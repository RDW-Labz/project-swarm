# Table: notes

Columns:
- id uuid primary key
- shop_id uuid not null
- body text not null
- created_at timestamptz not null default now()

Index: an index on notes(shop_id).

Security: row level security is enabled on notes. Access is granted by policy; authenticated users may select.

Rule: migrations under supabase/migrations contain DDL only. Tests live in a tests folder.
