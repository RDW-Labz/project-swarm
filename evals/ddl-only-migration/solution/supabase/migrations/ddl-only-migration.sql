create table notes (
  id uuid primary key,
  shop_id uuid not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index notes_shop_id_idx on notes (shop_id);

alter table notes enable row level security;

create policy notes_select_authenticated on notes
  for select
  to authenticated
  using (true);
