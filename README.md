# Teleport Corridors

**Teleport Corridors** is an offline-first NYC subway accessibility atlas. It highlights neighborhoods that **look far on a map but feel close by train**—especially in the outer boroughs.

## Why it’s useful
- **Underrated neighborhoods**: Find places with surprisingly fast rides to key hubs.
- **Transit-first truth**: Compare *subway minutes*, not driving distance.
- **Liveability lenses**: See walk-to-subway, line diversity, and hub teleportness.

## What you can explore
- **Map**: Click an origin and see subway-minute reach (with routes + isochrones).
- **Teleport corridors**: “Looks far, rides fast” rankings to chosen hubs.
- **Centrality**: Neighborhoods most connected to the rest of the network.
- **Living**: Teleportness, walk-to-subway, and line diversity views.

## Live site
Once GitHub Pages finishes deploying, visit:
`https://jimdc.github.io/teleport-corridors/`

## Data + offline-first
All data is precompiled from the MTA GTFS and neighborhood boundaries, then served as static files. No live APIs required once built.

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
