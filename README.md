# Octopus Energy Dashboard

A wall-mounted dashboard (built for an old iPad) showing your live Octopus
Energy electricity price + usage, and gas price + usage.

- **Electricity**: current unit rate, plus live demand from your Octopus Home
  Mini (updates roughly every 10-30 seconds).
- **Gas**: current unit rate, plus the latest smart meter reading. Gas has no
  live device (the Home Mini only talks to the electricity meter), so this is
  labelled "DELAYED" — smart gas meters report in 30-minute blocks, typically
  with a lag of a few hours.
- **Spend**: real £ cost (usage × the rate that actually applied, plus daily
  standing charge) for the last 24h / 7 days / 30 days, per fuel, plus how
  this week compares to last week.
- **Planning**: today's rate vs. tomorrow's (once Octopus has published it),
  how today compares to your 2-week average, and a small bar chart of the
  last two weeks of daily rates — enough to see "is today/tomorrow a cheap
  day to run the washing machine / charge the EV / put the immersion heater
  on".
- Built against the **Tracker** tariff (a single rate per day per fuel), but
  the pricing code works for any tariff shape (Agile, Flexible, etc.) since it
  just asks "what rate covers right now?". The "tomorrow's rate" comparison
  is most meaningful for a daily tariff like Tracker — on a half-hourly tariff
  like Agile it just shows the next rate change, not literally tomorrow.

## Why this architecture

Your Octopus API key must never sit in code or in anything served to a
browser (GitHub Pages, or any static host, can't keep a secret — anyone could
open dev tools and read it out of the page). So this repo is a small Next.js
app:

- The **frontend** (`app/page.js`) is plain client-side JS/CSS. It could be
  hosted anywhere, but it needs a backend to talk to.
- A couple of **server routes** (`app/api/price`, `app/api/usage`) hold the
  Octopus API key server-side, read it from an environment variable, and
  proxy just the data the frontend needs. The browser never sees the key.

The easiest free host that runs both halves together is **Vercel** — you
deploy this repo, set two environment variables in the Vercel project
settings (not in git), and it hosts both the page and the API routes on one
free URL. That's the recommended path below. (Plain static GitHub Pages
won't work on its own since it can't run the API routes / keep the key
secret.)

## 1. Get your API key and account number

1. Log in to your Octopus account and go to
   `https://octopus.energy/dashboard/developer/`.
2. Copy your **API key** (starts with `sk_live_`).
3. Copy your **account number** (starts with `A-`), shown on the same page.

Keep both private — treat the API key like a password.

## 2. Run it locally (optional)

```bash
npm install
cp .env.example .env.local
# edit .env.local and paste in your real API key + account number
npm run dev
```

Open `http://localhost:3000`.

## 3. Deploy to Vercel (free)

1. Push this repo to GitHub (already done if you're reading this from the
   repo).
2. Go to [vercel.com](https://vercel.com), sign in, and "Add New Project" →
   import this GitHub repo.
3. Before the first deploy (or right after, then redeploy), open
   **Project Settings → Environment Variables** and add:
   - `OCTOPUS_API_KEY`
   - `OCTOPUS_ACCOUNT_NUMBER`
   - Optionally, `OCTOPUS_ELECTRICITY_STANDING_CHARGE_PENCE` and/or
     `OCTOPUS_GAS_STANDING_CHARGE_PENCE` — see the standing charge note
     below, only needed if the dashboard shows a "no standing charge found"
     warning.
4. Deploy. Vercel gives you a URL like `octopus-dashboard-yourname.vercel.app`.

That URL is what the iPad points at. It's a private-enough value (nobody can
guess it), but keep in mind by default it isn't password protected — anyone
with the link can see your energy price/usage (not your account or payment
details). If you want it actually private, Vercel's paid plans support
password protection, or you can add basic auth in the app yourself.

## 4. Set up the iPad as a kiosk display

1. Open the dashboard URL in Safari on the iPad.
2. Tap Share → **Add to Home Screen**. This gives you a chrome-less
   full-screen web app icon (no Safari address bar).
3. Open the app from the home screen icon instead of Safari going forward.
4. Settings → Display & Brightness → Auto-Lock → **Never** (so it doesn't
   sleep). Best done while the iPad stays plugged in.
5. Optional: Settings → Accessibility → **Guided Access**, then triple-click
   the side/home button inside the app to lock the iPad into just this app
   (prevents accidental swipes away from the dashboard).

The page polls for new data itself (prices every 5 minutes, usage every 30
seconds) — no need to refresh manually.

## Notes / caveats

- **Standing charge**: Octopus's public `standard-standing-charges` endpoint
  returns 404 for some tariffs instead of a value (observed in practice on at
  least one Tracker tariff, not just a hypothetical) — the app can't tell if
  that means the tariff genuinely has no standing charge, or if Octopus just
  doesn't expose it for that tariff code. If a card shows a "no standing
  charge found" warning, check your Octopus account/bill for the actual
  p/day figure and set `OCTOPUS_ELECTRICITY_STANDING_CHARGE_PENCE` and/or
  `OCTOPUS_GAS_STANDING_CHARGE_PENCE` in Vercel to that value — the spend
  totals will pick it up automatically.
- The live electricity telemetry and account/tariff lookup use Octopus's
  **Kraken GraphQL API**, which isn't officially documented. The queries here
  are based on the field names used by the well-established open-source
  [BottlecapDave/HomeAssistant-OctopusEnergy](https://github.com/BottlecapDave/HomeAssistant-OctopusEnergy)
  integration. If Octopus changes this API, the `/api/usage` route may need
  updating — `lib/octopus.js` is where all of this lives.
- If your Home Mini goes offline or hasn't paired yet, the electricity panel
  will show "no reading" rather than failing the whole page.
- Standard unit rates (`/api/price`) use Octopus's public REST API, which is
  documented and stable.
- Spend figures (`/api/spend`) are anchored to the newest consumption reading
  Octopus actually has for each fuel — shown as "data as of" on each card —
  rather than a strict "last 24 hours from right now". That avoids the
  spend total looking artificially low just because recent smart meter
  readings haven't landed yet. If a half-hour interval's cost can't be
  matched to a published rate, it's excluded from the £ total and flagged
  as "partial data" so the number never silently under- or over-counts.
