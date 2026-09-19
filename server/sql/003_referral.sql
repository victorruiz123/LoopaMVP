-- Inbjudningar och utbetalningar.
--
-- KÖRS INTE AUTOMATISKT, av samma skäl som 001_butik.sql och 002_affar.sql: Supabase-projektet delas
-- med vips-buy-sell-hub. Applicera för hand, FÖRE en utrullning som ska köra mot Supabase.
--
-- Utan SUPABASE_SERVICE_ROLE_KEY kör inbjudningarna på filer under server/data/referral och det här
-- schemat behövs inte. Se server/src/referral/store.ts.
--
-- Uppdragets `users.referral_code` / `users.referred_by` ligger i en EGEN tabell, referral_profiles:
-- auth.users är Supabases, och en användartabell i ett delat projekt är inte vår att lägga kolumner
-- på. Uppdragets `sales` är butik_products (en rad per såld möbel, över båda kanalerna); andelen står
-- på möbelns villkor i jobbet och fryses här vid utbetalningen.
--
-- REGLERNA BOR I server/src/referral/regler.ts, inte i en trigger. De måste gälla lika i filryggen,
-- och en regel som bara finns i ena ryggen gäller inte i den andra. Det schemat här garanterar är det
-- som måste hålla även om koden har fel: en kredit per inbjuden person, att referred_by aldrig skrivs
-- om, och att klienter bara kan LÄSA sina egna rader.

-- ---------------------------------------------------------------------------
-- Profilerna: koden och vem som bjöd in
-- ---------------------------------------------------------------------------

create table if not exists public.referral_profiles (
  user_id            uuid primary key,
  -- "K7QM-2XRP": fyra plus fyra ur ett alfabet utan 0/O/1/I/L. Se referral/kod.ts.
  referral_code      text not null unique check (referral_code ~ '^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$'),
  referred_by        uuid references public.referral_profiles (user_id),
  referred_at        timestamptz,
  first_paid_out_at  timestamptz,
  -- Avtrycken skydden jämför. Normaliserade, aldrig råa. Se referral/avtryck.ts.
  email_key          text,
  address_key        text,
  phone_key          text,
  stripe_account_id  text,
  email_masked       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (referred_by is null or referred_by <> user_id)
);

create index if not exists referral_profiles_referred_by_idx on public.referral_profiles (referred_by)
  where referred_by is not null;

-- referred_by sätts en gång och ändras aldrig. Koden gör redan skrivningen villkorad
-- (referred_by=is.null); det här är vad som gäller även för den som skriver förbi koden.
create or replace function public.referral_profiles_referred_by_last()
returns trigger language plpgsql as $$
begin
  if old.referred_by is not null and new.referred_by is distinct from old.referred_by then
    raise exception 'referred_by är redan satt och kan inte ändras';
  end if;
  if new.referral_code is distinct from old.referral_code then
    raise exception 'referral_code kan inte ändras';
  end if;
  return new;
end $$;

drop trigger if exists referral_profiles_referred_by_last on public.referral_profiles;
create trigger referral_profiles_referred_by_last
  before update on public.referral_profiles
  for each row execute function public.referral_profiles_referred_by_last();

-- ---------------------------------------------------------------------------
-- Krediterna
-- ---------------------------------------------------------------------------

create table if not exists public.referral_credits (
  id                uuid primary key,
  -- Mottagaren: den som bjöd in.
  user_id           uuid not null references public.referral_profiles (user_id),
  -- UNIK: en inbjuden person ger högst en kredit, någonsin.
  referred_user_id  uuid not null unique references public.referral_profiles (user_id),
  status            text not null check (status in ('available', 'used', 'expired')),
  -- Butikens produkt-id (Loopa-ID:t) — text, som butik_products.id.
  used_on_sale_id   text,
  used_at           timestamptz,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  check (user_id <> referred_user_id),
  check ((status = 'used') = (used_on_sale_id is not null)),
  check (expires_at > created_at)
);

create index if not exists referral_credits_user_idx on public.referral_credits (user_id, status, expires_at);
-- En kredit används på en möbel, och en möbel bär högst en kredit.
create unique index if not exists referral_credits_sale_idx on public.referral_credits (used_on_sale_id)
  where used_on_sale_id is not null;

-- ---------------------------------------------------------------------------
-- Huvudboken: invite_link_copied, referred_signup, referral_credit_created/_used/_denied
-- ---------------------------------------------------------------------------
--
-- Egen tabell och inte analysens: den mätningen är med flit identitetsfri (server/src/analys/store.ts),
-- och de här händelserna bär user_id och kod.

create table if not exists public.referral_events (
  id             uuid primary key,
  at             timestamptz not null default now(),
  event          text not null check (event in (
                   'invite_link_copied', 'referred_signup', 'referral_credit_created',
                   'referral_credit_used', 'referral_credit_denied')),
  user_id        uuid not null,
  referral_code  text,
  props          jsonb not null default '{}'::jsonb
);

create index if not exists referral_events_user_idx on public.referral_events (user_id, at);
create index if not exists referral_events_event_idx on public.referral_events (event, at);

-- ---------------------------------------------------------------------------
-- Utbetalningen, på den sålda möbeln
-- ---------------------------------------------------------------------------
--
-- Frusen vid utbetalningen och aldrig ändrad. commission_rate är andelen som GÄLLDE (0.20 eller 0),
-- läst ur möbelns villkor; beloppen är räknade av server/src/provision.ts.

alter table public.butik_products
  add column if not exists paid_out_at            timestamptz,
  add column if not exists payout_item_price_sek  integer,
  add column if not exists commission_rate        numeric(4, 3) not null default 0.20
                                                  check (commission_rate >= 0 and commission_rate <= 1),
  add column if not exists loopa_fee_sek          integer,
  add column if not exists seller_payout_sek      integer,
  add column if not exists referral_credit_id     uuid references public.referral_credits (id),
  add column if not exists paid_out_by            uuid;

alter table public.butik_products
  drop constraint if exists butik_products_payout_sums;
alter table public.butik_products
  add constraint butik_products_payout_sums
  check (paid_out_at is null or loopa_fee_sek + seller_payout_sek = payout_item_price_sek);

-- ---------------------------------------------------------------------------
-- RLS: klienter läser sitt eget, skriver ingenting
-- ---------------------------------------------------------------------------
--
-- Servern skriver med servicenyckeln, som går förbi RLS. Det finns alltså inga insert- eller
-- update-policyer, med flit: en inloggad klient ska aldrig kunna sätta sin egen referred_by eller
-- skapa en kredit.

alter table public.referral_profiles enable row level security;
alter table public.referral_credits  enable row level security;
alter table public.referral_events   enable row level security;

drop policy if exists referral_profiles_own on public.referral_profiles;
create policy referral_profiles_own on public.referral_profiles
  for select using (auth.uid() = user_id);

drop policy if exists referral_credits_own on public.referral_credits;
create policy referral_credits_own on public.referral_credits
  for select using (auth.uid() = user_id);

-- referral_events: ingen policy alls. Bara servern läser huvudboken.
