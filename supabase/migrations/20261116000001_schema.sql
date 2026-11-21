-- WIns Delivery schema
-- Catalog (zones, stores, coverage, categories, products, inventory, event packages) is public-read.
-- Orders, order items, event requests and admins are private: only admins can read them.
-- Customers place orders through public.place_order(), which re-validates everything server-side.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

-- ---------------------------------------------------------------- tables

create table public.zones (
  id         text primary key,
  code       text not null unique,
  name       text not null check (length(name) between 1 and 80),
  name_ar    text check (length(name_ar) <= 80),
  color      text not null default '#CC9F50' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  fee        numeric(10,2) not null default 0 check (fee >= 0),
  min_order  numeric(10,2) not null default 0 check (min_order >= 0),
  active     boolean not null default true,
  poly       jsonb not null check (jsonb_typeof(poly) = 'array'),   -- [[lat, lng], ...]
  created_at timestamptz not null default now()
);

create table public.stores (
  id           text primary key,
  name         text not null check (length(name) between 1 and 80),
  name_ar      text check (length(name_ar) <= 80),
  lat          double precision not null check (lat between -90 and 90),
  lng          double precision not null check (lng between -180 and 180),
  open_time    text not null default '08:00' check (open_time ~ '^\d{2}:\d{2}$'),
  close_time   text not null default '24:00' check (close_time ~ '^\d{2}:\d{2}$'),
  prep_minutes int not null default 12 check (prep_minutes between 1 and 240),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table public.store_coverage (
  store_id text not null references public.stores(id) on delete cascade,
  zone_id  text not null references public.zones(id) on delete cascade,
  role     text not null check (role in ('primary', 'backup')),
  primary key (store_id, zone_id)
);
create index store_coverage_zone_idx on public.store_coverage (zone_id);

create table public.categories (
  key            text primary key,
  name           text not null,
  name_ar        text,
  hue            text not null check (hue ~ '^#[0-9A-Fa-f]{6}$'),
  age_restricted boolean not null default false,
  sort           int not null default 0
);

create table public.products (
  id         text primary key,
  category   text not null references public.categories(key),
  name       text not null check (length(name) between 1 and 120),
  name_ar    text check (length(name_ar) <= 120),
  unit       text check (length(unit) <= 60),
  unit_ar    text check (length(unit_ar) <= 60),
  price      numeric(10,2) not null check (price >= 0),
  was        numeric(10,2) check (was is null or was >= 0),
  listed     boolean not null default true,
  sort       int not null default 0,
  created_at timestamptz not null default now()
);
create index products_category_idx on public.products (category);

create table public.inventory (
  store_id   text not null references public.stores(id) on delete cascade,
  product_id text not null references public.products(id) on delete cascade,
  qty        int not null default 0 check (qty >= 0),
  primary key (store_id, product_id)
);
create index inventory_product_idx on public.inventory (product_id);

create table public.event_packages (
  id             text primary key,
  name           text not null,
  name_ar        text,
  description    text,
  description_ar text,
  guests         text,
  guests_ar      text,
  price          numeric(10,2) not null check (price >= 0),
  was            numeric(10,2) check (was is null or was >= 0),
  active         boolean not null default true,
  sort           int not null default 0
);

create table public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create sequence public.order_code_seq start 1041;

create table public.orders (
  id            bigint generated always as identity primary key,
  code          text not null unique default ('WN-' || nextval('public.order_code_seq')),
  token         uuid not null default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  status        smallint not null default 0 check (status between 0 and 3),
  store_id      text references public.stores(id) on delete set null,
  zone_id       text references public.zones(id) on delete set null,
  store_name    text, store_name_ar text,
  zone_code     text, zone_name text, zone_name_ar text,
  lat           double precision not null,
  lng           double precision not null,
  customer_name text not null,
  phone         text not null,
  building      text, floor text, apt text, street text, note text,
  pay           text not null check (pay in ('cash', 'card-on-delivery')),
  age_confirmed boolean not null default false,
  subtotal      numeric(10,2) not null,
  fee           numeric(10,2) not null,
  total         numeric(10,2) not null,
  eta_min       int,
  eta_max       int
);
create index orders_created_idx on public.orders (created_at desc);
create index orders_store_idx on public.orders (store_id);
create index orders_zone_idx on public.orders (zone_id);

create table public.order_items (
  id         bigint generated always as identity primary key,
  order_id   bigint not null references public.orders(id) on delete cascade,
  product_id text references public.products(id) on delete set null,
  name       text not null, name_ar text,
  unit       text, unit_ar text,
  category   text,
  price      numeric(10,2) not null,
  qty        int not null check (qty between 1 and 50)
);
create index order_items_order_idx on public.order_items (order_id);
create index order_items_product_idx on public.order_items (product_id);

create table public.event_requests (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  package_id text references public.event_packages(id) on delete set null,
  name       text not null check (length(btrim(name)) between 2 and 80),
  phone      text not null check (phone ~ '^\+?[0-9]{9,15}$'),
  event_date date not null check (event_date >= date '2026-01-01'),
  guests     int not null check (guests between 1 and 2000),
  district   text check (length(district) <= 80),
  notes      text check (length(notes) <= 1000),
  status     text not null default 'new' check (status in ('new', 'contacted', 'confirmed', 'cancelled'))
);
create index event_requests_package_idx on public.event_requests (package_id);
create index event_requests_created_idx on public.event_requests (created_at desc);

-- ---------------------------------------------------------------- helpers (private schema, not exposed)

create or replace function private.is_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = (select auth.uid()));
$$;

