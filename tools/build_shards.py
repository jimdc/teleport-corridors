#!/usr/bin/env python3
"""Emit static query shards and little-endian Int16 matrix artifacts.

The JSON matrices remain build artifacts for compatibility and verification, but
the browser reads only the compact index plus the binary planes emitted here.
"""

from __future__ import annotations

import argparse
from array import array
import hashlib
import json
import math
from pathlib import Path
import shutil
import sys
from typing import Any

try:
    from tools.build_matrix import haversine_m
except ModuleNotFoundError:  # Direct invocation: python3 tools/build_shards.py
    from build_matrix import haversine_m


INT16_NULL = -1
SHARD_HARD_CAP = 200_000
EXPECTED_SPEED_KM_PER_MIN = 0.25
WALK_SPEED_KM_PER_MIN = 0.0833
LINE_RADIUS_KM = 0.65
JUDGE_PRESETS = {
    "balanced": {"max_commute": 40, "max_walk": 10, "min_lines": 3},
    "lenient": {"max_commute": 55, "max_walk": 12, "min_lines": 2},
    "strict": {"max_commute": 35, "max_walk": 8, "min_lines": 3},
}


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _write_json(path: Path, payload: Any) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    path.write_bytes(encoded)
    return len(encoded)


def _unit_and_profile(matrix_path: Path) -> tuple[str, str]:
    stem = matrix_path.stem
    if not stem.startswith("matrix_"):
        raise ValueError(f"Unexpected matrix name: {matrix_path.name}")
    key = stem.removeprefix("matrix_")
    if key.endswith("_derived"):
        return "derived", key.removesuffix("_derived")
    return "tract", key


def _int16(value: Any, *, label: str) -> int:
    if value is None:
        return INT16_NULL
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{label} is not a finite number: {value!r}")
    integer = int(value)
    if integer != value or integer < 0 or integer > 32767:
        raise ValueError(f"{label} does not fit exact non-negative Int16: {value!r}")
    return integer


def emit_binary_matrix(matrix_path: Path, out_dir: Path) -> dict[str, Any]:
    """Write minutes and first-route planes to one flat little-endian Int16 file."""
    matrix = _read_json(matrix_path)
    unit, profile = _unit_and_profile(matrix_path)
    minutes = matrix.get("minutes") or []
    first_route = matrix.get("first_route") or []
    size = len(minutes)
    if not size or any(len(row) != size for row in minutes):
        raise ValueError(f"{matrix_path} minutes must be a non-empty square matrix")
    if len(first_route) != size or any(len(row) != size for row in first_route):
        raise ValueError(f"{matrix_path} first_route must match minutes dimensions")

    values = array("h")
    for i, row in enumerate(minutes):
        values.extend(_int16(value, label=f"minutes[{i}]") for value in row)
    first_route_offset = len(values)
    for i, row in enumerate(first_route):
        values.extend(_int16(value, label=f"first_route[{i}]") for value in row)
    if sys.byteorder != "little":
        values.byteswap()

    bin_name = f"matrix_{profile}{'_derived' if unit == 'derived' else ''}.bin"
    index_name = f"matrix_{profile}{'_derived' if unit == 'derived' else ''}_index.json"
    bin_path = out_dir / bin_name
    index_path = out_dir / index_name
    raw = values.tobytes()
    bin_path.write_bytes(raw)

    graph_path = matrix_path.with_name(
        f"graph_{profile}{'_derived' if unit == 'derived' else ''}.json"
    )
    graph = _read_json(graph_path)
    graph_by_id = {
        str(row.get("id")): row for row in (graph.get("neighborhoods") or []) if row.get("id") is not None
    }
    rows = []
    station_rows: dict[str, list[int]] = {}
    for row_number, neighborhood in enumerate(matrix.get("neighborhoods") or []):
        neighborhood_id = str(neighborhood.get("id"))
        station_id = graph_by_id.get(neighborhood_id, {}).get("stop_id")
        rows.append(
            {
                "id": neighborhood_id,
                "station_id": station_id,
                "row": row_number,
                "offset": row_number * size,
            }
        )
        if station_id is not None:
            station_rows.setdefault(str(station_id), []).append(row_number)

    index = {
        "version": 1,
        "unit": unit,
        "profile": profile,
        "dtype": "int16",
        "endian": "little",
        "null": INT16_NULL,
        "size": size,
        "minutes_offset": 0,
        "first_route_offset": first_route_offset,
        "rows": rows,
        "row_by_id": {row["id"]: row["row"] for row in rows},
        "station_rows": station_rows,
        "routes": matrix.get("routes") or [],
        "centrality": matrix.get("centrality") or {},
        "binary": bin_name,
        "sha256": hashlib.sha256(raw).hexdigest(),
    }
    _write_json(index_path, index)
    verify_binary_round_trip(matrix_path, index_path, bin_path)
    return {
        "unit": unit,
        "profile": profile,
        "binary": bin_name,
        "index": index_name,
        "bytes": len(raw),
        "sha256": index["sha256"],
    }


