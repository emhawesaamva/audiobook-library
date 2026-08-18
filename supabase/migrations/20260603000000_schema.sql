-- Audiobook Library v2 relational schema.
-- Run before rls.sql. Legacy table audiobook_library is left untouched here.

-- ============ 1. accounts: one row per auth user ============
create table public.accounts (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text not null,
  display_name text,
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);
comment on table public.accounts is 'App-level record per auth.users row; created by trigger on signup.';

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.accounts (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Admin check used by RLS. SECURITY DEFINER avoids recursion through the
-- accounts select policy; safe in public schema because it only ever reveals
-- the caller's own admin flag (auth.uid()).
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select is_admin from public.accounts where id = auth.uid()), false) $$;

-- ============ 2. profiles: named libraries under an account ============
create table public.profiles (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null default auth.uid() references public.accounts (id) on delete cascade,
  name       text not null,
  age_group  text not null default 'adult' check (age_group in ('adult','teens','children')),
  sort_order int  not null default 0,
  legacy_id  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, name)
);
create index profiles_account_idx on public.profiles (account_id);
comment on column public.profiles.age_group is 'Drives AI recommendation audience filtering.';

-- ============ 3. books ============
-- Standalone books (parent_id null, is_series false), series headers
-- (is_series true), and series members (parent_id set).
create table public.books (
  id               uuid primary key default gen_random_uuid(),
  profile_id       uuid not null references public.profiles (id) on delete cascade,
  parent_id        uuid references public.books (id) on delete cascade,
  is_series        boolean not null default false,
  title            text not null,
  author           text,
  genre            text,
  subgenre         text,
  status           text check (status in ('read','reading','wanttoread','recommended','dnf')),
  rating           numeric(2,1) check (rating >= 0 and rating <= 5 and (rating*2) = floor(rating*2)),
  loved            boolean not null default false,
  notes            text,
  year             int,
  goodreads_rating numeric(3,2),
  goodreads_url    text,
  cover_url        text,
  narrator         text,
  duration_minutes int check (duration_minutes > 0),
  description      text,
  date_started     date,
  date_finished    date,
  isbn             text,
  asin             text,
  series_position  numeric(4,1),
  progress_percent smallint check (progress_percent between 0 and 100),
  dnf_reason       text,
  recommended_by   text,
  queue_position   int,
  reread_count     int not null default 0,
  tags             text[] not null default '{}',
  source           text check (source in ('audible','goodreads','libby','storygraph','other')),
  legacy_id        text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint no_nested_series check (parent_id is null or is_series = false),
  constraint series_rating_derived check (not is_series or (rating is null and status is null))
);
create index books_profile_idx on public.books (profile_id);
create index books_parent_idx  on public.books (parent_id);
create index books_status_idx  on public.books (profile_id, status);
create index books_tags_idx    on public.books using gin (tags);
comment on column public.books.status is 'NULL on series headers - derived from children in app.';
comment on column public.books.rating is '0-5 in half-star steps; NULL = unrated and on series headers.';
comment on column public.books.queue_position is 'Up Next ordering; NULL = not queued.';
comment on column public.books.recommended_by is 'Provenance: who recommended this book (person or "Claude").';
comment on column public.books.source is 'Import provenance: which service this book was imported/updated from. NULL = added manually.';

-- ============ 4. book_reads: re-listen history ============
create table public.book_reads (
  id            uuid primary key default gen_random_uuid(),
  book_id       uuid not null references public.books (id) on delete cascade,
  date_started  date,
  date_finished date,
  created_at    timestamptz not null default now()
);
create index book_reads_book_idx on public.book_reads (book_id);

-- ============ 5. reading_goals: per-profile yearly goals ============
create table public.reading_goals (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  year       int not null,
  goal_type  text not null check (goal_type in ('books','hours')),
  target     int not null check (target > 0),
  unique (profile_id, year, goal_type)
);

-- ============ 6. rejected_recommendations ============
create table public.rejected_recommendations (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  title      text not null,
  created_at timestamptz not null default now()
);
create unique index rejected_unique_idx
  on public.rejected_recommendations (profile_id, lower(title));

-- ============ 7. library_snapshots ============
create table public.library_snapshots (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  data       jsonb not null,
  created_at timestamptz not null default now()
);
create index snapshots_profile_idx on public.library_snapshots (profile_id, created_at desc);

-- ============ 8. user_settings / app_settings ============
create table public.user_settings (
  account_id         uuid primary key references public.accounts (id) on delete cascade,
  theme              text,
  default_profile_id uuid references public.profiles (id) on delete set null,
  settings           jsonb not null default '{}'::jsonb,
  updated_at         timestamptz not null default now()
);

create table public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
comment on table public.app_settings is 'Admin-managed: signups_disabled, default_model, ...';

-- ============ 9. updated_at maintenance ============
create or replace function public.touch_updated_at()
returns trigger language plpgsql as
$$ begin new.updated_at = now(); return new; end $$;

create trigger books_touch     before update on public.books         for each row execute function public.touch_updated_at();
create trigger profiles_touch  before update on public.profiles      for each row execute function public.touch_updated_at();
create trigger usettings_touch before update on public.user_settings for each row execute function public.touch_updated_at();

-- ============ 10. seed app settings ============
insert into public.app_settings (key, value) values
  ('signups_disabled', 'false'::jsonb),
  ('default_model', '"claude-sonnet-4-6"'::jsonb)
on conflict (key) do nothing;

-- ============ 11. feedback: contact-us submissions ============
create table public.feedback (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null default auth.uid() references public.accounts (id) on delete cascade,
  email      text not null,
  message    text not null,
  created_at timestamptz not null default now()
);
create index feedback_account_idx on public.feedback (account_id);
create index feedback_created_idx on public.feedback (created_at desc);
comment on table public.feedback is 'Contact-us submissions from the ? button; admin-reviewed only.';