create or replace function private.point_in_poly(p_lat float8, p_lng float8, p_poly jsonb)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  n int := jsonb_array_length(p_poly);
  i int; j int;
  yi float8; xi float8; yj float8; xj float8;
  inside boolean := false;
begin
  if n < 3 then return false; end if;
  j := n - 1;
  for i in 0 .. n - 1 loop
    yi := (p_poly -> i ->> 0)::float8; xi := (p_poly -> i ->> 1)::float8;
    yj := (p_poly -> j ->> 0)::float8; xj := (p_poly -> j ->> 1)::float8;
    if ((yi > p_lat) <> (yj > p_lat)) and (p_lng < (xj - xi) * (p_lat - yi) / (yj - yi) + xi) then
      inside := not inside;
    end if;
    j := i;
  end loop;
  return inside;
end $$;

create or replace function private.poly_area(p_poly jsonb)
returns float8
language plpgsql immutable
set search_path = ''
as $$
declare
  n int := jsonb_array_length(p_poly);
  i int; j int; a float8 := 0;
begin
  if n < 3 then return 0; end if;
  j := n - 1;
  for i in 0 .. n - 1 loop
    a := a + ((p_poly -> j ->> 1)::float8 + (p_poly -> i ->> 1)::float8)
           * ((p_poly -> j ->> 0)::float8 - (p_poly -> i ->> 0)::float8);
    j := i;
  end loop;
  return abs(a / 2);
end $$;

