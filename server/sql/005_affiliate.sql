-- Affiliate-länkar: vem som värvade vem, och provisionerna.
--
-- KÖRS INTE AUTOMATISKT, av samma skäl som 001–004: Supabase-projektet delas med vips-buy-sell-hub.
-- Applicera för hand, FÖRE en utrullning som ska köra mot Supabase (LOOPA_LAGRING=supabase).
-- Utan det kör affiliate-lagret på filer under server/data/affiliate. Se server/src/affiliate/store.ts.
--
-- ETT EGET PROGRAM, skilt från inbjudningarna (003_referral.sql). Inbjudan ger en gratis försäljning;
-- affiliate ger 5 % i pengar. De har var sin kod och var sin referred_by, och en användare kan ha
-- kommit via båda — de två attribueringarna rör inte varandra.
--
-- REGLERNA BOR I server/src/affiliate/regler.ts. Det schemat garanterar är det som måste hålla även
-- om koden har fel: att referred_by aldrig skrivs om, en provision per såld annons, ingen provision
-- till säljaren själv, och att klienter bara kan LÄSA sina egna rader.

-- ---------------------------------------------------------------------------
-- Profilerna: koden och vem som värvade
-- ---------------------------------------------------------------------------

create table if not exists public.affiliate_profiles (
  user_id         uuid primary key,
  -- Samma form som inbjudningskoden ("K7QM-2XRP"), men en egen kodrymd. Se referral/kod.ts.
  affiliate_code  text not null unique check (affiliate_code ~ '^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$'),
  referred_by     uuid references public.affiliate_profiles (user_id),
  referred_at     timestamptz,
  -- Adressen admin betalar ut till. Sätts när kontot hämtar sin länk.
  email           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (referred_by is null or referred_by <> user_id)
);

create index if not exists affiliate_profiles_referred_by_idx on public.affiliate_profiles (referred_by)
  where referred_by is not null;

-- Första koden gäller och kan aldrig bytas — även för den som skriver förbi koden.
create or replace function public.affiliate_profiles_referred_by_last()
returns trigger language plpgsql as $$
begin
  if old.referred_by is not null and new.referred_by is distinct from old.referred_by then
    raise exception 'affiliate referred_by är redan satt och kan inte ändras';
  end if;
  if new.affiliate_code is distinct from old.affiliate_code then
    raise exception 'affiliate_code kan inte ändras';
  end if;
  return new;
end $$;

drop trigger if exists affiliate_profiles_referred_by_last on public.affiliate_profiles;
create trigger affiliate_profiles_referred_by_last
  before update on public.affiliate_profiles
  for each row execute function public.affiliate_profiles_referred_by_last();

-- ---------------------------------------------------------------------------
-- Provisionerna — saldot och huvudboken i ett
-- ---------------------------------------------------------------------------
--
-- En rad per såld annons. Beloppet räknas och fryses när säljarens pengar betalas ut, i ÖRE.
-- pending = intjänat, inte utbetalt. paid = admin har betalat ut för hand. cancelled = affären
-- återbetalades innan provisionen betalades ut.

create table if not exists public.affiliate_commissions (
  id                 uuid primary key,
  affiliate_user_id  uuid not null references public.affiliate_profiles (user_id),
  seller_user_id     uuid not null,
  -- Butikens produkt-id (Loopa-ID:t). UNIK: max en provision per såld annons.
  product_id         text not null unique,
  sale_price_ore     integer not null check (sale_price_ore >= 0),
  rate               numeric(4, 3) not null check (rate > 0 and rate <= 1),
  amount_ore         integer not null check (amount_ore >= 0),
  status             text not null check (status in ('pending', 'paid', 'cancelled')),
  created_at         timestamptz not null default now(),
  paid_at            timestamptz,
  paid_by            uuid,
  cancelled_at       timestamptz,
  cancel_reason      text,
  check (affiliate_user_id <> seller_user_id),
  check ((status = 'paid') = (paid_at is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null))
);

create index if not exists affiliate_commissions_affiliate_idx on public.affiliate_commissions (affiliate_user_id, status);

-- ---------------------------------------------------------------------------
-- RLS: klienter läser sitt eget, skriver ingenting
-- ---------------------------------------------------------------------------

alter table public.affiliate_profiles    enable row level security;
alter table public.affiliate_commissions enable row level security;

drop policy if exists affiliate_profiles_own on public.affiliate_profiles;
create policy affiliate_profiles_own on public.affiliate_profiles
  for select using (auth.uid() = user_id);

drop policy if exists affiliate_commissions_own on public.affiliate_commissions;
create policy affiliate_commissions_own on public.affiliate_commissions
  for select using (auth.uid() = affiliate_user_id);
