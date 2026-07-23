#!/usr/bin/env python3
"""Dependency-free GeoJSON compaction for the static browser payload.

Coordinates are quantized to five decimal places (about one metre in NYC) and
closed polygon rings are simplified with a 0.0004-degree Douglas-Peucker
tolerance (about 34-44 metres in NYC). Simplified rings must remain closed,
non-self-intersecting, non-degenerate, and retain their original orientation;
otherwise the quantized original ring is emitted.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Iterable


COORDINATE_PRECISION = 5
SIMPLIFICATION_TOLERANCE_DEGREES = 0.0004


def _point_segment_distance_sq(point: list[float], start: list[float], end: list[float]) -> float:
    x, y = point[:2]
    x1, y1 = start[:2]
    x2, y2 = end[:2]
    dx = x2 - x1
    dy = y2 - y1
    if dx == 0 and dy == 0:
        return (x - x1) ** 2 + (y - y1) ** 2
    position = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    px = x1 + position * dx
    py = y1 + position * dy
    return (x - px) ** 2 + (y - py) ** 2


def _douglas_peucker(points: list[list[float]], tolerance: float) -> list[list[float]]:
    if len(points) <= 2:
        return points
    distances = [
        _point_segment_distance_sq(points[index], points[0], points[-1])
        for index in range(1, len(points) - 1)
    ]
    max_distance = max(distances, default=-1.0)
    if max_distance <= tolerance * tolerance:
        return [points[0], points[-1]]
    split = distances.index(max_distance) + 1
    left = _douglas_peucker(points[: split + 1], tolerance)
    right = _douglas_peucker(points[split:], tolerance)
    return left[:-1] + right


def _signed_area(ring: list[list[float]]) -> float:
    return 0.5 * sum(
        ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1]
        for index in range(len(ring) - 1)
    )


def _orientation(a: list[float], b: list[float], c: list[float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _on_segment(a: list[float], b: list[float], p: list[float]) -> bool:
    epsilon = 1e-12
    return (
        min(a[0], b[0]) - epsilon <= p[0] <= max(a[0], b[0]) + epsilon
        and min(a[1], b[1]) - epsilon <= p[1] <= max(a[1], b[1]) + epsilon
    )


def _segments_intersect(
    a: list[float], b: list[float], c: list[float], d: list[float]
) -> bool:
    epsilon = 1e-12
    o1 = _orientation(a, b, c)
    o2 = _orientation(a, b, d)
    o3 = _orientation(c, d, a)
    o4 = _orientation(c, d, b)
    if ((o1 > epsilon and o2 < -epsilon) or (o1 < -epsilon and o2 > epsilon)) and (
        (o3 > epsilon and o4 < -epsilon) or (o3 < -epsilon and o4 > epsilon)
    ):
        return True
    return (
        (abs(o1) <= epsilon and _on_segment(a, b, c))
        or (abs(o2) <= epsilon and _on_segment(a, b, d))
        or (abs(o3) <= epsilon and _on_segment(c, d, a))
        or (abs(o4) <= epsilon and _on_segment(c, d, b))
    )


def ring_is_simple(ring: list[list[float]]) -> bool:
    """Return whether a closed ring has no non-adjacent segment intersections."""
    if len(ring) < 4 or ring[0] != ring[-1]:
        return False
    segment_count = len(ring) - 1
    for first in range(segment_count):
        a, b = ring[first], ring[first + 1]
        if a == b:
            return False
        for second in range(first + 1, segment_count):
            if second in (first, first + 1):
                continue
            if first == 0 and second == segment_count - 1:
                continue
            c, d = ring[second], ring[second + 1]
            if _segments_intersect(a, b, c, d):
                return False
    return True


def _quantize_ring(ring: Iterable[list[Any]], precision: int) -> list[list[float]]:
    output: list[list[float]] = []
    for point in ring:
        if not isinstance(point, list) or len(point) < 2:
            continue
        quantized = [round(float(point[0]), precision), round(float(point[1]), precision)]
        if not output or output[-1] != quantized:
            output.append(quantized)
    if output and output[-1] == output[0]:
        output.pop()
    if len(output) >= 3:
        output.append(output[0])
    return output


def _point_in_ring(point: list[float], ring: list[list[float]]) -> bool:
    x, y = point[:2]
    inside = False
    for index in range(len(ring) - 1):
        x1, y1 = ring[index][:2]
        x2, y2 = ring[index + 1][:2]
        if (y1 > y) != (y2 > y):
            crossing_x = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if crossing_x >= x:
                inside = not inside
    return inside


def _turn_angle(incoming: tuple[float, float], outgoing: tuple[float, float]) -> float:
    cross = incoming[0] * outgoing[1] - incoming[1] * outgoing[0]
    dot = incoming[0] * outgoing[0] + incoming[1] * outgoing[1]
    return math.atan2(cross, dot)


def _dissolve_rectangle_cells(
    polygons: list[Any],
    precision: int,
) -> list[list[list[list[float]]]] | None:
    """Dissolve a MultiPolygon made solely of axis-aligned rectangle cells.

    Derived regions are emitted as thousands of adjacent grid-cell polygons.
    Cancelling shared directed edges produces the same union boundary without
    requiring a geometry dependency. Returns None for any non-grid geometry.
    """
    boundary_edges: dict[
        tuple[tuple[float, float], tuple[float, float]],
        tuple[tuple[float, float], tuple[float, float]],
    ] = {}
    for polygon in polygons:
        if not isinstance(polygon, list) or len(polygon) != 1:
            return None
        ring = _quantize_ring(polygon[0], precision)
        if len(ring) != 5 or abs(_signed_area(ring)) <= 1e-12:
            return None
        xs = {point[0] for point in ring[:-1]}
        ys = {point[1] for point in ring[:-1]}
        if len(xs) != 2 or len(ys) != 2:
            return None
        for index in range(4):
            start = tuple(ring[index])
            end = tuple(ring[index + 1])
            key = tuple(sorted((start, end)))
            if key in boundary_edges:
                del boundary_edges[key]
            else:
                boundary_edges[key] = (start, end)

    if not boundary_edges:
        return None

    directed_edges = set(boundary_edges.values())
    outgoing: dict[tuple[float, float], list[tuple[float, float]]] = {}
    for start, end in directed_edges:
        outgoing.setdefault(start, []).append(end)

    rings: list[list[list[float]]] = []
    while directed_edges:
        start, next_point = min(directed_edges)
        directed_edges.remove((start, next_point))
        ring_tuples = [start, next_point]
        while ring_tuples[-1] != start:
            previous = ring_tuples[-2]
            current = ring_tuples[-1]
            candidates = [
                candidate
                for candidate in outgoing.get(current, [])
                if (current, candidate) in directed_edges
            ]
            if not candidates:
                return None
            incoming = (current[0] - previous[0], current[1] - previous[1])
            chosen = max(
                candidates,
                key=lambda candidate: _turn_angle(
                    incoming,
                    (candidate[0] - current[0], candidate[1] - current[1]),
                ),
            )
            directed_edges.remove((current, chosen))
            ring_tuples.append(chosen)
            if len(ring_tuples) > len(boundary_edges) + 1:
                return None
        ring = [[point[0], point[1]] for point in ring_tuples]
        if len(ring) < 4 or not ring_is_simple(ring):
            return None
        rings.append(ring)

    exteriors = [ring for ring in rings if _signed_area(ring) > 0]
    holes = [ring for ring in rings if _signed_area(ring) < 0]
    if not exteriors:
        return None
    dissolved = [[exterior] for exterior in exteriors]
    for hole in holes:
        containing = [
            index
            for index, exterior in enumerate(exteriors)
            if _point_in_ring(hole[0], exterior)
        ]
        if not containing:
            return None
        owner = min(containing, key=lambda index: abs(_signed_area(exteriors[index])))
        dissolved[owner].append(hole)
    return dissolved


def simplify_ring(
    ring: Iterable[list[Any]],
    *,
    precision: int = COORDINATE_PRECISION,
    tolerance: float = SIMPLIFICATION_TOLERANCE_DEGREES,
) -> list[list[float]]:
    rounded = _quantize_ring(ring, precision)
    if len(rounded) <= 4 or tolerance <= 0:
        return rounded

    open_ring = rounded[:-1]
    start = min(range(len(open_ring)), key=lambda index: tuple(open_ring[index]))
    rotated = open_ring[start:] + open_ring[:start]
    opposite = max(
        range(1, len(rotated)),
        key=lambda index: _point_segment_distance_sq(rotated[index], rotated[0], rotated[0]),
    )
    first_chain = _douglas_peucker(rotated[: opposite + 1], tolerance)
    second_chain = _douglas_peucker(rotated[opposite:] + [rotated[0]], tolerance)
    simplified = first_chain[:-1] + second_chain
    simplified = _quantize_ring(simplified, precision)

    original_area = _signed_area(rounded)
    simplified_area = _signed_area(simplified) if len(simplified) >= 4 else 0.0
    same_orientation = original_area == 0 or math.copysign(1, original_area) == math.copysign(
        1, simplified_area
    )
    if (
        len(simplified) < 4
        or abs(simplified_area) <= 1e-12
        or not same_orientation
        or not ring_is_simple(simplified)
    ):
        return rounded
    return simplified


def compact_geometry(
    geometry: dict[str, Any],
    *,
    precision: int = COORDINATE_PRECISION,
    tolerance: float = SIMPLIFICATION_TOLERANCE_DEGREES,
) -> dict[str, Any]:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates") or []

    def compact_polygon(polygon: list[Any]) -> list[list[list[float]]]:
        return [
            compacted
            for ring in polygon
            if len(
                compacted := simplify_ring(
                    ring,
                    precision=precision,
                    tolerance=tolerance,
                )
            )
            >= 4
        ]

    if geometry_type == "Polygon":
        geometry["coordinates"] = compact_polygon(coordinates)
    elif geometry_type == "MultiPolygon":
        dissolved = _dissolve_rectangle_cells(coordinates, precision)
        source_polygons = dissolved if dissolved is not None else coordinates
        geometry["coordinates"] = [
            compacted
            for polygon in source_polygons
            if (compacted := compact_polygon(polygon))
        ]
    return geometry


def compact_feature_collection(
    collection: dict[str, Any],
    *,
    precision: int = COORDINATE_PRECISION,
    tolerance: float = SIMPLIFICATION_TOLERANCE_DEGREES,
) -> dict[str, Any]:
    for feature in collection.get("features") or []:
        geometry = feature.get("geometry")
        if isinstance(geometry, dict):
            feature["geometry"] = compact_geometry(
                geometry,
                precision=precision,
                tolerance=tolerance,
            )
    return collection


def write_compact_geojson(path: str | Path, collection: dict[str, Any]) -> None:
    compact_feature_collection(collection)
    encoded = json.dumps(collection, separators=(",", ":"), ensure_ascii=False)
    Path(path).write_text(encoded, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compact GeoJSON polygon coordinates in place for the static site."
    )
    parser.add_argument("paths", nargs="+", help="GeoJSON files to compact in place")
    args = parser.parse_args()
    for raw_path in args.paths:
        path = Path(raw_path)
        collection = json.loads(path.read_text(encoding="utf-8"))
        before = path.stat().st_size
        write_compact_geojson(path, collection)
        after = path.stat().st_size
        print(f"{path}: {before:,} -> {after:,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
