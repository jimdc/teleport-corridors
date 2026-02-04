# Teleport Corridors (NYC subway-time neighborhoods)

Interactive map that answers: “From *here*, what neighborhoods are *actually close* by subway (minutes), and what’s far?”

## What it does
- Click a neighborhood to set an origin, then click another to set a destination.
- Colors every other neighborhood by **subway minutes** (not miles).
- Toggle time profile:
  - **Weekday AM** (07:00–10:00)
  - **Weekday PM** (16:00–19:00)
  - **Weekend** (10:00–22:00)
- Shows a route summary (line sequence like `Q → B → D`) and draws the path as colored segments.

## Repo layout
- `tools/build_matrix.py` — offline builder that turns MTA GTFS + a neighborhoods GeoJSON into `site/data/*.json`
- `site/` — static GitHub Pages site (SVG + vanilla JS)
- `data/` — docs for where to put downloaded inputs

## Setup (inputs)
Option A (script download):

```bash
python3 tools/download_inputs.py
```

Option B (manual download):
1) Download **MTA Subway GTFS** zip (the official “Subway” feed).
2) Download a neighborhoods GeoJSON (recommended: NYC DCP **NTA** boundaries as GeoJSON).
3) Put them here:
   - `data/raw/subway_gtfs.zip`
   - `data/raw/neighborhoods.geojson`

I can’t download these for you from inside this coding environment (network/DNS is blocked), but once you drop the two files in place everything runs fully offline (no live APIs).

## Build the data
From `teleport-corridors/`:

```bash
python3 tools/build_matrix.py \
  --gtfs data/raw/subway_gtfs.zip \
  --neighborhoods data/raw/neighborhoods.geojson \
  --out site/data
```

Or the short wrapper:

```bash
./buildonly.sh
```

This creates:
- `site/data/neighborhoods.geojson` (with stable `atlas_id` per feature)
- `site/data/graph_weekday_am.json`
- `site/data/graph_weekday_pm.json`
- `site/data/graph_weekend.json`
- `site/data/matrix_weekday_am.json`
- `site/data/matrix_weekday_pm.json`
- `site/data/matrix_weekend.json`
- `site/data/teleport_corridors.json` (precompiled “teleport corridor” lists per time profile)

Commit `site/data/*` to the repo so GitHub Pages can serve it.

## Run locally
Option A (one command: build + serve, offline-friendly):

```bash
python3 tools/run_local.py \
  --gtfs data/raw/subway_gtfs.zip \
  --neighborhoods data/raw/neighborhoods.geojson \
  --port 8000
```

Or the short wrapper:

```bash
./buildandrun.sh
```

Option B (serve only, if you already built `site/data/*`):

```bash
cd site
python3 -m http.server 8000
```

Open `http://127.0.0.1:8000`.

Pages:
- Map: `/`
- Teleport corridors: `/teleport-corridors.html`
  - Hover a corridor to preview it on a mini map
  - Uses “hub” destinations (Midtown / Downtown / Williamsburg / Downtown BK / LIC) to surface underrated outer-borough trips

## Publish on GitHub Pages
Push the repo, then set GitHub Pages to serve from:
- Branch: `main`
- Folder: `/site`

## Notes / limitations (current)
- Subway-only.
- “Transfer” modeling is approximate: stops that share `parent_station` get a fixed transfer cost (default 2 minutes).
- Times are “typical from schedule” for each window (median segment time), not real-time.

## GeoJSON expectations
The builder is flexible about property names, but works best if each feature has:
- a stable code (e.g. `NTACode`) and a display name (e.g. `NTAName`)
- valid `Polygon`/`MultiPolygon` geometry