create or replace function private.km(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
returns float8
language sql immutable
set search_path = ''
as $$
  select 2 * 6371 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

-- Opening hours are evaluated in Saudi time. Supports overnight hours (e.g. 08:00 → 02:00).
create or replace function private.is_open(p_open text, p_close text)
returns boolean
language plpgsql stable
set search_path = ''
as $$
declare
  o int := split_part(p_open, ':', 1)::int * 60 + split_part(p_open, ':', 2)::int;
  c int := split_part(p_close, ':', 1)::int * 60 + split_part(p_close, ':', 2)::int;
  now_r timestamp := (now() at time zone 'Asia/Riyadh');
  t int := extract(hour from now_r)::int * 60 + extract(minute from now_r)::int;
begin
  if c - o >= 1440 or o = c then return true; end if;
  if c > o then return t >= o and t < c; end if;
  return t >= o or t < c;
end $$;

-- Same ranking as the app: available stores covering a zone that contains the point,
-- primary coverage before backup, then nearest.
create or replace function private.resolve_store(p_lat float8, p_lng float8,
  out store_id text, out zone_id text, out dist_km float8)
language sql stable
set search_path = ''
as $$
  with z as (
    select zz.id, private.poly_area(zz.poly) as area
    from public.zones zz
    where zz.active and private.point_in_poly(p_lat, p_lng, zz.poly)
  ), c as (
    select s.id as sid, sc.zone_id as zid, sc.role,
           private.km(p_lat, p_lng, s.lat, s.lng) as dist,
           row_number() over (partition by s.id order by (sc.role = 'primary') desc, z.area) as rn
    from public.stores s
    join public.store_coverage sc on sc.store_id = s.id
    join z on z.id = sc.zone_id
    where s.active and private.is_open(s.open_time, s.close_time)
  )
  select c.sid, c.zid, c.dist from c
  where c.rn = 1
  order by (c.role = 'primary') desc, c.dist
  limit 1;
$$;

revoke all on all functions in schema private from public;
grant execute on function private.is_admin() to anon, authenticated;

-- ---------------------------------------------------------------- public RPCs

-- Place an order. Intentionally SECURITY DEFINER: customers have no direct access to orders
-- or inventory, so this function is the only way in. Every input is re-validated here;
-- the client's prices, store and fee are never trusted.
create or replace function public.place_order(
  p_lat float8,
  p_lng float8,
  p_items jsonb,              -- [{"id": "ck01", "qty": 2}, ...]
  p_customer jsonb,           -- {"name","phone","building","floor","apt","street","note"}
  p_pay text default 'cash',
  p_age_confirmed boolean default false
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  r          record;
  it         record;
  v_store    public.stores;
  v_zone     public.zones;
  v_price    numeric;
  v_age      boolean;
  v_stock    int;
  v_need_age boolean := false;
  v_sub      numeric := 0;
  v_ride     int;
  v_order    public.orders;
  v_name     text := btrim(coalesce(p_customer ->> 'name', ''));
  v_phone    text := regexp_replace(coalesce(p_customer ->> 'phone', ''), '[^0-9+]', '', 'g');
begin
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'invalid_location' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'invalid_items' using errcode = '22023';
  end if;
  if length(v_name) not between 2 and 80 then raise exception 'invalid_name' using errcode = '22023'; end if;
  if v_phone !~ '^\+?[0-9]{9,15}$' then raise exception 'invalid_phone' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_customer ->> 'building', ''))) = 0
     or length(btrim(coalesce(p_customer ->> 'street', ''))) = 0 then
    raise exception 'invalid_address' using errcode = '22023';
  end if;
  if p_pay not in ('cash', 'card-on-delivery') then raise exception 'invalid_payment' using errcode = '22023'; end if;

  select * into r from private.resolve_store(p_lat, p_lng);
  if r.store_id is null then raise exception 'no_store_for_location' using errcode = 'P0001'; end if;
  select * into v_store from public.stores s where s.id = r.store_id;
  select * into v_zone from public.zones z where z.id = r.zone_id;

  -- Pass 1: lock stock rows, check availability, compute subtotal from database prices.
  for it in
    select x.id as pid, sum(x.qty)::int as qty
    from jsonb_to_recordset(p_items) as x(id text, qty int)
    group by x.id
    order by x.id
  loop
    if it.pid is null or it.qty is null or it.qty < 1 or it.qty > 50 then
      raise exception 'invalid_quantity' using errcode = '22023';
    end if;
    select p.price, c.age_restricted, i.qty
      into v_price, v_age, v_stock
      from public.products p
      join public.categories c on c.key = p.category
      join public.inventory i on i.product_id = p.id and i.store_id = v_store.id
     where p.id = it.pid and p.listed
       for update of i;
    if not found then raise exception 'product_unavailable:%', it.pid using errcode = 'P0001'; end if;
    if v_stock < it.qty then raise exception 'insufficient_stock:%', it.pid using errcode = 'P0001'; end if;
    v_sub := v_sub + v_price * it.qty;
    v_need_age := v_need_age or v_age;
  end loop;

  if v_sub < v_zone.min_order then raise exception 'below_minimum' using errcode = 'P0001'; end if;
  if v_need_age and not coalesce(p_age_confirmed, false) then
    raise exception 'age_confirmation_required' using errcode = 'P0001';
  end if;

  v_ride := round(r.dist_km * 3.2 + 4);

  insert into public.orders (
    store_id, zone_id, store_name, store_name_ar, zone_code, zone_name, zone_name_ar,
    lat, lng, customer_name, phone, building, floor, apt, street, note,
    pay, age_confirmed, subtotal, fee, total, eta_min, eta_max)
  values (
    v_store.id, v_zone.id, v_store.name, v_store.name_ar, v_zone.code, v_zone.name, v_zone.name_ar,
    p_lat, p_lng, v_name, v_phone,
    left(btrim(p_customer ->> 'building'), 40), left(btrim(p_customer ->> 'floor'), 20),
    left(btrim(p_customer ->> 'apt'), 20), left(btrim(p_customer ->> 'street'), 160),
    left(btrim(p_customer ->> 'note'), 500),
    p_pay, coalesce(p_age_confirmed, false), v_sub, v_zone.fee, v_sub + v_zone.fee,
    v_store.prep_minutes + v_ride, v_store.prep_minutes + v_ride + 10)
  returning * into v_order;

  -- Pass 2: record items and take the stock.
  insert into public.order_items (order_id, product_id, name, name_ar, unit, unit_ar, category, price, qty)
  select v_order.id, p.id, p.name, p.name_ar, p.unit, p.unit_ar, p.category, p.price, a.qty
    from (select x.id, sum(x.qty)::int as qty
            from jsonb_to_recordset(p_items) as x(id text, qty int) group by x.id) a
    join public.products p on p.id = a.id;

  update public.inventory i
     set qty = i.qty - a.qty
    from (select x.id, sum(x.qty)::int as qty
            from jsonb_to_recordset(p_items) as x(id text, qty int) group by x.id) a
   where i.store_id = v_store.id and i.product_id = a.id;

  return jsonb_build_object(
    'code', v_order.code, 'token', v_order.token, 'created_at', v_order.created_at,
    'store', v_store.name, 'store_ar', v_store.name_ar,
    'zone_code', v_zone.code, 'zone', v_zone.name, 'zone_ar', v_zone.name_ar,
    'subtotal', v_order.subtotal, 'fee', v_order.fee, 'total', v_order.total,
    'eta', jsonb_build_array(v_order.eta_min, v_order.eta_max));
