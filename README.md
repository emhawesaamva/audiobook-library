# Audiobook Library

A personal audiobook tracking and recommendation app built with React, Vite, and Supabase.

## What it is

Audiobook Library is a private, PIN-protected web app for tracking your audiobook collection and getting personalized recommendations. It supports multiple profiles, so each person in your household can maintain their own separate library.

## Features

- **Library management** — Add, edit, and organize audiobooks by genre, subgenre, status, and rating. Mark books as Read, Reading, Want to Read, or Recommended.
- **Series support** — Group books into series with individual ratings per volume.
- **Multi-profile** — Create separate libraries for different people. Each profile is stored independently.
- **Profile types** — Set each profile as Adult, Teens, or Children to tailor recommendations appropriately.
- **AI recommendations** — Search for recommendations by describing what you're looking for. The app queries the Claude API with web search to find verified suggestions with Goodreads ratings.
- **Auto-recommendations** — On each app open, the app silently checks whether your library has two recommended books. If not, it queries Claude in the background and populates them automatically based on your loved books and authors.
- **Rejection memory** — Deleting a recommended book saves it to a per-profile rejection list so the same book is never suggested again.
- **Audible integration** — Every book card has a direct link to search Audible for that title.
- **Persistent storage** — All data is stored in Supabase. Changes sync immediately and a snapshot is saved on every session open for history.
- **PIN lock** — The app is protected by a 4-digit PIN with a hashed key stored in environment variables.

## Tech stack

- **Frontend** — React 18, Vite
- **Database** — Supabase (PostgreSQL via PostgREST)
- **AI** — Anthropic Claude API (Sonnet for recommendations with web search, Haiku for book lookup)
- **Hosting** — Runs locally via Vite dev server; deployable to Vercel or Netlify with a proxy function for the Anthropic API key

## Setup

1. Clone the repository
2. Install dependencies:
   ```
   npm install
   ```
3. Copy `.env.example` to `.env` and fill in your keys:
   ```
   cp .env.example .env
   ```
4. Generate a hashed PIN for the lock screen:
   ```
   node -e "require('crypto').createHash('sha256').update('YOUR_PIN').digest('hex')"
   ```
   Paste the output into `VITE_PIN_HASH` in your `.env`.
5. Start the dev server:
   ```
   npm run dev
   ```

## Environment variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key — [console.anthropic.com](https://console.anthropic.com) |
| `VITE_PIN_HASH` | SHA-256 hash of your 4-digit access PIN |
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable (anon) key |
| `SUPABASE_SECRET_KEY` | Supabase secret key (server-side proxy only) |

## Database

The app uses a single Supabase table `audiobook_library` with three columns:

| Column | Type | Description |
|---|---|---|
| `id` | text (PK) | Row identifier, e.g. `em-library`, `library-profiles` |
| `data` | jsonb | The stored payload |
| `updated_at` | timestamptz | Auto-set by Supabase |
