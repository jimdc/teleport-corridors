# Teleport Corridors

**Teleport Corridors** is an offline-first NYC subway accessibility atlas. It highlights neighborhoods that **look far on a map but feel close by train**—especially in the outer boroughs.

## Why it’s useful
- **Underrated neighborhoods**: Find places with surprisingly fast rides to key hubs.
- **Transit-first truth**: Compare *subway minutes*, not driving distance.
- **Hub-first exploration**: Hubs are first-class objects, with spokes and rankings that teach the mental model.
- **Sub-tract clarity**: Derived neighborhoods split large tracts into smaller, transit-oriented regions.

## What you can explore
- **Decide (default)**: Judge Mode with hard thresholds and explicit disqualifications.
- **Centrality**: Neighborhoods most connected to the rest of the network (hub / median / low-transfer).
- **Teleportness**: “Looks far, rides fast” rankings to chosen hubs.
- **Corridors**: Hub-to-spoke lists that surface underrated outer-borough trips.
- **Cartogram**: Resizes areas by a selected scalar (population first).
- **Derived neighborhoods**: Station-partitioned regions with StreetEasy-style naming and confidence.
- **Abbreviate**: Shortens long neighborhood names to reduce label clutter.
- **Judge Mode**: Hard thresholds + ranked recommendations with explicit disqualifications.
- **Hub bar**: Hub selection lives in a dedicated strip under the nav on Decide/Centrality/Teleportness.

### Cartogram “resize by”
When the map is set to **Cartogram**, neighborhood area is resized to encode the selected metric (Population, Housing Units, Jobs). The dropdown only lists scalar metrics (not reachability). In Geographic mode the dropdown is disabled because geometry is not rescaled.

### Teleportness bubbles
In the Teleportness view, bubble size represents **minutes saved** to the selected hub (larger = more teleport‑y).

### Judge Mode
Judge Mode applies **hard thresholds** (commute, walk, line access), then ranks the Pareto‑optimal set. See `/docs/judge-mode.md` for details. The Decide map now highlights **recommended** vs **disqualified** neighborhoods directly, with presets for quick starting points.

## Live site
[![Live site](https://img.shields.io/badge/Live%20site-jimdc.github.io%2Fteleport--corridors-4F46E5?style=flat&logo=github)](https://jimdc.github.io/teleport-corridors/)

## Data + offline-first
All data is precompiled from the MTA GTFS and neighborhood boundaries, then served as static files. No live APIs required once built.
Derived neighborhoods are built from micro-units assigned to their nearest station, then named using a local gazetteer when available.

---

## For developers
If you want to rebuild the data locally, use the scripts:

```
./buildonly.sh
./buildandrun.sh
```

Inputs go in:
`data/raw/subway_gtfs.zip`
`data/raw/neighborhoods.geojson`

Build output lives in `site/data/`.
