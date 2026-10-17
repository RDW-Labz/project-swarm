# Data model

This is the data model for the shop intake app. The first migration must create exactly these three tables, with exactly these columns.

## shops

One row per repair shop.

- id uuid primary key
- slug text unique not null
- name text not null
- phone text
- notify_email text

## staff_users

Staff who sign in for a shop.

- id uuid primary key
- shop_id uuid references shops
- auth_user_id uuid unique not null
- role text check (role in ('owner', 'staff'))

## part_requests

A customer request for parts, sent to one shop.

- id uuid primary key
- shop_id uuid references shops
- contact_name text not null
- contact_phone text not null
- vehicle_year integer
- vehicle_make text
- vehicle_model text
- vin text
- notes text
- status text not null default 'new'
- created_at timestamptz not null default now()
