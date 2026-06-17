# Enable "Sign in with Google" — one-time setup (~10 minutes)

Email/password sign-in already works. Google sign-in needs an OAuth client from
Google plus a switch in Supabase. Do these once:

## Part 1 — Google Cloud Console

1. Go to https://console.cloud.google.com/ and sign in with your **personal Google account**
   (the one you'll use to sign in to the Library app).
2. Create a project (top bar → project picker → **New Project**, name it `Audiobook Library`).
3. In the left menu: **APIs & Services → OAuth consent screen**
   - User type: **External** → Create
   - App name: `Audiobook Library`; support email: your email; developer contact: your email → Save through the remaining steps (no scopes needed).
   - Under **Audience**, click **Publish app** (otherwise only test users can sign in).
4. **APIs & Services → Credentials → + Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `Library web`
   - Authorized JavaScript origins — add both:
     - `https://audiolib.io`
     - `http://localhost:5173`
   - Authorized redirect URIs — add exactly:
     - `https://lschyxipktswvmicodij.supabase.co/auth/v1/callback`
   - Click **Create**, then copy the **Client ID** and **Client secret**.

## Part 2 — Supabase dashboard

1. Go to https://supabase.com/dashboard/project/lschyxipktswvmicodij/auth/providers
2. Expand **Google** → toggle **Enable Sign in with Google**
3. Paste the **Client ID** and **Client secret** from Part 1 → **Save**

## Part 3 — Supabase URL configuration

1. Go to https://supabase.com/dashboard/project/lschyxipktswvmicodij/auth/url-configuration
2. **Site URL**: `https://audiolib.io`
3. **Redirect URLs** → add: `http://localhost:5173`

Done. The "Continue with Google" button on the login page will work immediately —
no app redeploy needed. Sign in once with your Google account, then tell Claude
which email it was so the legacy library migration can run against your account.
