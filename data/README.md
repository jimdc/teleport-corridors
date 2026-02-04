# Data inputs

This project expects you to download inputs yourself (so the repo stays lightweight).

Place these files in `data/raw/`:
- `subway_gtfs.zip` — MTA GTFS “Subway” feed zip
- `neighborhoods.geojson` — recommended: NYC DCP NTA boundaries as GeoJSON

Then run:

```bash
python3 tools/build_matrix.py --gtfs data/raw/subway_gtfs.zip --neighborhoods data/raw/neighborhoods.geojson --out site/data
```

