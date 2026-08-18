-- Library holds: records that the user placed a Libby hold on a book and the
-- wait estimate they were quoted. A hold is an indicator, not a status — the
-- book keeps whatever status it had. Both columns are set and cleared together;
-- either being NULL means "no hold recorded".
--
-- Remaining wait is derived in the app: hold_date + hold_weeks*7 days, counted
-- down against today. A 10-week hold placed 2 weeks ago shows 8 weeks left.

alter table public.books
  add column if not exists hold_weeks int,
  add column if not exists hold_date  date;

-- Guard the range rather than just positivity: a two-year wait is already
-- absurd for a library hold, and a typo'd 100 would otherwise sit there.
alter table public.books
  drop constraint if exists books_hold_weeks_range;
alter table public.books
  add constraint books_hold_weeks_range
  check (hold_weeks is null or (hold_weeks > 0 and hold_weeks <= 104));

-- Both-or-neither: prevents half-written holds that would render as NaN weeks.
alter table public.books
  drop constraint if exists books_hold_pair;
alter table public.books
  add constraint books_hold_pair
  check ((hold_weeks is null) = (hold_date is null));

-- The Holds tab reads only rows that have one, so keep the index partial.
create index if not exists books_hold_idx
  on public.books (profile_id, hold_date)
  where hold_date is not null;

comment on column public.books.hold_weeks is 'Quoted Libby wait in weeks at the time the hold was placed; NULL = no hold.';
comment on column public.books.hold_date  is 'Date the hold was recorded; countdown origin for the Holds tab.';
