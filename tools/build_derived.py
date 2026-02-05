#!/usr/bin/env python3

"""
Build sub-tract micro-units, derived neighborhood regions, and derived matrices.

Inputs (existing in repo):
- data/raw/neighborhoods.geojson (tracts / NTAs)
- site/data/graph_<profile>.json
- site/data/matrix_<profile>.json

Outputs (into site/data):
- micro_units.geojson
- derived_regions.geojson
- graph_<profile>_derived.json
- matrix_<profile>_derived.json
- teleport_corridors_derived.json

TODO: Optional gazetteer polygons
Provide a GeoJSON FeatureCollection at data/raw/neighborhoods_gazetteer.geojson
with properties:
  - name (string)
  - borough (optional)
Geometry: Polygon/MultiPolygon in lon/lat (WGS84).
See tests/fixtures/neighborhoods_gazetteer.sample.geojson for a tiny example.

TODO: Optional population scalars
Provide a CSV at data/raw/scalars_population.csv with columns:
  - atlas_id (tract/region id, e.g., NTA code)
  - population (numeric)
See tests/fixtures/scalars_population.sample.csv for a tiny example.
"""

import argparse
import datetime as dt
import json
import math
import os
import re
import sys
from collections import defaultdict
from typing import Dict, Iterable, List, Optional, Tuple

from build_matrix import (
    compute_hub_corridors,
    harmonic_centrality_from_minutes_row,
    median_minutes_from_row,
    pick_neighborhood_borough,
    pick_neighborhood_id,
    pick_neighborhood_name,
    slugify,
)


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    r = 6371.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def point_in_ring(lon: float, lat: float, ring: List[List[float]]) -> bool:
    inside = False
    n = len(ring)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        intersect = (yi > lat) != (yj > lat) and (
            lon < (xj - xi) * (lat - yi) / ((yj - yi) if (yj - yi) != 0 else 1e-9) + xi
        )
        if intersect:
            inside = not inside
        j = i
    return inside


def point_in_polygon(lon: float, lat: float, rings: List[List[List[float]]]) -> bool:
    if not rings:
        return False
    outer = rings[0]
    if not point_in_ring(lon, lat, outer):
        return False
    # Exclude holes.
    for hole in rings[1:]:
        if point_in_ring(lon, lat, hole):
            return False
    return True


def iter_rings(geometry: dict) -> Iterable[List[List[List[float]]]]:
    gtype = geometry.get("type")
    coords = geometry.get("coordinates") or []
    if gtype == "Polygon":
        yield coords
    elif gtype == "MultiPolygon":
        for poly in coords:
            yield poly


def geometry_bounds(geometry: dict) -> Optional[Tuple[float, float, float, float]]:
    minx = miny = 1e9
    maxx = maxy = -1e9
    found = False
    for rings in iter_rings(geometry or {}):
        for ring in rings:
            for pt in ring:
                if not isinstance(pt, list) or len(pt) < 2:
                    continue
                found = True
                x, y = float(pt[0]), float(pt[1])
                minx = min(minx, x)
                miny = min(miny, y)
                maxx = max(maxx, x)
                maxy = max(maxy, y)
    if not found:
        return None
    return (minx, miny, maxx, maxy)


def is_tri_borough(name: str) -> bool:
    b = (name or "").strip().lower()
    return b in ("manhattan", "brooklyn", "queens")


def split_compound_name(name: str) -> List[str]:
    if not name:
        return []
    tokens = []
    for chunk in name.replace("&", "/").replace(" and ", "/").split("/"):
        for part in chunk.split("-"):
            part = part.strip()
            if part:
                tokens.append(part)
    # De-duplicate while preserving order
    out = []
    seen = set()
    for t in tokens:
        key = t.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(t)
    return out or [name]


_DIR_TOKENS = {"north", "south", "east", "west", "central", "upper", "lower", "mid", "midtown", "downtown"}


