-- Cached Libby/OverDrive availability for a book at the user's library.
--
-- Looked up per book, so caching it here keeps the library view instant and
-- keeps us off the (undocumented, unrate-limited-by-us) OverDrive endpoint on
-- every render. Refreshed in the background when older than a day.
--
-- States, and why there are only three:
--   available  the library owns it and a copy is free now
--   wait       the library owns it, all copies out; libby_wait_days is their
--              estimate, which moves as people return early or copies are added
--   absent     the search returned nothing for this title at this library
--
-- "absent" deliberately conflates "your library does not own it" with "not in
-- OverDrive at all": the search endpoint only ever returns owned titles, so the
-- two are indistinguishable from here. Phrase it as "not at your library".

alter table public.books
  add column if not exists libby_state      text,
  add column if not exists libby_wait_days  int,
  add column if not exists libby_checked_at timestamptz;

alter table public.books
  drop constraint if exists books_libby_state_valid;
alter table public.books
  add constraint books_libby_state_valid
  check (libby_state is null or libby_state in ('available', 'wait', 'absent'));

-- A wait in days only means anything alongside the 'wait' state.
alter table public.books
  drop constraint if exists books_libby_wait_days_range;
alter table public.books
  add constraint books_libby_wait_days_range
  check (libby_wait_days is null or (libby_wait_days >= 0 and libby_wait_days <= 3650));

comment on column public.books.libby_state      is 'available | wait | absent; NULL = never checked.';
comment on column public.books.libby_wait_days  is 'OverDrive estimatedWaitDays at libby_checked_at; only meaningful when state = wait.';
comment on column public.books.libby_checked_at is 'When availability was last fetched; drives the staleness refresh.';
