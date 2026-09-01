# Chennai Flood Risk — Community Dashboard (MVP)

An independent, ward-wise flood risk indicator for Chennai, built from open
rainfall data. **This is not an official warning system.** For authoritative
alerts follow [NDMA SACHET](https://sachet.ndma.gov.in/), IMD, and Greater
Chennai Corporation channels. Treat every score here as a risk indicator to
help you pay closer attention — never as an evacuation instruction.

## How it's structured

```
chennai-flood-predictor/
├── src/                  # backend: ingestion + scoring (LOCAL ONLY, gitignored)
│   ├── ingest/           #   pulls rainfall data
│   └── scoring/          #   turns rainfall + ward data into risk scores
├── data/                 # ward reference data (LOCAL ONLY, gitignored)
├── docs/                 # PUBLIC — this is what GitHub Pages serves
│   ├── index.html
│   ├── assets/
│   └── data/latest.json  # <- the only output the pipeline publishes
└── requirements.txt
```

Only `docs/` is meant to be pushed to the public GitHub repo. `src/` and
`data/` are gitignored, so the scoring method and raw ward vulnerability
numbers stay on your machine. If you later decide transparency of the method
is worth more than keeping it private, remove the relevant lines from
`.gitignore` and commit them deliberately — that's a call worth revisiting
once the formula is validated, since methodology transparency is what makes
a public risk tool trustworthy long-term.

## Running it

```bash
pip install -r requirements.txt
python3 src/pipeline.py
```

This fetches current data and overwrites `docs/data/latest.json`. Run it
hourly (cron, Task Scheduler, or a `while true; do ...; sleep 3600; done`
loop) to keep the heartbeat live. Then just push `docs/` — GitHub Pages will
serve whatever's in it.

To publish: in the repo settings, enable **GitHub Pages → Deploy from a
branch → /docs**.

## What's real right now vs. placeholder

- **Rainfall forecast/history** — live, from Open-Meteo (free, no key). This
  actually works today, verified against Chennai coordinates.
- **Rainfall pattern classification** — a rule-based stand-in (see "Research
  this draws from" below) that picks different saturation thresholds for
  convective bursts vs. prolonged systems vs. baseline monsoon rain, based
  on the shape of the forecast, not just its total. Thresholds are still
  guesses, not backtested.
- **Ward coordinates** — placeholder locality centroids for the 12
  chronically flood-prone areas identified in project research (Velachery,
  Mudichur, Kotturpuram, Saidapet, Pallikaranai, Medavakkam, Sholinganallur,
  Perungalathur, Nungambakkam, Egmore, Vyasarpadi, Manali). **Not real GCC
  ward boundary polygons** — replace with official ward GeoJSON before this
  is used for anything real.
- **`flood_history_score` per ward** — a rough placeholder estimate, not
  backtested. This is the single most important number to fix before launch
  (see Next Steps).
- **Scoring formula weights** — starting guesses, documented with their
  assumptions in `src/scoring/formula.py`, not yet calibrated.

## Setting up community reports (Supabase)

The dashboard also collects live citizen reports (a quick "does this match
what you're seeing" check, current water level, and trend) via a free
Supabase project. This needs a one-time setup:

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor -> New query**, paste the contents of
   `supabase/schema.sql`, and run it. This creates the reports table, the
   public aggregated view, and the rate-limiting policy.
3. Go to **Project Settings -> API** and copy the **Project URL** and
   **anon public key**.
4. Paste them into `docs/assets/supabase-config.js`:
   ```js
   window.SUPABASE_URL = "https://xxxx.supabase.co";
   window.SUPABASE_ANON_KEY = "eyJ...";
   ```
5. Commit `docs/assets/supabase-config.js` — the anon key is meant to be
   public; Supabase's security model relies on the Row Level Security
   policies in `supabase/schema.sql`, not on hiding this key. Do not ever
   put a `service_role` key here.
6. Before relying on it, verify the access shape actually works as intended
   (steps are listed at the bottom of `supabase/schema.sql`): the public
   should be able to insert and read the aggregated view, but never read
   the raw table directly.

Without this setup, the map and predictions still work fine — the report
panel just stays disabled.

### Why the design is shaped this way

An earlier version of this idea was a single abstract "panic meter." That's
worth avoiding: an open, unauthenticated distress score is easy to spoof,
and a visible panic gauge climbing can spread alarm rather than inform it.
[PetaBencana.id](https://petabencana.id) in Jakarta — a crowdsourced flood
reporting platform actually used by Indonesia's disaster agencies — solves
this by collecting concrete, checkable facts (location, water depth, a
photo) rather than sentiment, and only after residents confirm they're
filing a real report. This project follows the same logic: structured
reports (water level, trend), rate-limited per device, and shown only as
aggregated counts rather than a single reactive number.

## Research this draws from

- **Tang et al. 2023**, *Flood forecasting based on machine learning pattern
  recognition and dynamic migration of parameters* (Journal of Hydrology:
  Regional Studies) — the basis for `classify_rainfall_pattern()` in
  `src/scoring/formula.py`. They clustered 98 historical Yellow River floods
  by rainfall shape and used different model parameters per cluster,
  outperforming a single fixed-parameter model. This project uses a
  rule-based (not ML) version of the same idea: classify the forecast shape,
  then pick a matching saturation threshold.
- **IEEE, "Research on Flood Prediction and Early Warning System Based on
  Machine Learning Models" (2025)** — used Lasso regression for feature
  importance and k-means for a 3-tier (high/medium/low) risk classification,
  reaching R²≈0.86 with their best model. Useful as a reality check: even a
  full ML pipeline on well-chosen features doesn't reach exact prediction —
  reinforces treating scores here as directional.
- **GitHub's flood-prediction topic** (47 public repos as of this writing) —
  most are one-off ML notebooks rather than live public systems. The closest
  real precedent to this project's goals: a 2011 grassroots Thailand flood
  forecasting effort that used only existing water-level data and adaptive
  statistical models (no ML) when official tools broke down, and helped an
  estimated 13 million people prepare — a working example that transparent,
  non-ML, citizen-facing forecasting can matter at real scale.

## Data sources & attribution

- **Open-Meteo** (open-meteo.com) — rainfall forecast and recent-history,
  blended from open NWP models (GFS/ICON). No key required, no whitelisting.
- **IMD** (mausam.imd.gov.in) — India's authoritative met data. Has an API,
  but it requires IP whitelisting — apply separately, then swap it in
  alongside or instead of Open-Meteo for India-specific accuracy. IMD data
  is released under NDSAP and requires attribution when used.
- **data.gov.in** — open bulk historical rainfall datasets, useful for
  backtesting, not real-time.
- **OpenStreetMap** — map tiles for the public dashboard (attribution is
  already included in the page footer per their terms — don't remove it).

## Next steps (in priority order)

1. **Get real ward boundaries.** Source GCC ward GeoJSON (Chennai
   Corporation GIS or a Survey of India dataset) instead of point
   coordinates.
2. **Backtest the formula.** Pull historical rainfall for the 2015, 2021,
   and 2023 events and check whether the current weights would have flagged
   the wards that actually flooded. Adjust `FORECAST_72H_SATURATION_MM`,
   `ANTECEDENT_SATURATION_MM`, and the weight splits in
   `src/scoring/formula.py` accordingly.
3. **Apply for IMD API access** for India-specific nowcasting once the MVP
   proves out on Open-Meteo.
4. **Move the hourly trigger to GitHub Actions** (free for public repos) so
   the heartbeat doesn't depend on your laptop being on.
5. **Add a CAP-format alert export** (Common Alerting Protocol) if you want
   this to be pluggable into official channels like SACHET down the line.
6. **Designate ward-level relay contacts** for the no-internet relay model —
   the dashboard alone doesn't reach anyone without connectivity; that
   requires actual named contacts per ward (RWA heads, ration shop owners,
   local councillors), not just the map existing.
7. **Watch the community reports for abuse once live.** The rate limit
   stops casual spam, not a determined bad actor. Spot-check the raw
   `ward_reports` table periodically (via the Supabase dashboard) during
   any real event, and be ready to tighten the cooldown window or add a
   simple moderation step if reports look manipulated.
