import json
import struct
from pathlib import Path

from tools.build_shards import SHARD_HARD_CAP, emit_shards


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


def sample_data(out: Path) -> None:
    neighborhoods = [
        {"id": "A", "name": "Alpha", "borough": "Brooklyn", "centroid": [40.70, -73.99]},
        {"id": "B", "name": "Beta", "borough": "Queens", "centroid": [40.72, -73.98]},
    ]
    routes = [{"id": "R", "short_name": "Q", "color": "#ffcc00"}]
    matrix = {
        "generated_at": "2026-01-01T00:00:00+00:00",
        "window": {"id": "weekday_am", "label": "Weekday AM"},
        "neighborhoods": neighborhoods,
        "routes": routes,
        "minutes": [[0, 5], [5, 0]],
        "first_route": [[None, 0], [0, None]],
        "centrality": {
            "default": "harmonic",
            "metrics": {
                "harmonic": {
                    "label": "Harmonic",
                    "higher_is_better": True,
                    "scores": [0.2, 0.2],
                }
            },
        },
    }
    graph = {
        "window": matrix["window"],
        "stops": [
            {"id": "S1", "name": "Stop 1", "lat": 40.70, "lon": -73.99},
            {"id": "S2", "name": "Stop 2", "lat": 40.72, "lon": -73.98},
        ],
        "routes": routes,
        "edges": [[0, 1, 5, 0], [1, 0, 5, 0]],
        "neighborhoods": [
            {**neighborhoods[0], "stop_id": "S1", "stop_index": 0},
            {**neighborhoods[1], "stop_id": "S2", "stop_index": 1},
        ],
    }
    corridor = {
        "hub": "midtown",
        "origin_id": "A",
        "origin_name": "Alpha",
        "origin_borough": "Brooklyn",
        "hub_id": "B",
        "hub_name": "Beta",
        "hub_borough": "Queens",
        "minutes": 5,
        "distance_km": 2.4,
        "km_per_min": 0.48,
        "expected_minutes": 9.6,
        "minutes_saved": 4.6,
        "first_line": "Q",
    }
    teleport = {
        "generated_at": matrix["generated_at"],
        "windows": {
            "weekday_am": {
                "window": matrix["window"],
                "max_minutes": 180,
                "expected_speed_km_per_min": 0.25,
                "hubs": {
                    "midtown": {
                        "key": "midtown",
                        "label": "Midtown",
                        "id": "B",
                        "name": "Beta",
                        "centroid": [40.72, -73.98],
                    }
                },
                "corridors": {
                    "midtown": {
                        "top_underrated": [corridor],
                        "top_speed": [corridor],
                    }
                },
            }
        },
    }
    write_json(out / "matrix_weekday_am.json", matrix)
    write_json(out / "graph_weekday_am.json", graph)
    write_json(out / "teleport_corridors.json", teleport)


def test_shard_manifest_is_complete_and_capped(tmp_path):
    sample_data(tmp_path)
    manifest = emit_shards(tmp_path, tmp_path / "shards")

    hub = manifest["units"]["tract"]["weekday_am"]["midtown"]
    assert set(hub) == {"centrality", "teleportness", "judge", "corridors"}
    assert manifest["shard_count"] == 4
    for entry in hub.values():
        shard_path = tmp_path / "shards" / entry["path"]
        assert shard_path.exists()
        assert shard_path.stat().st_size == entry["bytes"]
        assert entry["bytes"] < SHARD_HARD_CAP

    judge = json.loads(
        (tmp_path / "shards" / hub["judge"]["path"]).read_text(encoding="utf-8")
    )
    assert set(judge["disqualified"]) == {"balanced", "lenient", "strict"}


def test_binary_matrix_round_trips_exactly(tmp_path):
    sample_data(tmp_path)
    manifest = emit_shards(tmp_path, tmp_path / "shards")
    matrix = manifest["matrices"]["tract"]["weekday_am"]
    raw = (tmp_path / matrix["binary"]).read_bytes()
    values = struct.unpack("<8h", raw)

    assert values == (0, 5, 5, 0, -1, 0, 0, -1)
    index = json.loads((tmp_path / matrix["index"]).read_text(encoding="utf-8"))
    assert index["dtype"] == "int16"
    assert index["endian"] == "little"
    assert index["station_rows"] == {"S1": [0], "S2": [1]}
    assert index["row_by_id"] == {"A": 0, "B": 1}
