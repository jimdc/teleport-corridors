---
summary: >-
  teleport-corridors is an offline-first NYC subway accessibility atlas that
  maps which neighborhoods look geographically distant but are fast by train.
  A Python pipeline converts MTA GTFS data into transit-time matrices and
  derived micro-unit neighborhoods; a static browser app serves Judge Mode,
  Centrality, and Teleportness views; deployed via GitHub Pages.
updated: 2026-07-05
sources:
  - README.md
  - tools/run_local.py
  - tools/build_matrix.py
  - tools/build_derived.py
  - site/index.html
sources_hash: 69813c5220023c614862168519f9fd079bc8f45ddb4b5105cb85c0ed36988762
---

# teleport-corridors — architecture

## What & why

Teleport Corridors helps people find underrated NYC neighborhoods by comparing
subway travel time rather than map distance. The core insight — neighborhoods
that look far on a map often ride fast by train, especially in the outer
boroughs — is not visible in any standard map or real-estate tool. The project
fills that gap by computing a full NxN transit-minutes matrix from MTA GTFS
data, deriving sub-tract micro-unit neighborhoods with gazetteer names, and
exposing the results through a Judge Mode (hard threshold + Pareto ranking),
a Teleportness view (minutes-saved bubbles), and a Centrality view.

## System map

```
data/raw/subway_gtfs.zip          ← MTA Subway GTFS (gitignored, ~60 MB)
data/raw/neighborhoods.geojson    ← NYC NTA boundaries (gitignored)
         │
         │  tools/download_inputs.py  (fetches from MTA + NYC Open Data)
         ▼
tools/build_matrix.py
  ├─ parse GTFS stops / trips / stop_times
  ├─ build stop graph; Dijkstra → NxN transit-minutes matrix
  │    (3 profiles: weekday AM, weekday PM, weekend)
  ├─ compute hub corridors, harmonic centrality, median minutes
  └─ emit → site/data/graph_<profile>.json
             site/data/matrix_<profile>.json
             site/data/teleport_corridors.json
             site/data/neighborhoods.geojson
             site/data/scalars_*.csv
         ▼
tools/build_derived.py
  ├─ assign micro-units to nearest station (haversine Voronoi)
  ├─ name derived regions via gazetteer (data/raw/neighborhoods_gazetteer.geojson)
  ├─ compute derived matrices + teleportness scores
  └─ emit → site/data/micro_units.geojson
             site/data/matrix_<profile>_derived.json
             site/data/graph_<profile>_derived.json
             site/data/teleport_corridors_derived.json
         ▼
site/data/    (all precompiled; committed to repo)
         ▼
site/ (static HTML + vanilla JS)
  ├─ index.html       redirect → decide.html
  ├─ decide.html      Judge Mode (hard thresholds + Pareto ranking)
  │    └─ judge_core.js
  ├─ teleport-corridors.html   Teleportness bubbles (minutes-saved per hub)
  │    └─ teleport-corridors.js
  ├─ centrality.html  Network centrality rankings
  ├─ living.html      Cartogram (area rescaled by population / units / jobs)
  ├─ views.html       Multi-view switcher
  ├─ app.js           Shared state, map rendering, hub-bar
  ├─ style.css
  ├─ glossary.html
  └─ methodology.html
         │
         ▼  .github/workflows/pages.yml (push to main)
GitHub Pages → https://jimdc.github.io/teleport-corridors/
```

Orchestration locally: `./buildandrun.sh` → `tools/run_local.py` →
`build_matrix.py` then `build_derived.py` → `python3 -m http.server` on
`site/` at port 8000.

## Data stores & schemas

- **`site/data/`** — precompiled static data, committed to the repo:
  - `matrix_weekday_am.json`, `matrix_weekday_pm.json`, `matrix_weekend.json` — NxN transit-minutes matrices (neighborhood × neighborhood)
  - `graph_<profile>.json` — stop-level graph with edge weights
  - `teleport_corridors.json` / `teleport_corridors_derived.json` — hub-to-spoke corridor rankings + teleportness scores
  - `neighborhoods.geojson`, `micro_units.geojson` — base and derived neighborhood geometries
  - `scalars_population.csv`, `scalars_housing_units.csv`, `scalars_jobs.csv` — per-neighborhood scalar metrics for cartogram + Judge Mode
