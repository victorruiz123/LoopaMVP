-- Gåvan: en gratisförsäljning utan att någon bjudit in någon.
--
-- KÖRS INTE AUTOMATISKT, av samma skäl som 001–003: Supabase-projektet delas med vips-buy-sell-hub.
-- Applicera för hand, FÖRE scripts/gratis-till-alla.ts körs mot Supabase.
--
-- Utan SUPABASE_SERVICE_ROLE_KEY kör inbjudningarna på filer under server/data/referral, och då
-- behövs inget av det här — filryggen håller samma två garantier i kod (referral/store.ts).
--
-- Bakgrunden: 2026-09-23 gav vi alla konton som fanns då sin nästa försäljning gratis. Krediten är i
-- allt annat samma sak som en inbjudningskredit, så den bor i samma tabell. Det som skiljer är att
-- den inte pekar på någon inbjuden person.

-- ---------------------------------------------------------------------------
-- referred_user_id får vara null, och source säger varför
-- ---------------------------------------------------------------------------

alter table public.referral_credits
  add column if not exists source text not null default 'invite'
    check (source in ('invite', 'gift'));

alter table public.referral_credits
  alter column referred_user_id drop not null;

-- En gåva har ingen inbjuden; en inbjudningskredit har alltid en.
alter table public.referral_credits
  drop constraint if exists referral_credits_source_referred;
alter table public.referral_credits
  add constraint referral_credits_source_referred
  check ((source = 'gift') = (referred_user_id is null));

-- `unique` på kolumnen tillät bara en null-rad i vissa lägen och säger inget om källan. Ersätts av
-- två partiella index: en kredit per inbjuden person, och en gåva per person.
alter table public.referral_credits
  drop constraint if exists referral_credits_referred_user_id_key;

create unique index if not exists referral_credits_referred_idx
  on public.referral_credits (referred_user_id)
  where referred_user_id is not null;

create unique index if not exists referral_credits_gift_idx
  on public.referral_credits (user_id)
  where source = 'gift';

-- check (user_id <> referred_user_id) faller på null i Postgres och behöver inte röras: en rad med
-- null jämför till unknown, och unknown släpps igenom av en check. Villkoret ovan täcker det fallet.

-- ---------------------------------------------------------------------------
-- Huvudboken känner igen gåvan
-- ---------------------------------------------------------------------------

alter table public.referral_events
  drop constraint if exists referral_events_event_check;
alter table public.referral_events
  add constraint referral_events_event_check
  check (event in (
    'invite_link_copied', 'referred_signup', 'referral_credit_created',
    'referral_credit_used', 'referral_credit_denied', 'referral_gift_granted'
  ));
