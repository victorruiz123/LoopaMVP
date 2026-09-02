-- Trygg affär — affärsrummet mellan en köpare och en säljare.
--
-- KÖRS INTE AUTOMATISKT, av samma skäl som 001_butik.sql: schemat ligger i ett Supabase-projekt som
-- delas med vips-buy-sell-hub, och en tjänst som ändrar där vid uppstart kan göra det vid fel
-- tillfälle. Applicera för hand.
--
-- Utan SUPABASE_SERVICE_ROLE_KEY kör affärerna på filer under server/data/affarer och det här
-- schemat behövs inte alls. Se server/src/affar/store.ts.

create table if not exists public.affar_deals (
  id                  uuid primary key,
  -- Inbjudningslänkens hemlighet. UNIK och indexerad: den slås upp vid varje sidladdning av
  -- säljarens landningssida, och den är den enda nyckeln till affären.
  invite_token        text not null unique,
  state               text not null check (state in (
                        'created','invited','seller_joined','scanned','price_pending','price_agreed',
                        'paid','pickup_booked','picked_up','delivered','approved','paid_out',
                        'declined','expired')),

  buyer_id            uuid not null,
  buyer_email         text,
  -- Null tills säljaren skapat konto. Att öppna länken räcker inte.
  seller_id           uuid,
  seller_email        text,

  -- Köparens annonsunderlag. Bilderna ligger på disk, inte här; det här är sökvägar och maskad text.
  -- Töms när affären är slut — se purgeSubmissionMedia.
  submission          jsonb,
  -- VÅR slutsats om annonsen. Står kvar när underlaget städats: den är vårt arbete, inte annonsens.
  assessment          jsonb,

  -- Säljarens besiktning. Jobbet bär affärens id och hålls därmed utanför Butik och det publika
  -- kortet — se ConditionJob.dealId.
  scan_job_id         text,

  proposals           jsonb not null default '[]'::jsonb,
  awaiting            text check (awaiting in ('buyer','seller')),
  -- Vilka som accepterat det SENASTE förslaget. Nollställs vid varje nytt: ett ja gäller ett belopp.
  accepted_by         jsonb not null default '[]'::jsonb,
  counter_rounds      integer not null default 0,
  agreed_price_sek    integer,

  -- Båda parters postnummer, kontrollerade mot Stockholmszonerna vid affärens start.
  buyer_postal_code   text,
  seller_postal_code  text,

  order_id            uuid,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- När NUVARANDE läge går ut. Null i lägen utan klocka.
  expires_at          timestamptz,
  reminder_sent       boolean not null default false
);

-- Båda parter läser sin egen lista.
create index if not exists affar_deals_buyer_idx  on public.affar_deals (buyer_id, created_at desc);
create index if not exists affar_deals_seller_idx on public.affar_deals (seller_id, created_at desc)
  where seller_id is not null;
-- Städningen letar affärer vars klocka gått ut och ska inte läsa hela tabellen för det.
create index if not exists affar_deals_expiry_idx on public.affar_deals (expires_at)
  where expires_at is not null;

-- Huvudboken. Läggs bara till i. Den är svaret på "vad hände i affären" den dag en av parterna
-- ifrågasätter den, och ett fält som kan skrivas över är inget svar.
create table if not exists public.affar_events (
  id          uuid primary key,
  deal_id     uuid not null references public.affar_deals (id) on delete cascade,
  from_state  text,
  to_state    text not null,
  at          timestamptz not null default now(),
  actor       jsonb not null,
  note        text
);

create index if not exists affar_events_deal_idx on public.affar_events (deal_id, at);

-- ---------------------------------------------------------------------------
-- Pengarna
-- ---------------------------------------------------------------------------
--
-- ⚠️ OBESVARAD REGELFRÅGA — LÄS INNAN NI TAR EMOT EN RIKTIG BETALNING.
--
-- Tabellen nedan beskriver pengar som Loopa håller för någon ANNANS räkning: köparen har betalat,
-- säljaren har inte fått, och mellan de två tidpunkterna ligger beloppet hos oss. Att förmedla
-- betalningar och hålla medel åt tredje part kan vara tillståndspliktig verksamhet enligt lagen om
-- betaltjänster, och tillsynen ligger hos Finansinspektionen.
--
-- Mekaniken byggs som Stripe Connect med separata överföringar (köparen betalar plattformen,
-- transfer till säljarens anslutna konto vid frisläppning), vilket är den modell Stripe själva
-- anvisar för marknadsplatser. Det avgör INTE frågan ovan — det avgör bara vem som håller pengarna
-- rent tekniskt.
--
-- Detta är antecknat, inte avgjort. Inget i gränssnittet lovar köparen ett skydd förrän frågan är
-- besvarad. Se även server/src/affar/escrow.ts.

create table if not exists public.affar_escrow (
  id                    uuid primary key,
  deal_id               uuid not null references public.affar_deals (id),
  -- Vad köparen betalade, uppdelat så att varje krona går att härleda.
  item_price_sek        integer not null,
  trygghet_fee_sek      integer not null,
  delivery_fee_sek      integer not null,
  -- Stripe-sidan. payment_intent är köparens betalning, transfer är säljarens utbetalning.
  stripe_payment_intent text,
  stripe_transfer_id    text,
  -- Säljarens anslutna Stripe-konto. Null tills säljaren gjort sin KYC hos Stripe.
  stripe_account_id     text,
  status                text not null check (status in ('pending','held','released','refunded','failed')),
  held_at               timestamptz,
  released_at           timestamptz,
  created_at            timestamptz not null default now()
);

create index if not exists affar_escrow_deal_idx on public.affar_escrow (deal_id);

alter table public.affar_deals  enable row level security;
alter table public.affar_events enable row level security;
alter table public.affar_escrow enable row level security;