def verify_binary_round_trip(matrix_path: Path, index_path: Path, bin_path: Path) -> None:
    """Fail the build unless both binary planes exactly reproduce their JSON sources."""
    matrix = _read_json(matrix_path)
    index = _read_json(index_path)
    raw = bin_path.read_bytes()
    values = array("h")
    values.frombytes(raw)
    if sys.byteorder != "little":
        values.byteswap()
    size = int(index["size"])
    plane_size = size * size
    if len(values) != plane_size * 2:
        raise AssertionError(f"{bin_path} contains {len(values)} values; expected {plane_size * 2}")
    for key, offset in (("minutes", 0), ("first_route", int(index["first_route_offset"]))):
        for i, row in enumerate(matrix.get(key) or []):
            for j, expected in enumerate(row):
                actual = values[offset + i * size + j]
                decoded = None if actual == INT16_NULL else int(actual)
                if decoded != expected:
                    raise AssertionError(
                        f"{bin_path} round-trip mismatch for {key}[{i}][{j}]: "
                        f"{decoded!r} != {expected!r}"
                    )


def _walk_and_line_metrics(graph: dict[str, Any]) -> dict[str, tuple[float | None, int]]:
    stops = graph.get("stops") or []
    routes = graph.get("routes") or []
    routes_by_stop = [set() for _ in stops]
    for edge in graph.get("edges") or []:
        if len(edge) < 4 or edge[3] is None:
            continue
        for stop_index in edge[:2]:
            if isinstance(stop_index, int) and 0 <= stop_index < len(routes_by_stop):
                routes_by_stop[stop_index].add(int(edge[3]))

    def route_key(route_index: int) -> str:
        route = routes[route_index] if 0 <= route_index < len(routes) else {}
        return str(route.get("short_name") or route.get("id") or route_index)

    output: dict[str, tuple[float | None, int]] = {}
    for neighborhood in graph.get("neighborhoods") or []:
        neighborhood_id = str(neighborhood.get("id"))
        centroid = neighborhood.get("centroid")
        if not isinstance(centroid, list) or len(centroid) < 2:
            output[neighborhood_id] = (None, 0)
            continue
        best_km = None
        nearby_lines: set[str] = set()
        for stop_index, stop in enumerate(stops):
            distance_km = haversine_m(
                float(centroid[0]),
                float(centroid[1]),
                float(stop["lat"]),
                float(stop["lon"]),
            ) / 1000.0
            if best_km is None or distance_km < best_km:
                best_km = distance_km
            if distance_km <= LINE_RADIUS_KM:
                nearby_lines.update(route_key(index) for index in routes_by_stop[stop_index])
        walk = best_km / WALK_SPEED_KM_PER_MIN if best_km is not None else None
        output[neighborhood_id] = (walk, len(nearby_lines))
    return output


def _disqualified(item: dict[str, Any], preset: dict[str, float]) -> bool:
    commute = item.get("commute")
    walk = item.get("walk")
    lines = item.get("lines")
    return (
        commute is None
        or commute > preset["max_commute"]
        or walk is None
        or walk > preset["max_walk"]
        or lines < preset["min_lines"]
    )


def _teleportness_rows(
    neighborhoods: list[dict[str, Any]],
    minutes: list[list[int | None]],
    first_route: list[list[int | None]],
    routes: list[dict[str, Any]],
    hub_index: int,
) -> list[dict[str, Any]]:
    hub = neighborhoods[hub_index]
    hub_centroid = hub.get("centroid")
    if not isinstance(hub_centroid, list) or len(hub_centroid) < 2:
        return []
    output = []
    for origin_index, neighborhood in enumerate(neighborhoods):
        if origin_index == hub_index:
            continue
        centroid = neighborhood.get("centroid")
        commute = minutes[origin_index][hub_index]
        if commute is None or commute <= 0 or not isinstance(centroid, list) or len(centroid) < 2:
            continue
        distance_km = haversine_m(
            float(centroid[0]),
            float(centroid[1]),
            float(hub_centroid[0]),
            float(hub_centroid[1]),
        ) / 1000.0
        expected = distance_km / EXPECTED_SPEED_KM_PER_MIN
        route_index = first_route[origin_index][hub_index]
        route = routes[route_index] if isinstance(route_index, int) and 0 <= route_index < len(routes) else {}
        output.append(
            {
                "id": str(neighborhood.get("id")),
                "minutes": commute,
                "distance_km": round(distance_km, 2),
                "expected_minutes": round(expected, 1),
                "minutes_saved": round(expected - commute, 1),
                "first_line": route.get("short_name") or route.get("id"),
                "first_color": route.get("color"),
            }
        )
    return output