end $$;

-- Customers track their own order with the code + secret token returned by place_order.
create or replace function public.get_order(p_code text, p_token uuid)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'code', o.code, 'created_at', o.created_at, 'status', o.status,
    'store', o.store_name, 'store_ar', o.store_name_ar,
    'zone_code', o.zone_code, 'zone', o.zone_name, 'zone_ar', o.zone_name_ar,
    'subtotal', o.subtotal, 'fee', o.fee, 'total', o.total, 'pay', o.pay,
    'eta', jsonb_build_array(o.eta_min, o.eta_max),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', i.product_id, 'name', i.name, 'name_ar', i.name_ar,
                 'unit', i.unit, 'unit_ar', i.unit_ar, 'category', i.category,
                 'price', i.price, 'qty', i.qty) order by i.id)
               from public.order_items i where i.order_id = o.id), '[]'::jsonb))
  from public.orders o
  where o.code = p_code and o.token = p_token;
$$;

revoke all on function public.place_order(float8, float8, jsonb, jsonb, text, boolean) from public;
revoke all on function public.get_order(text, uuid) from public;
grant execute on function public.place_order(float8, float8, jsonb, jsonb, text, boolean) to anon, authenticated;
grant execute on function public.get_order(text, uuid) to anon, authenticated;

-- ---------------------------------------------------------------- privileges

revoke all on public.zones, public.stores, public.store_coverage, public.categories, public.products,
  public.inventory, public.event_packages, public.admins, public.orders, public.order_items,
  public.event_requests from anon, authenticated;
revoke all on sequence public.order_code_seq from anon, authenticated;

grant select on public.zones, public.stores, public.store_coverage, public.categories,
  public.products, public.inventory, public.event_packages to anon, authenticated;
grant insert, update, delete on public.zones, public.stores, public.store_coverage, public.categories,
  public.products, public.inventory, public.event_packages to authenticated;
grant select, update on public.orders to authenticated;
grant select on public.order_items to authenticated;
grant insert on public.event_requests to anon, authenticated;
grant select, update on public.event_requests to authenticated;
grant select on public.admins to authenticated;

-- ---------------------------------------------------------------- row level security

alter table public.zones          enable row level security;
alter table public.stores         enable row level security;
alter table public.store_coverage enable row level security;
alter table public.categories     enable row level security;
alter table public.products       enable row level security;
alter table public.inventory      enable row level security;
alter table public.event_packages enable row level security;
alter table public.admins         enable row level security;
alter table public.orders         enable row level security;
alter table public.order_items    enable row level security;
alter table public.event_requests enable row level security;

-- Catalog: everyone reads; admins also see paused/unlisted rows and can write.
create policy "read zones" on public.zones for select to anon, authenticated
  using (active or (select private.is_admin()));
create policy "read stores" on public.stores for select to anon, authenticated
  using (active or (select private.is_admin()));
create policy "read coverage" on public.store_coverage for select to anon, authenticated using (true);
create policy "read categories" on public.categories for select to anon, authenticated using (true);
create policy "read products" on public.products for select to anon, authenticated
  using (listed or (select private.is_admin()));
create policy "read inventory" on public.inventory for select to anon, authenticated using (true);
create policy "read event packages" on public.event_packages for select to anon, authenticated
  using (active or (select private.is_admin()));

do $$
declare t text;
begin
  foreach t in array array['zones','stores','store_coverage','categories','products','inventory','event_packages'] loop
    execute format('create policy "admin insert %1$s" on public.%1$I for insert to authenticated with check ((select private.is_admin()))', t);
    execute format('create policy "admin update %1$s" on public.%1$I for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()))', t);
    execute format('create policy "admin delete %1$s" on public.%1$I for delete to authenticated using ((select private.is_admin()))', t);
  end loop;
end $$;

-- Orders: admins only (customers use get_order with their token).
create policy "admin read orders" on public.orders for select to authenticated
  using ((select private.is_admin()));
create policy "admin update orders" on public.orders for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "admin read order items" on public.order_items for select to authenticated
  using ((select private.is_admin()));

-- Event requests: anyone can submit; only admins read and update.
create policy "submit event request" on public.event_requests for insert to anon, authenticated
  with check (status = 'new');
create policy "admin read event requests" on public.event_requests for select to authenticated
  using ((select private.is_admin()));
create policy "admin update event requests" on public.event_requests for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- Admins: a signed-in user can see only their own admin row (used by the app to show Admin).
create policy "see own admin row" on public.admins for select to authenticated
  using (user_id = (select auth.uid()));
