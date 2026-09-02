-- Loopa Butik — tillstånd och huvudbok.
--
-- KÖRS INTE AUTOMATISKT. Servern skapar inga tabeller: schemat ligger i ett Supabase-projekt som
-- delas med vips-buy-sell-hub (se server/src/supabaseAuth.ts), och en tjänst som ändrar i en delad
-- databas vid uppstart är en tjänst som kan göra det vid fel tillfälle. Applicera med
-- `supabase db push`, eller klistra in i SQL-editorn.
--
-- Utan SUPABASE_SERVICE_ROLE_KEY kör butiken på filer under server/data/butik och det här schemat
-- behövs inte alls. Se server/src/butik/store.ts.

create table if not exists public.butik_products (
  id                  text primary key,
  source              text not null check (source in ('loopa', 'tradera')),
  job_id              text,
  -- Tillståndet. ETT per möbel, delat av båda kanalerna — det är hela poängen med tabellen.
  state               text not null check (state in ('draft','live','reserved','sold','delivered','returned')),
  reserved_until      timestamptz,
  reservation_token   uuid,
  -- Priset som gällde när reservationen togs. Prisstegen sänker veckovis (se PriceLadder i
  -- server/src/types.ts) och får inte flytta priset mitt i någons utcheckning.
  reserved_price_sek  integer,
  listed_at           timestamptz not null,
  sold_at             timestamptz,
  sold_channel        text check (sold_channel in ('butik','tradera')),
  tradera_item_id     bigint,
  updated_at          timestamptz not null default now()
);

-- Rutnätet läser på tillstånd och sorterar på när möbeln kom in.
create index if not exists butik_products_state_idx on public.butik_products (state, listed_at desc);
-- Tradera-pollningen slår upp på artikel-id när den fått veta att något sålts.
create index if not exists butik_products_tradera_idx on public.butik_products (tradera_item_id)
  where tradera_item_id is not null;
-- Städningen letar utgångna reservationer och ska inte läsa hela tabellen för det.
create index if not exists butik_products_reserved_idx on public.butik_products (reserved_until)
  where state = 'reserved';

-- Huvudboken. Läggs bara till i, uppdateras aldrig: den är svaret på "vad hände med möbeln" den dag
-- en köpare hör av sig, och ett fält som kan skrivas över är inget svar.
create table if not exists public.butik_events (
  id          uuid primary key,
  product_id  text not null references public.butik_products (id) on delete cascade,
  from_state  text,
  to_state    text not null,
  at          timestamptz not null default now(),
  -- Vem som utlöste övergången: säljare, köpare, system, Tradera eller admin. Se TransitionActor.
  actor       jsonb not null,
  note        text
);

create index if not exists butik_events_product_idx on public.butik_events (product_id, at);

-- Bevakningar: sparade sökningar som mejlas när en matchande Loopa-vara går live. De är också
-- efterfrågedata — det är därför de sparas och inte bara skickas.
create table if not exists public.butik_bevakningar (
  id             uuid primary key,
  user_id        uuid not null,
  email          text not null,
  category_slug  text,
  brand          text,
  max_price_sek  integer,
  max_width_mm   integer,
  max_depth_mm   integer,
  max_height_mm  integer,
  created_at     timestamptz not null default now(),
  -- Sätts när en träff mejlats, så samma bevakning inte skickar samma möbel två gånger.
  last_notified_at timestamptz
);

create index if not exists butik_bevakningar_user_idx on public.butik_bevakningar (user_id);
create index if not exists butik_bevakningar_match_idx on public.butik_bevakningar (category_slug, brand);

-- Ordrar. Håller köpet ihop mellan Stripe-sessionen, leveransvalet och möbelns tillstånd.
create table if not exists public.butik_orders (
  id                 uuid primary key,
  product_id         text not null references public.butik_products (id),
  user_id            uuid,
  email              text,
  price_sek          integer not null,
  delivery_fee_sek   integer not null default 0,
  postal_code        text,
  delivery_slot      text,
  status             text not null check (status in ('pending','paid','scheduled','delivered','return_requested','returned','cancelled')),
  stripe_session_id  text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists butik_orders_product_idx on public.butik_orders (product_id);
create index if not exists butik_orders_user_idx on public.butik_orders (user_id, created_at desc);

-- RLS: allt går genom servern med servicenyckeln, så ingen policy släpper in anon-nyckeln.
-- Utan detta är tabellerna läsbara för vem som helst med den publika nyckeln — den ligger i klienten.
alter table public.butik_products    enable row level security;
alter table public.butik_events      enable row level security;
alter table public.butik_bevakningar enable row level security;
alter table public.butik_orders      enable row level security;