def emit_shards(data_dir: Path, shards_dir: Path) -> dict[str, Any]:
    if shards_dir.name != "shards" or shards_dir.resolve().parent != data_dir.resolve():
        raise ValueError(f"Refusing to replace unexpected shard directory: {shards_dir}")
    if shards_dir.exists():
        shutil.rmtree(shards_dir)
    shards_dir.mkdir(parents=True)
    manifest: dict[str, Any] = {
        "version": 1,
        "hard_cap_bytes": SHARD_HARD_CAP,
        "units": {},
        "shard_count": 0,
        "largest_shard_bytes": 0,
        "matrices": {},
    }

    matrix_paths = sorted(data_dir.glob("matrix_*.json"))
    matrix_paths = [path for path in matrix_paths if not path.name.endswith("_index.json")]
    for matrix_path in matrix_paths:
        matrix_info = emit_binary_matrix(matrix_path, data_dir)
        manifest["matrices"].setdefault(matrix_info["unit"], {})[matrix_info["profile"]] = matrix_info

    for unit, suffix in (("tract", ""), ("derived", "_derived")):
        teleport_path = data_dir / f"teleport_corridors{suffix}.json"
        if not teleport_path.exists():
            continue
        teleport = _read_json(teleport_path)
        unit_manifest = manifest["units"].setdefault(unit, {})
        for profile, window in sorted((teleport.get("windows") or {}).items()):
            matrix_path = data_dir / f"matrix_{profile}{suffix}.json"
            graph_path = data_dir / f"graph_{profile}{suffix}.json"
            if not matrix_path.exists() or not graph_path.exists():
                continue
            matrix = _read_json(matrix_path)
            graph = _read_json(graph_path)
            neighborhoods = matrix.get("neighborhoods") or []
            by_id = {str(row.get("id")): i for i, row in enumerate(neighborhoods)}
            metrics = _walk_and_line_metrics(graph)
            profile_manifest = unit_manifest.setdefault(profile, {})
            hubs = window.get("hubs") or {}
            for hub_key, hub in sorted(hubs.items()):
                hub_id = str(hub.get("id"))
                hub_index = by_id.get(hub_id)
                if hub_index is None:
                    continue
                hub_manifest = profile_manifest.setdefault(hub_key, {})
                common = {
                    "version": 1,
                    "unit": unit,
                    "profile": profile,
                    "hub": hub,
                }
                centrality_items = [
                    {"id": str(row.get("id")), "minutes": matrix["minutes"][i][hub_index]}
                    for i, row in enumerate(neighborhoods)
                ]
                judge_items = []
                for item in centrality_items:
                    walk, lines = metrics.get(item["id"], (None, 0))
                    judge_items.append(
                        {
                            "id": item["id"],
                            "commute": item["minutes"],
                            "walk": round(walk, 3) if walk is not None else None,
                            "lines": lines,
                        }
                    )
                payloads = {
                    "centrality": {**common, "metric": "centrality", "items": centrality_items},
                    "teleportness": {
                        **common,
                        "metric": "teleportness",
                        "items": _teleportness_rows(
                            neighborhoods,
                            matrix["minutes"],
                            matrix["first_route"],
                            matrix.get("routes") or [],
                            hub_index,
                        ),
                    },
                    "judge": {
                        **common,
                        "metric": "judge",
                        "items": judge_items,
                        "disqualified": {
                            name: [item["id"] for item in judge_items if _disqualified(item, preset)]
                            for name, preset in JUDGE_PRESETS.items()
                        },
                    },
                    "corridors": {
                        **common,
                        "metric": "corridors",
                        "max_minutes": window.get("max_minutes"),
                        "expected_speed_km_per_min": window.get("expected_speed_km_per_min"),
                        **((window.get("corridors") or {}).get(hub_key) or {}),
                    },
                }
                for metric, payload in payloads.items():
                    relative = Path(unit) / profile / hub_key / f"{metric}.json"
                    byte_count = _write_json(shards_dir / relative, payload)
                    if byte_count >= SHARD_HARD_CAP:
                        raise ValueError(
                            f"Shard {relative} is {byte_count:,} bytes; cap is {SHARD_HARD_CAP:,}"
                        )
                    entry = {"path": relative.as_posix(), "bytes": byte_count}
                    hub_manifest[metric] = entry
                    manifest["shard_count"] += 1
                    manifest["largest_shard_bytes"] = max(
                        manifest["largest_shard_bytes"], byte_count
                    )

    _write_json(shards_dir / "manifest.json", manifest)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="site/data", help="Directory containing built JSON data")
    args = parser.parse_args()
    data_dir = Path(args.out)
    manifest = emit_shards(data_dir, data_dir / "shards")
    print(
        f"Wrote {manifest['shard_count']} shards and "
        f"{sum(len(v) for v in manifest['matrices'].values())} binary matrices "
        f"(largest shard {manifest['largest_shard_bytes']:,} bytes)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