def normalize_name_tokens(name: str) -> List[str]:
    if not name:
        return []
    s = name.lower()
    s = s.replace("&", " and ")
    s = re.sub(r"\([^)]*\)", " ", s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\b(st)\b", "saint", s)
    s = re.sub(r"\b(ft)\b", "fort", s)
    tokens = [t for t in s.split() if t and t not in _DIR_TOKENS]
    return tokens


def feature_area(props: dict, geom: dict) -> float:
    # Prefer shape_area if present.
    raw = props.get("shape_area")
    if raw is not None:
        try:
            val = float(str(raw).replace(",", ""))
            if math.isfinite(val) and val > 0:
                return val
        except Exception:
            pass
    # Fallback: approximate from projected bounds.
    bbox = bounds_from_geometry(geom)
    if not bbox:
        return 0.0
    minx, miny, maxx, maxy = bbox
    return abs((maxx - minx) * (maxy - miny))


def load_population_map(raw_geo: dict, csv_path: str) -> Dict[str, float]:
    # Try to read population from geojson first.
    pop: Dict[str, float] = {}
    for idx, feat in enumerate(raw_geo.get("features") or []):
        props = feat.get("properties") or {}
        nid = pick_neighborhood_id(props, idx)
        for k in ("population", "pop", "POPULATION", "POP", "Pop", "TotalPop", "TOTALPOP"):
            if k in props:
                try:
                    v = float(str(props[k]).replace(",", ""))
                    if math.isfinite(v):
                        pop[nid] = v
                        break
                except Exception:
                    pass

    if os.path.exists(csv_path):
        try:
            import csv

            with open(csv_path, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    rid = row.get("atlas_id") or row.get("id") or row.get("nta") or row.get("NTACode")
                    val = row.get("population") or row.get("pop") or row.get("value")
                    if not rid or val is None:
                        continue
                    try:
                        v = float(str(val).replace(",", ""))
                        if math.isfinite(v):
                            pop[str(rid)] = v
                    except Exception:
                        pass
        except Exception:
            pass

    # Fallback: use NTA demographics by name (2010 names) when ids don't match.
    dem_path = os.path.join(os.path.dirname(csv_path), "nta_demographics.csv")
    nta_by_name = {}
    if os.path.exists(dem_path):
        try:
            import csv

            with open(dem_path, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    name = (row.get("Geographic Area - Neighborhood Tabulation Area (NTA)* Name") or "").strip()
                    val = row.get("Total Population 2010 Number") or row.get("Total Population 2000 Number")
                    if not name or val is None:
                        continue
                    try:
                        v = float(str(val).replace(",", ""))
                        if math.isfinite(v):
                            tokens = normalize_name_tokens(name)
                            if tokens:
                                nta_by_name[name] = {"tokens": set(tokens), "pop": v}
                    except Exception:
                        pass
        except Exception:
            nta_by_name = {}

    if nta_by_name:
        # Match each feature name to the closest NTA 2010 name by token overlap.
        matches = {}
        matched_groups = defaultdict(list)
        for idx, feat in enumerate(raw_geo.get("features") or []):
            props = feat.get("properties") or {}
            nid = pick_neighborhood_id(props, idx)
            if nid in pop:
                continue
            name = (
                props.get("ntaname")
                or props.get("name")
                or props.get("label")
                or props.get("neighborhood")
                or ""
            )
            tokens = set(normalize_name_tokens(name))
            if not tokens:
                continue
            best = None
            best_score = 0.0
            for gname, entry in nta_by_name.items():
                inter = len(tokens & entry["tokens"])
                if inter == 0:
                    continue
                score = inter / len(tokens | entry["tokens"])
                if score > best_score:
                    best_score = score
                    best = gname
            if best and best_score >= 0.35:
                area = feature_area(props, feat.get("geometry") or {})
                boro = props.get("boroname") or props.get("borough") or ""
                matches[nid] = best
                matched_groups[best].append({"id": nid, "area": area, "boro": boro})

        # Distribute population across matched features by area share.
        for gname, feats in matched_groups.items():
            total_area = sum(f["area"] for f in feats if f["area"] > 0)
            pop_val = nta_by_name[gname]["pop"]
            for f in feats:
                if f["id"] in pop:
                    continue
                if total_area > 0 and f["area"] > 0:
                    pop[f["id"]] = pop_val * (f["area"] / total_area)
                else:
                    pop[f["id"]] = pop_val / max(1, len(feats))

        # Density fallback by borough for any remaining features.
        boro_density = defaultdict(lambda: {"pop": 0.0, "area": 0.0})
        for idx, feat in enumerate(raw_geo.get("features") or []):
            props = feat.get("properties") or {}
            nid = pick_neighborhood_id(props, idx)
            area = feature_area(props, feat.get("geometry") or {})
            boro = props.get("boroname") or props.get("borough") or ""
            val = pop.get(nid)
            if val is None or area <= 0:
                continue
            boro_density[boro]["pop"] += val
            boro_density[boro]["area"] += area

        overall_pop = sum(v["pop"] for v in boro_density.values())
        overall_area = sum(v["area"] for v in boro_density.values())
        overall_density = overall_pop / overall_area if overall_area > 0 else None

        for idx, feat in enumerate(raw_geo.get("features") or []):
            props = feat.get("properties") or {}
            nid = pick_neighborhood_id(props, idx)
            if nid in pop:
                continue
            area = feature_area(props, feat.get("geometry") or {})
            if area <= 0:
                continue
            boro = props.get("boroname") or props.get("borough") or ""
            density = None
            if boro_density[boro]["area"] > 0:
                density = boro_density[boro]["pop"] / boro_density[boro]["area"]
            elif overall_density is not None:
                density = overall_density
            if density is not None and math.isfinite(density):
                pop[nid] = density * area

    return pop


def load_scalar_csv(csv_path: str, value_keys: List[str]) -> Dict[str, float]:
    if not os.path.exists(csv_path):
        return {}
    values: Dict[str, float] = {}
    try:
        import csv

        with open(csv_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                rid = row.get("atlas_id") or row.get("id") or row.get("nta") or row.get("NTACode") or row.get("nta2020")
                if not rid:
                    continue
                val = None
                for k in value_keys:
                    if row.get(k) is not None:
                        val = row.get(k)
                        break
                if val is None:
                    continue
                try:
                    v = float(str(val).replace(",", ""))
                    if math.isfinite(v):
                        values[str(rid)] = v
                except Exception:
                    continue
    except Exception:
        return values
    return values


def main() -> int:
    ap = argparse.ArgumentParser(description="Build micro-units and derived neighborhoods.")
    ap.add_argument("--neighborhoods", required=True, help="Path to neighborhoods GeoJSON (tracts/NTAs)")
    ap.add_argument("--graph", required=True, help="Path to graph_weekday_am.json (for stops list)")
    ap.add_argument("--matrix-dir", required=True, help="Directory with matrix_<profile>.json outputs")
    ap.add_argument("--out", required=True, help="Output directory (site/data)")
    ap.add_argument("--grid-step", type=float, default=0.004, help="Grid cell size in degrees")
    ap.add_argument(
        "--profiles",
        default="weekday_am,weekday_pm,weekend",
        help="Comma-separated profiles to build derived matrices for",
    )
    args = ap.parse_args()

    out_dir = args.out
    os.makedirs(out_dir, exist_ok=True)

    with open(args.neighborhoods, "r", encoding="utf-8") as f:
        raw_geo = json.load(f)

    features = raw_geo.get("features") or []
    if not features:
        print("Neighborhoods GeoJSON has no features", file=sys.stderr)
        return 2

    # Gazetteer polygons (optional).
    gazetteer_path = os.path.join(os.path.dirname(args.neighborhoods), "neighborhoods_gazetteer.geojson")
    gazetteer = None
    if os.path.exists(gazetteer_path):
        try:
            with open(gazetteer_path, "r", encoding="utf-8") as f:
                gazetteer = json.load(f)
        except Exception:
            gazetteer = None
    else:
        print("TODO: add data/raw/neighborhoods_gazetteer.geojson for authoritative names.", file=sys.stderr)

    # Load stops list from graph for station anchors.
    with open(args.graph, "r", encoding="utf-8") as f:
        graph = json.load(f)
    stops = graph.get("stops") or []

    stations: Dict[str, dict] = {}
    for st in stops:
        sid = st.get("parent_station") or st.get("id")
        if not sid:
            continue
        if sid not in stations:
            stations[sid] = {
                "id": sid,
                "name": st.get("name") or sid,
                "lat": float(st.get("lat")),
                "lon": float(st.get("lon")),
            }
    station_list = list(stations.values())
    if not station_list:
        print("No stations found in graph", file=sys.stderr)
        return 2

    # Build tract list with bounds.
    tracts = []
    for idx, feat in enumerate(features):
        props = feat.get("properties") or {}
        nid = pick_neighborhood_id(props, idx)
        name = pick_neighborhood_name(props) or nid
        borough = pick_neighborhood_borough(props)
        if not is_tri_borough(borough):
            continue
        geom = feat.get("geometry") or {}
        bounds = geometry_bounds(geom)
        if not bounds:
            continue
        tracts.append(
            {
                "id": nid,
                "name": name,
                "borough": borough,
                "geometry": geom,
                "bounds": bounds,
            }
        )

    if not tracts:
        print("No tri-borough tracts found", file=sys.stderr)
        return 2

    # Global bounds for grid.
    minx = min(t["bounds"][0] for t in tracts)
    miny = min(t["bounds"][1] for t in tracts)
    maxx = max(t["bounds"][2] for t in tracts)
    maxy = max(t["bounds"][3] for t in tracts)

    step = float(args.grid_step)
    cols = int(math.ceil((maxx - minx) / step))
    rows = int(math.ceil((maxy - miny) / step))

    def cell_bounds(col, row):
        lon0 = minx + col * step
        lat0 = miny + row * step
        return lon0, lat0, lon0 + step, lat0 + step

    sample_offsets = [0.2, 0.5, 0.8]
    sample_points = [(ox, oy) for ox in sample_offsets for oy in sample_offsets]

    # Assign grid cells to tracts with area coverage fraction.
    cells: Dict[Tuple[int, int], dict] = {}
    for tract in tracts:
        tb = tract["bounds"]
        col0 = max(0, int(math.floor((tb[0] - minx) / step)))
        col1 = min(cols - 1, int(math.floor((tb[2] - minx) / step)))
        row0 = max(0, int(math.floor((tb[1] - miny) / step)))
        row1 = min(rows - 1, int(math.floor((tb[3] - miny) / step)))
        rings_list = list(iter_rings(tract["geometry"]))
        if not rings_list:
            continue

        for col in range(col0, col1 + 1):
            for row in range(row0, row1 + 1):
                lon0, lat0, lon1, lat1 = cell_bounds(col, row)
                inside = 0
                for ox, oy in sample_points:
                    lon = lon0 + (lon1 - lon0) * ox
                    lat = lat0 + (lat1 - lat0) * oy
                    hit = False
                    for rings in rings_list:
                        if point_in_polygon(lon, lat, rings):
                            hit = True
                            break
                    if hit:
                        inside += 1
                frac = inside / float(len(sample_points))
                if frac <= 0:
                    continue
                key = (col, row)
                cell = cells.get(key)
                if cell is None or frac > cell.get("coverage", 0):
                    # keep dominant tract assignment
                    cells[key] = {
                        "col": col,
                        "row": row,
                        "bounds": (lon0, lat0, lon1, lat1),
                        "coverage": frac,
                        "tract_id": tract["id"],
                        "tract_name": tract["name"],
                        "borough": tract["borough"],
                    }

    if not cells:
        print("No micro-units created", file=sys.stderr)
        return 2

    scalar_dir = os.path.dirname(args.neighborhoods)
    pop_map = load_population_map(raw_geo, os.path.join(scalar_dir, "scalars_population.csv"))
    scalar_maps: Dict[str, Dict[str, float]] = {"population": pop_map}
    housing_map = load_scalar_csv(os.path.join(scalar_dir, "scalars_housing_units.csv"), ["housing_units", "value"])
    if housing_map:
        scalar_maps["housing_units"] = housing_map
    jobs_map = load_scalar_csv(os.path.join(scalar_dir, "scalars_jobs.csv"), ["jobs", "value"])
    if jobs_map:
        scalar_maps["jobs"] = jobs_map

    # Stamp scalars into the base neighborhoods GeoJSON used by the site.
    base_geo_out = os.path.join(out_dir, "neighborhoods.geojson")
    if scalar_maps and os.path.exists(base_geo_out):
        try:
            with open(base_geo_out, "r", encoding="utf-8") as f:
                base_geo = json.load(f)
            updated = False
            for idx, feat in enumerate(base_geo.get("features") or []):
                props = feat.get("properties") or {}
                nid = str(props.get("atlas_id") or pick_neighborhood_id(props, idx))
                scalars = props.get("scalars") or {}
                for key, smap in scalar_maps.items():
                    if nid in smap:
                        scalars[key] = smap[nid]
                        updated = True
                if scalars:
                    props["scalars"] = scalars
                    feat["properties"] = props
            if updated:
                with open(base_geo_out, "w", encoding="utf-8") as f:
                    json.dump(base_geo, f)
        except Exception:
            pass

    # Compute tract total coverage area.
    tract_area = defaultdict(float)
    cell_area_km2 = {}
    for key, cell in cells.items():
        lon0, lat0, lon1, lat1 = cell["bounds"]
        lat_c = (lat0 + lat1) * 0.5
        km_lat = 111.32 * (lat1 - lat0)
        km_lon = 111.32 * math.cos(math.radians(lat_c)) * (lon1 - lon0)
        area = abs(km_lat * km_lon)
        cell_area_km2[key] = area
        tract_area[cell["tract_id"]] += area * cell["coverage"]

    # Assign stations to cells.
    def nearest_station(lat, lon):
        best = None
        best_d = None
        for st in station_list:
            d = haversine_km(lat, lon, st["lat"], st["lon"])
            if best_d is None or d < best_d:
                best_d = d
                best = st
        return best

    micro_features = []
    region_cells: Dict[str, List[dict]] = defaultdict(list)
    region_stats = defaultdict(lambda: {"area": 0.0, "centroid_x": 0.0, "centroid_y": 0.0, "tract_weights": defaultdict(float)})

    for (col, row), cell in cells.items():
        lon0, lat0, lon1, lat1 = cell["bounds"]
        lat_c = (lat0 + lat1) * 0.5
        lon_c = (lon0 + lon1) * 0.5
        area = cell_area_km2[(col, row)] * cell["coverage"]
        tract_id = cell["tract_id"]
        station = nearest_station(lat_c, lon_c)
        station_id = station["id"]
        station_name = station["name"]
        region_id = f"station-{slugify(station_name)}-{station_id}"

        # Scalar redistribution (population, housing units, jobs).
        scalars = {}
        for key, smap in scalar_maps.items():
            val = smap.get(tract_id)
            if val is not None and tract_area[tract_id] > 0:
                scalars[key] = val * (area / tract_area[tract_id])

        props = {
            "atlas_id": f"cell-{col}-{row}",
            "micro_id": f"cell-{col}-{row}",
            "tract_id": tract_id,
            "tract_name": cell["tract_name"],
            "borough": cell["borough"],
            "coverage": round(cell["coverage"], 4),
            "area_km2": round(area, 6),
            "station_id": station_id,
            "station_name": station_name,
            "scalars": scalars,
        }
        poly = [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]]
        micro_features.append({"type": "Feature", "properties": props, "geometry": {"type": "Polygon", "coordinates": poly}})

        region_cells[region_id].append(
            {
                "bounds": (lon0, lat0, lon1, lat1),
                "area": area,
                "lat": lat_c,
                "lon": lon_c,
                "tract_id": tract_id,
                "borough": cell["borough"],
                "station_id": station_id,
                "station_name": station_name,
                "scalars": scalars,
                "tract_name": cell["tract_name"],
            }
        )
        stats = region_stats[region_id]
        stats["area"] += area
        stats["centroid_x"] += lon_c * area
        stats["centroid_y"] += lat_c * area
        stats["tract_weights"][tract_id] += area

    # Gazetteer overlaps (if available) by sampling micro-unit centroids.
    gazetteer_entries = []
    if gazetteer:
        for feat in gazetteer.get("features") or []:
            props = feat.get("properties") or {}
            name = (
                props.get("name")
                or props.get("ntaname")
                or props.get("cdtaname")
                or props.get("neighborhood")
                or props.get("label")
            )
            gid = props.get("id") or props.get("nta2020") or props.get("cdta2020") or props.get("gid")
            boro = props.get("boro") or props.get("boroname") or props.get("borough") or props.get("borocode")
            if not name:
                continue
            geom = feat.get("geometry") or {}
            gazetteer_entries.append(
                {
                    "gid": str(gid) if gid is not None else "",
                    "gname": str(name),
                    "boro": str(boro) if boro is not None else "",
                    "geom": geom,
                }
            )

    def gazetteer_name_for_point(lon, lat):
        if not gazetteer_entries:
            return None
        for entry in gazetteer_entries:
            geom = entry.get("geom") or {}
            for rings in iter_rings(geom):
                if point_in_polygon(lon, lat, rings):
                    return entry.get("gname")
        return None

    region_gazetteer = defaultdict(lambda: defaultdict(float))
    if gazetteer_entries:
        for region_id, cells_list in region_cells.items():
            for cell in cells_list:
                name = gazetteer_name_for_point(cell["lon"], cell["lat"])
                if name:
                    region_gazetteer[region_id][name] += cell["area"]

    # Build derived regions.
    derived_features = []
    derived_regions = []

    def add_alias(region, alias):
        if not alias:
            return
        aliases = [a for a in (region.get("aliases") or []) if a and a != alias]
        region["aliases"] = [alias] + aliases

    def normalize_name_key(name):
        return (name or "").strip().lower()

    def compass_label(lat, lon, slat, slon):
        if lat is None or lon is None or slat is None or slon is None:
            return None
        if not all(map(math.isfinite, [lat, lon, slat, slon])):
            return None
        dx = lon - slon
        dy = lat - slat
        if abs(dx) < 1e-6 and abs(dy) < 1e-6:
            return None
        angle = math.degrees(math.atan2(dy, dx))
        dirs = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"]
        idx = int(((angle + 22.5) % 360) // 45)
        return dirs[idx]
    for region_id, cells_list in region_cells.items():
        stats = region_stats[region_id]
        area = stats["area"]
        if area <= 0:
            continue
        lon_c = stats["centroid_x"] / area
        lat_c = stats["centroid_y"] / area

        station_name = cells_list[0]["station_name"]
        station_id = cells_list[0]["station_id"]
        station_info = stations.get(station_id) if station_id else None
        station_lat = station_info.get("lat") if station_info else None
        station_lon = station_info.get("lon") if station_info else None

        # Choose borough by dominant tract weight.
        borough_weights = defaultdict(float)
        for cell in cells_list:
            borough_weights[cell["borough"]] += cell["area"]
        borough = max(borough_weights.items(), key=lambda x: x[1])[0]

        # Naming.
        aliases = []
        confidence = 0.2
        primary = None

        if region_gazetteer.get(region_id):
            total = sum(region_gazetteer[region_id].values())
            ranked = sorted(region_gazetteer[region_id].items(), key=lambda x: -x[1])
            top_name, top_area = ranked[0]
            top_frac = top_area / total if total else 0
            # If the gazetteer name is a compound (e.g., A-B-C) and the station
            # matches one of the parts, prefer the station-aligned part to
            # preserve finer-grain naming.
            parts = split_compound_name(top_name)
            station_tokens = set(normalize_name_tokens(station_name))
            matched_part = None
            if len(parts) > 1 and station_tokens:
                best_score = 0.0
                for part in parts:
                    part_tokens = set(normalize_name_tokens(part))
                    if not part_tokens:
                        continue
                    inter = len(station_tokens & part_tokens)
                    if inter == 0:
                        continue
                    score = inter / len(part_tokens)
                    if score > best_score:
                        best_score = score
                        matched_part = part
                if matched_part and best_score >= 0.5:
                    primary = matched_part
                    confidence = max(top_frac, 0.35)
                    aliases = [top_name] + [n for n, _ in ranked[1:4] if n != top_name]
            if not primary and top_frac >= 0.5:
                primary = top_name
                confidence = top_frac
                aliases = [n for n, _ in ranked[1:4]]
            elif not primary and len(ranked) > 1 and top_frac >= 0.25 and (ranked[1][1] / total) >= 0.25:
                primary = f"{top_name} / {ranked[1][0]}"
                confidence = top_frac
                aliases = [n for n, _ in ranked[2:4]]
        if not primary:
            # Try to derive from tract compound name if it contains station name.
            tract_name = cells_list[0]["tract_name"]
            parts = split_compound_name(tract_name)
            best_part = None
            for p in parts:
                if p.lower() in station_name.lower():
                    best_part = p
                    break
            if best_part:
                primary = best_part
                confidence = 0.35
                aliases = [tract_name]
            else:
                primary = f"{station_name} area"
                confidence = 0.2
                aliases = [station_name, tract_name]

        # Derived region scalars (sum of micro scalars).
        scalars = defaultdict(float)
        for cell in cells_list:
            for k, v in (cell.get("scalars") or {}).items():
                scalars[k] += v

        # Build geometry as a MultiPolygon of grid cells.
        polys = []
        for cell in cells_list:
            lon0, lat0, lon1, lat1 = cell["bounds"]
            poly = [[ [lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0] ]]
            polys.append(poly)

        # Tract weights (normalized).
        tw = stats["tract_weights"]
        total_tw = sum(tw.values())
        tract_weights = {k: (v / total_tw) for k, v in tw.items()} if total_tw else {}
        rep_tract = max(tw.items(), key=lambda x: x[1])[0] if tw else None

        props = {
            "atlas_id": region_id,
            "primary_name": primary,
            "name": primary,
            "aliases": aliases,
            "name_confidence": round(float(confidence), 3),
            "borough": borough,
            "anchor_station": station_name,
            "station_id": station_id,
            "anchor_station_lat": station_lat,
            "anchor_station_lon": station_lon,
            "representative_tract_id": rep_tract,
            "tract_weights": tract_weights,
            "scalars": dict(scalars),
        }
        derived_features.append(
            {"type": "Feature", "properties": props, "geometry": {"type": "MultiPolygon", "coordinates": polys}}
        )

        derived_regions.append(
            {
                "id": region_id,
                "name": primary,
                "borough": borough,
                "centroid": [lat_c, lon_c],
                "name_confidence": round(float(confidence), 3),
                "aliases": aliases,
                "anchor_station": station_name,
                "anchor_station_lat": station_lat,
                "anchor_station_lon": station_lon,
                "representative_tract_id": rep_tract,
                "tract_weights": tract_weights,
            }
        )

    # Disambiguate duplicate names by appending anchor station.
    name_counts = defaultdict(int)
    for region in derived_regions:
        key = normalize_name_key(region.get("name"))
        if key:
            name_counts[key] += 1

    for region in derived_regions:
        name = region.get("name") or ""
        key = normalize_name_key(name)
        if not key or name_counts.get(key, 0) <= 1:
            continue
        station = region.get("anchor_station") or ""
        if not station:
            continue
        new_name = f"{name} · {station}"
        add_alias(region, name)
        region["name"] = new_name

    # If duplicates remain, add a directional suffix relative to the anchor station.
    name_counts = defaultdict(int)
    for region in derived_regions:
        key = normalize_name_key(region.get("name"))
        if key:
            name_counts[key] += 1

    for region in derived_regions:
        name = region.get("name") or ""
        key = normalize_name_key(name)
        if not key or name_counts.get(key, 0) <= 1:
            continue
        c = region.get("centroid") or [None, None]
        lat = c[0] if len(c) > 0 else None
        lon = c[1] if len(c) > 1 else None
        dir_label = compass_label(
            lat,
            lon,
            region.get("anchor_station_lat"),
            region.get("anchor_station_lon"),
        )
        if not dir_label:
            continue
        new_name = f"{name} · {dir_label}"
        add_alias(region, name)
        region["name"] = new_name

    # Final fallback: numeric suffix to ensure uniqueness.
    groups = defaultdict(list)
    for region in derived_regions:
        key = normalize_name_key(region.get("name"))
        if key:
            groups[key].append(region)

    for group in groups.values():
        if len(group) <= 1:
            continue
        group.sort(key=lambda r: r.get("id") or "")
        for idx, region in enumerate(group, start=1):
            name = region.get("name") or ""
            new_name = f"{name} · {idx}"
            add_alias(region, name)
            region["name"] = new_name

    region_by_id = {r["id"]: r for r in derived_regions}
    for feat in derived_features:
        props = feat.get("properties") or {}
        rid = props.get("atlas_id")
        if not rid or rid not in region_by_id:
            continue
        reg = region_by_id[rid]
        props["primary_name"] = reg.get("name")
        props["name"] = reg.get("name")
        props["aliases"] = reg.get("aliases", [])
        feat["properties"] = props

    micro_out = os.path.join(out_dir, "micro_units.geojson")
    with open(micro_out, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": micro_features}, f)
    print(f"Wrote {micro_out}", file=sys.stderr)

    derived_out = os.path.join(out_dir, "derived_regions.geojson")
    with open(derived_out, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": derived_features}, f)
    print(f"Wrote {derived_out}", file=sys.stderr)

    # Build derived matrices per profile.
    profiles = [p.strip() for p in args.profiles.split(",") if p.strip()]
    teleport_report = {}
    for profile in profiles:
        graph_path = os.path.join(args.matrix_dir, f"graph_{profile}.json")
        matrix_path = os.path.join(args.matrix_dir, f"matrix_{profile}.json")
        if not os.path.exists(graph_path) or not os.path.exists(matrix_path):
            print(f"Missing {profile} inputs; skipping derived outputs", file=sys.stderr)
            continue
        with open(graph_path, "r", encoding="utf-8") as f:
            graph = json.load(f)
        with open(matrix_path, "r", encoding="utf-8") as f:
            matrix = json.load(f)

        tracts_list = graph.get("neighborhoods") or []
        tract_idx = {str(n.get("id")): i for i, n in enumerate(tracts_list)}
        minutes = matrix.get("minutes") or []
        first_route = matrix.get("first_route") or []
        routes = matrix.get("routes") or []

        # Prepare region weights indexed to tract indices.
        region_weights = []
        rep_indices = []
        for region in derived_regions:
            tw = region.get("tract_weights") or {}
            weights = []
            total = 0.0
            for tid, w in tw.items():
                idx = tract_idx.get(str(tid))
                if idx is None:
                    continue
                weights.append((idx, float(w)))
                total += float(w)
            if total > 0:
                weights = [(i, w / total) for i, w in weights]
            region_weights.append(weights)
            rep_tid = region.get("representative_tract_id")
            rep_indices.append(tract_idx.get(str(rep_tid)) if rep_tid else None)

        # Precompute weighted-to-tract rows.
        T = len(tracts_list)
        R = len(derived_regions)
        row_avg = []
        for wlist in region_weights:
            row = [None] * T
            for j in range(T):
                num = 0.0
                den = 0.0
                for i, w in wlist:
                    try:
                        m = minutes[i][j]
                    except Exception:
                        m = None
                    if m is None:
                        continue
                    num += w * float(m)
                    den += w
                row[j] = None if den == 0 else num / den
            row_avg.append(row)

        derived_minutes = []
        for r in range(R):
            row = []
            for s in range(R):
                num = 0.0
                den = 0.0
                for j, w in region_weights[s]:
                    m = row_avg[r][j]
                    if m is None:
                        continue
                    num += w * float(m)
                    den += w
                row.append(None if den == 0 else int(round(num / den)))
            derived_minutes.append(row)

        derived_first_route = []
        for r in range(R):
            row = []
            rep_r = rep_indices[r]
            for s in range(R):
                rep_s = rep_indices[s]
                if rep_r is None or rep_s is None:
                    row.append(None)
                else:
                    try:
                        row.append(first_route[rep_r][rep_s])
                    except Exception:
                        row.append(None)
            derived_first_route.append(row)

        # Centrality metrics.
        harmonic_scores = [harmonic_centrality_from_minutes_row(r) for r in derived_minutes]
        median_scores = [median_minutes_from_row(r) for r in derived_minutes]
        tp_metric = matrix.get("centrality", {}).get("metrics", {}).get("transfer_penalized", {})
        tp_scores = tp_metric.get("scores") or []
        tp_penalty = tp_metric.get("transfer_penalty_minutes")

        derived_tp_scores = []
        for wlist in region_weights:
            num = 0.0
            den = 0.0
            for i, w in wlist:
                if i >= len(tp_scores):
                    continue
                v = tp_scores[i]
                if v is None:
                    continue
                num += w * float(v)
                den += w
            derived_tp_scores.append(round(num / den, 6) if den else None)

        derived_matrix = {
            "generated_at": matrix.get("generated_at") or dt.datetime.now(dt.timezone.utc).isoformat(),
            "window": matrix.get("window"),
            "neighborhoods": derived_regions,
            "routes": routes,
            "minutes": derived_minutes,
            "first_route": derived_first_route,
            "centrality": {
                "default": "harmonic",
                "metrics": {
                    "harmonic": {
                        "label": "Harmonic",
                        "higher_is_better": True,
                        "scores": [round(s, 6) for s in harmonic_scores],
                    },
                    "median_minutes": {
                        "label": "Median minutes",
                        "higher_is_better": False,
                        "scores": [round(float(s), 3) if s is not None else None for s in median_scores],
                    },
                    "transfer_penalized": {
                        "label": "Transfer-penalized",
                        "higher_is_better": True,
                        "transfer_penalty_minutes": tp_penalty,
                        "scores": derived_tp_scores,
                    },
                },
            },
        }

        out_matrix_path = os.path.join(out_dir, f"matrix_{profile}_derived.json")
        with open(out_matrix_path, "w", encoding="utf-8") as f:
            json.dump(derived_matrix, f)
        print(f"Wrote {out_matrix_path}", file=sys.stderr)

        # Build derived graph (reuse stops/routes/edges).
        derived_neighborhoods = []
        stops_list = graph.get("stops") or []
        for region in derived_regions:
            lat, lon = region["centroid"]
            # Nearest stop to centroid.
            best = None
            best_d = None
            for st in stops_list:
                d = haversine_km(lat, lon, st["lat"], st["lon"])
                if best_d is None or d < best_d:
                    best_d = d
                    best = st
            derived_neighborhoods.append(
                {
                    "id": region["id"],
                    "name": region["name"],
                    "borough": region["borough"],
                    "centroid": region["centroid"],
                    "stop_id": best["id"] if best else None,
                    "name_confidence": region.get("name_confidence"),
                    "aliases": region.get("aliases", []),
                    "anchor_station": region.get("anchor_station"),
                }
            )

        derived_graph = dict(graph)
        derived_graph["neighborhoods"] = derived_neighborhoods
        out_graph_path = os.path.join(out_dir, f"graph_{profile}_derived.json")
        with open(out_graph_path, "w", encoding="utf-8") as f:
            json.dump(derived_graph, f)
        print(f"Wrote {out_graph_path}", file=sys.stderr)

        teleport_report[profile] = {
            "window": derived_matrix.get("window"),
            **compute_hub_corridors(
                neighborhoods=derived_neighborhoods,
                minutes=derived_minutes,
                first_route=derived_first_route,
                routes=routes,
                centrality_scores=harmonic_scores,
            ),
        }

    if teleport_report:
        teleport_out_path = os.path.join(out_dir, "teleport_corridors_derived.json")
        with open(teleport_out_path, "w", encoding="utf-8") as f:
            json.dump({"generated_at": dt.datetime.now(dt.timezone.utc).isoformat(), "windows": teleport_report}, f)
        print(f"Wrote {teleport_out_path}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
