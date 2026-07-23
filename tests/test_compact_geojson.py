import json
import tempfile
import unittest
from pathlib import Path

from tools.compact_geojson import (
    COORDINATE_PRECISION,
    compact_geometry,
    ring_is_simple,
    simplify_ring,
    write_compact_geojson,
)


def signed_area(ring):
    return 0.5 * sum(
        ring[index][0] * ring[index + 1][1]
        - ring[index + 1][0] * ring[index][1]
        for index in range(len(ring) - 1)
    )


class TestCompactGeojson(unittest.TestCase):
    def test_simplifies_closed_ring_without_changing_orientation(self):
        ring = [
            [-74.0000041, 40.7000041],
            [-73.9999001, 40.7000039],
            [-73.9998001, 40.7000042],
            [-73.9900003, 40.7000002],
            [-73.9900002, 40.7100004],
            [-74.0000004, 40.7100001],
            [-74.0000041, 40.7000041],
        ]

        compacted = simplify_ring(ring)

        self.assertLess(len(compacted), len(ring))
        self.assertEqual(compacted[0], compacted[-1])
        self.assertTrue(ring_is_simple(compacted))
        self.assertGreater(signed_area(ring) * signed_area(compacted), 0)
        for point in compacted:
            for coordinate in point:
                self.assertEqual(coordinate, round(coordinate, COORDINATE_PRECISION))

    def test_ring_validator_detects_self_intersection(self):
        ring = [
            [0, 0],
            [1, 1],
            [0, 1],
            [1, 0],
            [0, 0],
        ]

        self.assertFalse(ring_is_simple(ring))

    def test_writer_compacts_multipolygon_and_emits_minified_json(self):
        collection = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"name": "test"},
                    "geometry": {
                        "type": "MultiPolygon",
                        "coordinates": [
                            [
                                [
                                    [0.000001, 0.000001],
                                    [1.000001, 0.000001],
                                    [1.000001, 1.000001],
                                    [0.000001, 1.000001],
                                    [0.000001, 0.000001],
                                ]
                            ]
                        ],
                    },
                }
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "output.geojson"
            write_compact_geojson(output, collection)
            encoded = output.read_text(encoding="utf-8")
            decoded = json.loads(encoded)

        self.assertNotIn(": ", encoded)
        ring = decoded["features"][0]["geometry"]["coordinates"][0][0]
        self.assertEqual(ring[0], ring[-1])
        self.assertTrue(ring_is_simple(ring))

    def test_dissolves_adjacent_rectangle_cells(self):
        geometry = {
            "type": "MultiPolygon",
            "coordinates": [
                [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
                [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]],
            ],
        }

        compact_geometry(geometry)

        self.assertEqual(len(geometry["coordinates"]), 1)
        ring = geometry["coordinates"][0][0]
        self.assertEqual(len(ring), 5)
        self.assertAlmostEqual(signed_area(ring), 2.0)

    def test_committed_geometry_payload_stays_under_one_megabyte(self):
        data_dir = Path(__file__).resolve().parents[1] / "site" / "data"
        paths = [
            data_dir / "neighborhoods.geojson",
            data_dir / "derived_regions.geojson",
        ]
        self.assertLessEqual(sum(path.stat().st_size for path in paths), 1_000_000)


if __name__ == "__main__":
    unittest.main()
