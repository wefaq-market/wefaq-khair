# Wefaq Khair

Production frontend for Wefaq, deployed through GitHub Pages and served on:

https://wefaq-khair.org

## Files

- `index.html` — production frontend.
- `CNAME` — custom domain configuration.
- `.github/workflows/deploy.yml` — GitHub Pages deployment workflow.
- `.gitignore` — prevents local secrets and temporary files from being committed.

## Important

Do not commit `.env`, Supabase service-role keys, Telegram bot tokens, or other secrets.
The browser may use the Supabase public/anon key, but database security must be enforced with Supabase RLS.
