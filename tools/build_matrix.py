#!/usr/bin/env python3

import argparse
from collections import Counter
import csv
import datetime as dt
import heapq
import json
import math
import os
import statistics
import sys
import zipfile
from typing import Dict, List, Optional, Set, Tuple


def parse_gtfs_time_to_seconds(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    parts = value.split(":")
    if len(parts) != 3:
        return None
    try:
        h = int(parts[0])
        m = int(parts[1])
        s = int(parts[2])
    except ValueError:
        return None
    if m < 0 or m >= 60 or s < 0 or s >= 60 or h < 0:
        return None
    return h * 3600 + m * 60 + s


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    r = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def centroid_latlon(feature) -> Optional[Tuple[float, float]]:
    geom = (feature or {}).get("geometry") or {}
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if not coords:
        return None

    points = []

    def add_points_from_polygon(poly):
        # poly: [ [ [lon,lat], ... ] outer ring, ... holes ...]
        for ring in poly:
            for xy in ring:
                if not isinstance(xy, list) or len(xy) < 2:
                    continue
                points.append((xy[1], xy[0]))

    if gtype == "Polygon":
        add_points_from_polygon(coords)
    elif gtype == "MultiPolygon":
        for poly in coords:
            add_points_from_polygon(poly)
    elif gtype == "Point":
        if isinstance(coords, list) and len(coords) >= 2:
            return (coords[1], coords[0])
    else:
        return None

    if not points:
        return None
    lat = sum(p[0] for p in points) / len(points)
    lon = sum(p[1] for p in points) / len(points)
    return (lat, lon)


def slugify(value: str) -> str:
    out = []
    for ch in (value or "").strip().lower():
        if ch.isalnum():
            out.append(ch)
        elif ch in (" ", "-", "_", "/", "."):
            if out and out[-1] != "-":
                out.append("-")
    s = "".join(out).strip("-")
    return s or "neighborhood"


def gtfs_open_csv(zf: zipfile.ZipFile, name: str):
    with zf.open(name, "r") as f:
        # GTFS is usually UTF-8, but some feeds can have BOM.
        text = (line.decode("utf-8-sig") for line in f)
        reader = csv.DictReader(text)
        for row in reader:
            yield row


def detect_weekday_service_ids(zf: zipfile.ZipFile) -> Optional[Set[str]]:
    if "calendar.txt" not in zf.namelist():
        return None
    weekday = set()
    for row in gtfs_open_csv(zf, "calendar.txt"):
        try:
            if (
                row.get("monday") == "1"
                and row.get("tuesday") == "1"
                and row.get("wednesday") == "1"
                and row.get("thursday") == "1"
                and row.get("friday") == "1"
                and row.get("saturday") == "0"
                and row.get("sunday") == "0"
            ):
                sid = row.get("service_id")
                if sid:
                    weekday.add(sid)
        except Exception:
            continue
    return weekday


def detect_weekend_service_ids(zf: zipfile.ZipFile) -> Optional[Set[str]]:
    if "calendar.txt" not in zf.namelist():
        return None
    weekend = set()
    for row in gtfs_open_csv(zf, "calendar.txt"):
        try:
            sat = row.get("saturday") == "1"
            sun = row.get("sunday") == "1"
            wk = (
                row.get("monday") == "1"
                or row.get("tuesday") == "1"
                or row.get("wednesday") == "1"
                or row.get("thursday") == "1"
                or row.get("friday") == "1"
            )
            if (sat or sun) and not wk:
                sid = row.get("service_id")
                if sid:
                    weekend.add(sid)
        except Exception:
            continue
    return weekend


def load_routes(zf: zipfile.ZipFile) -> Dict[str, dict]:
    routes: Dict[str, dict] = {}
    if "routes.txt" not in zf.namelist():
        return routes
    for row in gtfs_open_csv(zf, "routes.txt"):
        rid = row.get("route_id")
        if not rid:
            continue
        short = (row.get("route_short_name") or "").strip()
        long_name = (row.get("route_long_name") or "").strip()
        color = (row.get("route_color") or "").strip()
        text_color = (row.get("route_text_color") or "").strip()
        routes[rid] = {
            "id": rid,
            "short_name": short or long_name or rid,
            "color": f"#{color}" if color and not color.startswith("#") else (color or None),
            "text_color": f"#{text_color}" if text_color and not text_color.startswith("#") else (text_color or None),
        }
    return routes


def load_trips_for_services(zf: zipfile.ZipFile, service_ids: Optional[Set[str]]) -> Optional[Set[str]]:
    if service_ids is None:
        return None
    if len(service_ids) == 0:
        return None
    allowed: Set[str] = set()
    for row in gtfs_open_csv(zf, "trips.txt"):
        sid = row.get("service_id")
        tid = row.get("trip_id")
        if not tid:
            continue
        if service_ids is None or (sid in service_ids):
            allowed.add(tid)
    return allowed


def load_trip_routes(zf: zipfile.ZipFile, allowed_trips: Optional[Set[str]]) -> Dict[str, str]:
    trip_routes: Dict[str, str] = {}
    for row in gtfs_open_csv(zf, "trips.txt"):
        tid = row.get("trip_id")
        rid = row.get("route_id")
        if not tid or not rid:
            continue
        if allowed_trips is not None and tid not in allowed_trips:
            continue
        trip_routes[tid] = rid
    return trip_routes


def load_stops(zf: zipfile.ZipFile):
    stops = {}
    parent_to_children = {}
    for row in gtfs_open_csv(zf, "stops.txt"):
        stop_id = row.get("stop_id")
        if not stop_id:
            continue
        try:
            lat = float(row.get("stop_lat"))
            lon = float(row.get("stop_lon"))
        except Exception:
            continue
        parent = (row.get("parent_station") or "").strip() or None
        stops[stop_id] = {
            "stop_id": stop_id,
            "stop_name": row.get("stop_name") or stop_id,
            "stop_lat": lat,
            "stop_lon": lon,
            "parent_station": parent,
        }
        if parent:
            parent_to_children.setdefault(parent, []).append(stop_id)
    return stops, parent_to_children


def median_int(values: list[int]) -> int:
    if not values:
        raise ValueError("median of empty list")
    if len(values) == 1:
        return int(values[0])
    return int(statistics.median(values))


def harmonic_centrality_from_minutes_row(row: List[Optional[int]]) -> float:
    score = 0.0
    for m in row:
        if m is None:
            continue
        if m <= 0:
            continue
        score += 1.0 / float(m)
    return score


def median_minutes_from_row(row: List[Optional[int]]) -> Optional[float]:
    values: List[int] = []
    for m in row:
        if m is None:
            continue
        if m <= 0:
            continue
        values.append(int(m))
    if not values:
        return None
    values.sort()
    n = len(values)
    if n % 2 == 1:
        return float(values[n // 2])
    return (values[n // 2 - 1] + values[n // 2]) / 2.0


def point_in_poly(lat: float, lon: float, poly_lonlat: List[Tuple[float, float]]) -> bool:
    # Ray casting; poly is list of (lon,lat).
    inside = False
    n = len(poly_lonlat)
    if n < 3:
        return False
    x = lon
    y = lat
    for i in range(n):
        x1, y1 = poly_lonlat[i]
        x2, y2 = poly_lonlat[(i + 1) % n]
        if ((y1 > y) != (y2 > y)) and (x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1):
            inside = not inside
    return inside


def is_manhattan_centroid(lat: float, lon: float) -> bool:
    # Coarse Manhattan island outline (sufficient for excluding most Manhattan NTAs without borough metadata).
    poly = [
        (-74.018, 40.701),
        (-74.015, 40.720),
        (-74.010, 40.740),
        (-74.004, 40.760),
        (-73.998, 40.780),
        (-73.986, 40.800),
        (-73.962, 40.835),
        (-73.944, 40.868),
        (-73.928, 40.880),
        (-73.922, 40.868),
        (-73.928, 40.835),
        (-73.940, 40.805),
        (-73.948, 40.780),
        (-73.957, 40.755),
        (-73.970, 40.735),
        (-73.985, 40.720),
        (-74.005, 40.705),
    ]
    return point_in_poly(lat, lon, poly)


def is_staten_island_centroid(lat: float, lon: float) -> bool:
    # Coarse Staten Island rectangle; used to exclude SI corridors for the tri-borough focus.
    poly = [
        (-74.255, 40.510),
        (-74.255, 40.650),
        (-74.070, 40.650),
        (-74.070, 40.510),
    ]
    return point_in_poly(lat, lon, poly)


def is_bronx_centroid(lat: float, lon: float) -> bool:
    # Coarse Bronx rectangle; used to exclude Bronx corridors for the tri-borough focus.
    poly = [
        (-73.935, 40.785),
        (-73.935, 40.915),
        (-73.765, 40.915),
        (-73.765, 40.785),
    ]
    return point_in_poly(lat, lon, poly)


def find_best_hub_index(
    *,
    neighborhoods: List[dict],
    centrality_scores: List[float],
    lat_min: float,
    lat_max: float,
    lon_min: float,
    lon_max: float,
) -> Optional[int]:
    best = None
    best_score = None
    for i, n in enumerate(neighborhoods):
        c = n.get("centroid")
        if not isinstance(c, list) or len(c) < 2:
            continue
        lat = float(c[0])
        lon = float(c[1])
        if not (lat_min <= lat <= lat_max and lon_min <= lon <= lon_max):
            continue
        s = centrality_scores[i] if i < len(centrality_scores) else None
        if s is None or not math.isfinite(s):
            continue
        if best_score is None or s > best_score:
            best_score = s
            best = i
    return best


def find_nearest_centroid_index(
    *,
    neighborhoods: List[dict],
    anchor_lat: float,
    anchor_lon: float,
) -> Optional[int]:
    best = None
    best_d = None
    for i, n in enumerate(neighborhoods):
        c = n.get("centroid")
        if not isinstance(c, list) or len(c) < 2:
            continue
        lat = float(c[0])
        lon = float(c[1])
        d = haversine_m(lat, lon, anchor_lat, anchor_lon)
        if best_d is None or d < best_d:
            best_d = d
            best = i
    return best


def compute_hub_corridors(
    *,
    neighborhoods: List[dict],
    minutes: List[List[Optional[int]]],
    first_route: List[List[Optional[int]]],
    routes: List[dict],
    centrality_scores: List[float],
    max_minutes: int = 180,
    top_n: int = 180,
    expected_speed_km_per_min: float = 0.25,  # ~15 km/h
) -> dict:
    centroids: List[Optional[Tuple[float, float]]] = []
    for n in neighborhoods:
        c = n.get("centroid")
        if not isinstance(c, list) or len(c) < 2:
            centroids.append(None)
        else:
            centroids.append((float(c[0]), float(c[1])))  # lat, lon

    route_short = [r.get("short_name") or r.get("id") for r in routes]

    # Hub anchors (lat,lon): pick the nearest neighborhood centroid to each anchor.
    # This avoids brittle bbox assumptions and prevents "undefined" hubs in the UI.
    hubs_cfg = [
        ("midtown", "Midtown", 40.754, -73.984),
        ("downtown", "Downtown", 40.707, -74.011),
        ("williamsburg", "Williamsburg", 40.711, -73.958),
        ("downtown_bk", "Downtown BK", 40.692, -73.985),
        ("lic", "LIC", 40.744, -73.949),
        ("hudson_yards", "Hudson Yards", 40.754, -74.002),
        ("greenpoint", "Greenpoint", 40.729, -73.955),
        ("bushwick", "Bushwick", 40.695, -73.918),
        ("astoria", "Astoria", 40.764, -73.923),
    ]

    hubs = {}
    hub_indices = {}
    for key, label, alat, alon in hubs_cfg:
        idx = find_nearest_centroid_index(neighborhoods=neighborhoods, anchor_lat=alat, anchor_lon=alon)
        if idx is None:
            continue
        hub_indices[key] = idx
        hubs[key] = {
            "key": key,
            "label": label,
            "id": neighborhoods[idx].get("id"),
            "name": neighborhoods[idx].get("name"),
            "centroid": neighborhoods[idx].get("centroid"),
        }

    def dist_km_to_hub(i: int, hub_i: int) -> Optional[float]:
        ci = centroids[i]
        ch = centroids[hub_i]
        if ci is None or ch is None:
            return None
        return haversine_m(ci[0], ci[1], ch[0], ch[1]) / 1000.0

    def mk_entry(origin_i: int, hub_key: str, hub_i: int) -> Optional[dict]:
        m = minutes[origin_i][hub_i]
        if m is None or m <= 0 or m > max_minutes:
            return None
        dkm = dist_km_to_hub(origin_i, hub_i)
        if dkm is None or not math.isfinite(dkm):
            return None
        ridx = first_route[origin_i][hub_i]
        first_line = None
        if ridx is not None and 0 <= ridx < len(route_short):
            first_line = route_short[ridx]
        km_per_min = dkm / float(m) if m > 0 else None
        expected_minutes = dkm / expected_speed_km_per_min if expected_speed_km_per_min > 0 else None
        minutes_saved = (expected_minutes - float(m)) if expected_minutes is not None else None
        o = neighborhoods[origin_i]
        h = neighborhoods[hub_i]
        return {
            "hub": hub_key,
            "origin_id": o.get("id"),
            "origin_name": o.get("name"),
            "origin_borough": o.get("borough"),
            "hub_id": h.get("id"),
            "hub_name": h.get("name"),
            "hub_borough": h.get("borough"),
            "minutes": int(m),
            "distance_km": round(float(dkm), 2),
            "km_per_min": round(float(km_per_min), 3) if km_per_min is not None else None,
            "expected_minutes": round(float(expected_minutes), 1) if expected_minutes is not None else None,
            "minutes_saved": round(float(minutes_saved), 1) if minutes_saved is not None else None,
            "first_line": first_line,
        }

    corridors = {}
    for hub_key, hub_i in hub_indices.items():
        rows = []
        for i in range(len(neighborhoods)):
            if i == hub_i:
                continue
            c = centroids[i]
            if c is None:
                continue
            # Tri-borough focus: only consider Brooklyn/Queens origins.
            b = str(neighborhoods[i].get("borough") or "").strip().lower()
            if b:
                if b in ("manhattan", "bronx", "staten island"):
                    continue
                if b not in ("brooklyn", "queens"):
                    continue
            else:
                # Fallback if borough metadata is missing.
                if is_manhattan_centroid(c[0], c[1]) or is_bronx_centroid(c[0], c[1]) or is_staten_island_centroid(c[0], c[1]):
                    continue
            e = mk_entry(i, hub_key, hub_i)
            if e is None:
                continue
            rows.append(e)

        by_saved = [r for r in rows if r.get("minutes_saved") is not None]
        by_saved.sort(key=lambda r: (r["minutes_saved"], r["distance_km"]), reverse=True)
        by_speed = [r for r in rows if r.get("km_per_min") is not None]
        by_speed.sort(key=lambda r: (r["km_per_min"], r["distance_km"]), reverse=True)

        corridors[hub_key] = {
            "top_underrated": by_saved[: min(top_n, 200)],
            "top_speed": by_speed[: min(top_n, 200)],
        }

    return {
        "max_minutes": max_minutes,
        "expected_speed_km_per_min": expected_speed_km_per_min,
        "hubs": hubs,
        "corridors": corridors,
    }


def build_graph(
    stops: Dict[str, dict],
    parent_to_children: Dict[str, List[str]],
    segment_weights: Dict[Tuple[str, str], int],
    segment_routes: Dict[Tuple[str, str], Optional[str]],
    transfer_seconds: int,
):
    graph = {sid: [] for sid in stops.keys()}

    for (u, v), w in segment_weights.items():
        if u in graph and v in graph and w > 0:
            graph[u].append((v, w, segment_routes.get((u, v))))

    # Approximate transfers within the same station complex.
    if transfer_seconds > 0:
        for _, children in parent_to_children.items():
            if len(children) < 2:
                continue
            for i in range(len(children)):
                u = children[i]
                for j in range(len(children)):
                    if i == j:
                        continue
                    v = children[j]
                    graph[u].append((v, transfer_seconds, None))

    return graph


def dijkstra(graph: Dict[str, List[Tuple[str, int]]], start: str) -> Dict[str, int]:
    dist = {start: 0}
    heap = [(0, start)]
    while heap:
        d, u = heapq.heappop(heap)
        if d != dist.get(u):
            continue
        for v, w in graph.get(u, []):
            nd = d + w
            old = dist.get(v)
            if old is None or nd < old:
                dist[v] = nd
                heapq.heappush(heap, (nd, v))
    return dist


def dijkstra_first_route(
    graph: Dict[str, List[Tuple[str, int, Optional[str]]]], start: str
) -> Tuple[Dict[str, int], Dict[str, Optional[str]]]:
    dist: Dict[str, int] = {start: 0}
    first_route: Dict[str, Optional[str]] = {start: None}
    heap = [(0, start)]
    while heap:
        d, u = heapq.heappop(heap)
        if d != dist.get(u):
            continue
        for v, w, rid in graph.get(u, []):
            nd = d + w
            old = dist.get(v)
            if old is None or nd < old:
                dist[v] = nd
                if u == start:
                    first_route[v] = rid
                else:
                    first_route[v] = first_route.get(u)
                heapq.heappush(heap, (nd, v))
    return dist, first_route


def write_graph_json(
    out_path: str,
    *,
    generated_at: str,
    window_id: str,
    window_label: str,
    stops: Dict[str, dict],
    active_stop_ids: Set[str],
    parent_to_children: Dict[str, List[str]],
    segment_weights: Dict[Tuple[str, str], int],
    segment_routes: Dict[Tuple[str, str], Optional[str]],
    transfer_seconds: int,
    routes_by_id: Dict[str, dict],
    neighborhoods: List[dict],
) -> None:
    stop_ids = sorted(active_stop_ids) if active_stop_ids else sorted(stops.keys())
    stop_index: Dict[str, int] = {sid: i for i, sid in enumerate(stop_ids)}

    used_route_ids = sorted({rid for rid in segment_routes.values() if rid is not None})
    routes = []
    route_index: Dict[str, int] = {}
    for rid in used_route_ids:
        meta = routes_by_id.get(rid) or {"id": rid, "short_name": rid, "color": None, "text_color": None}
        route_index[rid] = len(routes)
        routes.append(
            {
                "id": rid,
                "short_name": meta.get("short_name") or rid,
                "color": meta.get("color"),
                "text_color": meta.get("text_color"),
            }
        )

    edges: List[List[Optional[int]]] = []
    for (u, v), w in segment_weights.items():
        if u not in stop_index or v not in stop_index:
            continue
        minutes = int((w + 30) // 60)
        rid = segment_routes.get((u, v))
        edges.append([stop_index[u], stop_index[v], minutes, route_index.get(rid) if rid is not None else None])

    if transfer_seconds > 0:
        transfer_minutes = int((transfer_seconds + 30) // 60)
        for _, children in parent_to_children.items():
            if len(children) < 2:
                continue
            # Only connect stops that exist in this graph.
            kids = [c for c in children if c in stop_index]
            for i in range(len(kids)):
                u = kids[i]
                for j in range(len(kids)):
                    if i == j:
                        continue
                    v = kids[j]
                    edges.append([stop_index[u], stop_index[v], transfer_minutes, None])

    # Attach stop_index to neighborhoods for client routing.
    neighborhoods_out = []
    for n in neighborhoods:
        sid = n.get("stop_id")
        neighborhoods_out.append(
            {
                "id": n.get("id"),
                "name": n.get("name"),
                "borough": n.get("borough"),
                "centroid": n.get("centroid"),
                "stop_id": sid,
                "stop_index": stop_index.get(sid) if sid is not None else None,
            }
        )

    stops_out = []
    for sid in stop_ids:
        st = stops.get(sid)
        if not st:
            continue
        stops_out.append(
            {
                "id": sid,
                "name": st.get("stop_name") or sid,
                "lat": st.get("stop_lat"),
                "lon": st.get("stop_lon"),
                "parent_station": st.get("parent_station"),
            }
        )

    payload = {
        "generated_at": generated_at,
        "window": {"id": window_id, "label": window_label},
        "stops": stops_out,
        "routes": routes,
        "edges": edges,
        "neighborhoods": neighborhoods_out,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f)


def pick_neighborhood_id(props: dict, idx: int) -> str:
    for k in ("NTACode", "nta_code", "nta", "id", "GEOID", "geoid"):
        v = props.get(k)
        if v:
            return str(v)
    name = props.get("NTAName") or props.get("nta_name") or props.get("name") or f"Neighborhood {idx+1}"
    return f"{slugify(str(name))}-{idx+1}"


def pick_neighborhood_name(props: dict) -> str:
    for k in ("NTAName", "nta_name", "name", "neighborhood", "ntaname"):
        v = props.get(k)
        if v:
            return str(v)
    return ""


def pick_neighborhood_borough(props: dict) -> str:
    for k in ("boroname", "BoroName", "boro_name", "borough", "Borough"):
        v = props.get(k)
        if v:
            return str(v)
    return ""


def main():
    ap = argparse.ArgumentParser(description="Build neighborhood-to-neighborhood subway time matrices from GTFS.")
    ap.add_argument("--gtfs", required=True, help="Path to MTA Subway GTFS zip")
    ap.add_argument("--neighborhoods", required=True, help="Path to neighborhoods GeoJSON (recommended: NYC NTAs)")
    ap.add_argument("--out", required=True, help="Output directory (e.g., site/data)")
    ap.add_argument("--transfer-minutes", type=float, default=2.0, help="Fixed transfer minutes within parent_station")
    args = ap.parse_args()

    windows = [
        ("weekday_am", "Weekday AM (07:00–10:00)", 7 * 3600, 10 * 3600),
        ("weekday_pm", "Weekday PM (16:00–19:00)", 16 * 3600, 19 * 3600),
        ("weekend", "Weekend (10:00–22:00)", 10 * 3600, 22 * 3600),
    ]

    out_dir = args.out
    os.makedirs(out_dir, exist_ok=True)

    with zipfile.ZipFile(args.gtfs, "r") as zf:
        for required in ("stops.txt", "trips.txt", "stop_times.txt"):
            if required not in zf.namelist():
                print(f"Missing {required} in GTFS zip", file=sys.stderr)
                return 2

        stops, parent_to_children = load_stops(zf)
        routes_by_id = load_routes(zf)
        # Service filtering is tricky across GTFS feeds (calendar vs calendar_dates, holiday patterns, etc.).
        # For this "typical time of day" atlas, we prefer broader coverage over strict weekday correctness.
        # If we can detect a non-empty weekday-only service set, we use it; otherwise we include all trips.
        weekday_services = detect_weekday_service_ids(zf)
        weekend_services = detect_weekend_service_ids(zf)
        if weekday_services is not None and len(weekday_services) == 0:
            weekday_services = None
        if weekend_services is not None and len(weekend_services) == 0:
            weekend_services = None
        allowed_weekday_trips = load_trips_for_services(zf, weekday_services)
        allowed_weekend_trips = load_trips_for_services(zf, weekend_services)
        trip_routes = load_trip_routes(zf, None)

        seg_lists_by_window: Dict[str, Dict[Tuple[str, str], List[int]]] = {
            wid: {} for (wid, _, _, _) in windows
        }
        seg_route_counts_by_window: Dict[str, Dict[Tuple[str, str], Counter]] = {
            wid: {} for (wid, _, _, _) in windows
        }
        active_stops: Set[str] = set()

        def window_id_for_departure(dep_sec: int) -> list[str]:
            matched = []
            for wid, _, start, end in windows:
                if dep_sec is None:
                    continue
                if start <= dep_sec < end:
                    matched.append(wid)
            return matched

        # Stream stop_times. Do NOT assume rows are grouped by trip_id; some feeds interleave trips.
        # We keep minimal per-trip state keyed by trip_id and only accept edges when stop_sequence increments by 1.
        trip_state: Dict[str, Tuple[int, str, int]] = {}

        for row in gtfs_open_csv(zf, "stop_times.txt"):
            trip_id = row.get("trip_id")
            if not trip_id:
                continue
            is_weekday_trip = allowed_weekday_trips is None or trip_id in allowed_weekday_trips
            is_weekend_trip = allowed_weekend_trips is None or trip_id in allowed_weekend_trips

            stop_id = row.get("stop_id")
            if not stop_id:
                trip_state.pop(trip_id, None)
                continue
            if stop_id in stops:
                active_stops.add(stop_id)

            arr = parse_gtfs_time_to_seconds(row.get("arrival_time"))
            dep = parse_gtfs_time_to_seconds(row.get("departure_time"))
            try:
                seq = int(row.get("stop_sequence") or "")
            except Exception:
                seq = None

            if seq is None:
                # Without stop_sequence we can't safely connect segments.
                trip_state.pop(trip_id, None)
                continue

            prev = trip_state.get(trip_id)
            if prev is not None:
                prev_seq, prev_stop, prev_dep = prev
                if seq == prev_seq + 1 and prev_dep is not None and arr is not None:
                    seg = arr - prev_dep
                    if 0 < seg < 3600 and prev_stop in stops and stop_id in stops:
                        for wid in window_id_for_departure(prev_dep):
                            if wid.startswith("weekday_") and not is_weekday_trip:
                                continue
                            if wid == "weekend" and not is_weekend_trip:
                                continue
                            seg_lists_by_window[wid].setdefault((prev_stop, stop_id), []).append(seg)
                            rid = trip_routes.get(trip_id)
                            seg_route_counts_by_window[wid].setdefault((prev_stop, stop_id), Counter())[
                                rid
                            ] += 1
                elif seq <= prev_seq:
                    # Out-of-order or duplicate sequence: reset chain for this trip.
                    prev = None

            if dep is None:
                # Can't continue the chain if we don't know departure time.
                trip_state.pop(trip_id, None)
                continue
            trip_state[trip_id] = (seq, stop_id, dep)

        weights_by_window: Dict[str, Dict[Tuple[str, str], int]] = {}
        routes_by_window: Dict[str, Dict[Tuple[str, str], Optional[str]]] = {}
        for wid, _, _, _ in windows:
            weights = {}
            for edge, values in seg_lists_by_window[wid].items():
                # Median reduces outliers from dwell / schedule quirks.
                weights[edge] = median_int(values)
            weights_by_window[wid] = weights
            edge_routes: Dict[Tuple[str, str], Optional[str]] = {}
            for edge, counts in seg_route_counts_by_window[wid].items():
                if not counts:
                    edge_routes[edge] = None
                else:
                    rid, _ = counts.most_common(1)[0]
                    edge_routes[edge] = rid
            routes_by_window[wid] = edge_routes
            print(f"[{wid}] segment edges: {len(weights)}", file=sys.stderr)

    with open(args.neighborhoods, "r", encoding="utf-8") as f:
        neighborhoods_geo = json.load(f)

    features = neighborhoods_geo.get("features") or []
    if not isinstance(features, list) or not features:
        print("Neighborhoods GeoJSON has no features", file=sys.stderr)
        return 2

    # Build neighborhood metadata and pick a representative stop per neighborhood.
    if active_stops:
        stop_list = [stops[sid] for sid in sorted(active_stops) if sid in stops]
    else:
        stop_list = list(stops.values())

    neighborhoods = []
    seen_ids = set()

    for idx, feat in enumerate(features):
        props = feat.get("properties") or {}
        nid = pick_neighborhood_id(props, idx)
        if nid in seen_ids:
            nid = f"{nid}-{idx+1}"
        seen_ids.add(nid)

        center = centroid_latlon(feat)
        if center is None:
            # Skip features without a usable geometry.
            continue

        lat, lon = center
        nearest = None
        nearest_d = None
        for st in stop_list:
            d = haversine_m(lat, lon, st["stop_lat"], st["stop_lon"])
            if nearest_d is None or d < nearest_d:
                nearest_d = d
                nearest = st

        name = pick_neighborhood_name(props) or nid
        borough = pick_neighborhood_borough(props)
        neighborhoods.append(
            {
                "id": nid,
                "name": name,
                "borough": borough,
                "centroid": [lat, lon],
                "stop_id": nearest["stop_id"] if nearest else None,
            }
        )

        # Stamp stable id into the GeoJSON used by the site.
        props = dict(props)
        props["atlas_id"] = nid
        feat["properties"] = props

    neighborhoods_geo_out = os.path.join(out_dir, "neighborhoods.geojson")
    with open(neighborhoods_geo_out, "w", encoding="utf-8") as f:
        json.dump(neighborhoods_geo, f)

    rep_stops = [n["stop_id"] for n in neighborhoods]
    if any(s is None for s in rep_stops):
        print("Some neighborhoods could not be matched to a stop", file=sys.stderr)
        return 2

    transfer_seconds = int(round(args.transfer_minutes * 60))

    generated_at = dt.datetime.now(dt.timezone.utc).isoformat()
    teleport_report: Dict[str, dict] = {}

    for wid, label, _, _ in windows:
        segment_weights = weights_by_window.get(wid, {})
        segment_routes = routes_by_window.get(wid, {})
        graph = build_graph(stops, parent_to_children, segment_weights, segment_routes, transfer_seconds)

        # Also emit a stop-level graph file used by the browser to compute paths and draw routes.
        graph_out_path = os.path.join(out_dir, f"graph_{wid}.json")
        write_graph_json(
            graph_out_path,
            generated_at=generated_at,
            window_id=wid,
            window_label=label,
            stops=stops,
            active_stop_ids=active_stops,
            parent_to_children=parent_to_children,
            segment_weights=segment_weights,
            segment_routes=segment_routes,
            transfer_seconds=transfer_seconds,
            routes_by_id=routes_by_id,
            neighborhoods=neighborhoods,
        )
        print(f"Wrote {graph_out_path}", file=sys.stderr)

        # Build a compact routes table for the client. Include only routes that appear as
        # the dominant route for at least one segment in this window.
        used_route_ids = sorted({rid for rid in segment_routes.values() if rid is not None})
        routes = []
        route_index: Dict[str, int] = {}
        for rid in used_route_ids:
            meta = routes_by_id.get(rid) or {"id": rid, "short_name": rid, "color": None, "text_color": None}
            route_index[rid] = len(routes)
            routes.append(
                {
                    "id": rid,
                    "short_name": meta.get("short_name") or rid,
                    "color": meta.get("color"),
                    "text_color": meta.get("text_color"),
                }
            )

        minutes_matrix = []
        first_route_matrix = []
        for i, start_stop in enumerate(rep_stops):
            dist, first_route = dijkstra_first_route(graph, start_stop)
            row = []
            route_row = []
            for j, dest_stop in enumerate(rep_stops):
                sec = dist.get(dest_stop)
                if sec is None:
                    row.append(None)
                    route_row.append(None)
                else:
                    row.append(int((sec + 30) // 60))
                    rid = first_route.get(dest_stop)
                    route_row.append(route_index.get(rid) if rid is not None else None)
            minutes_matrix.append(row)
            first_route_matrix.append(route_row)
            if (i + 1) % 25 == 0:
                print(f"[{wid}] computed {i+1}/{len(rep_stops)} origins...", file=sys.stderr)

        centrality_scores = [harmonic_centrality_from_minutes_row(r) for r in minutes_matrix]
        median_minutes = [median_minutes_from_row(r) for r in minutes_matrix]

        # Transfer-penalized harmonic centrality: re-run the same computation with extra
        # minutes added to each station-complex transfer edge.
        transfer_penalty_minutes = 4.0
        transfer_penalty_seconds = int(round(transfer_penalty_minutes * 60))
        penalized_graph = build_graph(
            stops,
            parent_to_children,
            segment_weights,
            segment_routes,
            transfer_seconds=transfer_seconds + transfer_penalty_seconds,
        )
        penalized_scores: List[float] = []
        for start_stop in rep_stops:
            dist_pen, _ = dijkstra_first_route(penalized_graph, start_stop)
            row_pen: List[Optional[int]] = []
            for dest_stop in rep_stops:
                sec = dist_pen.get(dest_stop)
                if sec is None:
                    row_pen.append(None)
                else:
                    row_pen.append(int((sec + 30) // 60))
            penalized_scores.append(harmonic_centrality_from_minutes_row(row_pen))

        out_path = os.path.join(out_dir, f"matrix_{wid}.json")
        payload = {
            "generated_at": generated_at,
            "window": {"id": wid, "label": label},
            "neighborhoods": neighborhoods,
            "routes": routes,
            "minutes": minutes_matrix,
            "first_route": first_route_matrix,
            "centrality": {
                "default": "harmonic",
                "metrics": {
                    "harmonic": {
                        "label": "Harmonic",
                        "higher_is_better": True,
                        "scores": [round(s, 6) for s in centrality_scores],
                    },
                    "median_minutes": {
                        "label": "Median minutes",
                        "higher_is_better": False,
                        "scores": [round(float(s), 3) if s is not None else None for s in median_minutes],
                    },
                    "transfer_penalized": {
                        "label": "Transfer-penalized",
                        "higher_is_better": True,
                        "transfer_penalty_minutes": transfer_penalty_minutes,
                        "scores": [round(s, 6) for s in penalized_scores],
                    },
                },
            },
        }
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(payload, f)

        print(f"Wrote {out_path}", file=sys.stderr)

        teleport_report[wid] = {
            "window": {"id": wid, "label": label},
            **compute_hub_corridors(
                neighborhoods=neighborhoods,
                minutes=minutes_matrix,
                first_route=first_route_matrix,
                routes=routes,
                centrality_scores=centrality_scores,
            ),
        }

    teleport_out_path = os.path.join(out_dir, "teleport_corridors.json")
    with open(teleport_out_path, "w", encoding="utf-8") as f:
        json.dump({"generated_at": generated_at, "windows": teleport_report}, f)
    print(f"Wrote {teleport_out_path}", file=sys.stderr)

    print("Done.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
