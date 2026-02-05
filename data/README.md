# Data inputs

This project expects you to download inputs yourself (so the repo stays lightweight).

Place these files in `data/raw/`:
- `subway_gtfs.zip` — MTA GTFS “Subway” feed zip
- `neighborhoods.geojson` — recommended: NYC DCP NTA boundaries as GeoJSON
- (optional) `scalars_population.csv` — columns: `atlas_id,value` (population)
- (optional) `scalars_housing_units.csv` — columns: `atlas_id,value` (housing units)
- (optional) `scalars_jobs.csv` — columns: `atlas_id,value` (jobs)
- Sample files live next to them (e.g. `scalars_jobs.sample.csv`). Copy to the non-sample filename to demo locally.

Then run:

```bash
python3 tools/build_matrix.py --gtfs data/raw/subway_gtfs.zip --neighborhoods data/raw/neighborhoods.geojson --out site/data
```

To normalize a CSV into the expected `scalars_*.csv` format, use:

```bash
python3 tools/prepare_scalar_csv.py --input path/to/your.csv --key housing_units
python3 tools/prepare_scalar_csv.py --input path/to/your.csv --key jobs
```

The script will try to match ids by `atlas_id`, `nta2020`, `cdta2020`, or neighborhood name.

To pull real NTA2020 population + housing units from the NYC NTA Housing Tenure layer:

```bash
python3 tools/import_nta_housing_tenure.py
```

To pull “big” jobs data (LODES WAC, aggregated to NTA2020):

```bash
python3 tools/import_jobs_lodes.py
```
