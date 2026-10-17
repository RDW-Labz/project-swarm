create table shops (
  id uuid primary key,
  slug text unique not null,
  name text not null,
  phone text,
  notify_email text
);

create table staff_users (
  id uuid primary key,
  shop_id uuid references shops(id),
  auth_user_id uuid unique not null,
  role text check (role in ('owner', 'staff'))
);

create table part_requests (
  id uuid primary key,
  shop_id uuid references shops(id),
  contact_name text not null,
  contact_phone text not null,
  vehicle_year integer,
  vehicle_make text,
  vehicle_model text,
  vin text,
  notes text,
  status text not null default 'new',
  created_at timestamptz not null default now()
);