- **`data/raw/`** — gitignored inputs: `subway_gtfs.zip`, `neighborhoods.geojson`, optional `neighborhoods_gazetteer.geojson`
- No per-user server-side state; the browser holds no localStorage.

## Serving & deploy

- **Production:** GitHub Actions (`.github/workflows/pages.yml`) deploys
  `site/` to GitHub Pages on every push to `main`.
  Live at `https://jimdc.github.io/teleport-corridors/`.
- **Local:** `./buildandrun.sh` (or `./buildonly.sh` for data only, then
  serve `site/` separately). `tools/run_local.py` runs the two build scripts
  then starts `python3 -m http.server` on port 8000 (default).
- No launchd unit, no Mini deployment, no persistent server process.

## Surface

Browser app (all pages in `site/`):

- `/decide.html` — Judge Mode (default landing): hard commute/walk/line thresholds + Pareto-optimal ranked recommendations
- `/teleport-corridors.html` — Teleportness: "looks far, rides fast" bubble map per hub
- `/centrality.html` — Centrality: most connected neighborhoods (hub / median / low-transfer)
- `/living.html` — Cartogram: area rescaled by population, housing units, or jobs
- `/views.html` — Multi-view switcher
- `/glossary.html` — Term definitions
- `/methodology.html` — Data and scoring methodology

No CLI entrypoint, no API, no MCP tools. The build scripts are dev-only tooling.

## Seams

- **Consumes (external):** MTA GTFS feed (downloaded by `download_inputs.py`);
  NYC Open Data neighborhoods GeoJSON; US Census LODES jobs data
  (`tools/import_jobs_lodes.py`); NTA housing tenure data
  (`tools/import_nta_housing_tenure.py`).
- **Feeds / consumed by:** nothing in the estate; standalone project.
- Tests: `tests/test_build_matrix.py`, `tests/test_build_derived.py`
  (pytest), `tests/test_judge.mjs` (Node). Fixtures in `tests/fixtures/`.

## TL;DR

4 Python pipeline scripts, 3 transit-time matrix profiles (weekday AM/PM, weekend), 1 local port (8000), no launchd units, hard rule: no per-user server-side state and no localStorage — all precompiled data is committed to the repo.

1. `download_inputs.py` fetches MTA GTFS zip and NYC Open Data neighborhoods GeoJSON into `data/raw/`.
2. `build_matrix.py` parses GTFS stops/trips/stop_times, builds a stop graph, and runs Dijkstra to produce NxN transit-minutes matrices for 3 profiles (weekday AM, weekday PM, weekend).
3. `build_matrix.py` also computes hub corridors, harmonic centrality, and median minutes, emitting JSON files to `site/data/`.
4. `build_derived.py` assigns micro-units to the nearest station via haversine Voronoi and names them using the gazetteer.
5. `build_derived.py` computes derived matrices and teleportness scores, emitting GeoJSON and JSON to `site/data/`.
6. Locally, `run_local.py` (invoked via `buildandrun.sh`) runs the two build scripts in order, then starts `python3 -m http.server` on port 8000 serving `site/`.
7. On push to `main`, GitHub Actions (`.github/workflows/pages.yml`) deploys `site/` to GitHub Pages at `https://jimdc.github.io/teleport-corridors/`.

## Check yourself

**Q:** What port does the local dev server use, and what directory does it serve?
**A:** Port 8000, serving the `site/` directory via `python3 -m http.server`.

**Q:** `build_matrix.py` crashes mid-run — what does `build_derived.py` consume and what does the browser serve?
**A:** `build_derived.py` would run against whatever partial or stale output `build_matrix.py` left in `site/data/`; the browser app continues to serve the last committed precompiled data in `site/data/` until a clean build is committed.

**Q:** What is the hard rule about user state in this project?
**A:** There is no per-user server-side state, and the browser holds no localStorage — all data is derived from precompiled static files committed to the repo.
