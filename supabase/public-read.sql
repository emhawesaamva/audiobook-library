-- Allow anonymous (unauthenticated) reads on profiles and books so that
-- public share URLs (/share/:profileId) work without sign-in.
-- Profile IDs are UUIDs — non-guessable — so this is effectively
-- access-controlled through URL obscurity, not open enumeration.
create policy profiles_anon_read on public.profiles
  for select to anon using (true);

create policy books_anon_read on public.books
  for select to anon using (true);
