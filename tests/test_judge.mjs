import assert from "assert/strict";
import { paretoFront, evaluateThresholds, scoreItems, computeTipping } from "../site/judge_core.js";

const items = [
  { id: "a", commute: 10, walk: 5, lines: 3 },
  { id: "b", commute: 12, walk: 6, lines: 3 }, // dominated by a
  { id: "c", commute: 9, walk: 7, lines: 1 },
];

const front = paretoFront(items, { minimize: ["commute", "walk"], maximize: ["lines"] });
assert.equal(front.length, 2);
assert.ok(front.find((d) => d.id === "a"));
assert.ok(front.find((d) => d.id === "c"));

const thresholds = { maxCommute: 45, maxWalk: 10, minLines: 2 };
const reasons = evaluateThresholds({ commute: 60, walk: 12, lines: 1 }, thresholds);
assert.equal(reasons.length, 3);

const ranges = { commute: { min: 10, max: 20 }, walk: { min: 5, max: 15 }, lines: { min: 1, max: 4 } };
const weights = { commute: 0.5, walk: 0.3, lines: 0.2 };
const scored = scoreItems(
  [
    { id: "x", commute: 10, walk: 5, lines: 4 },
    { id: "y", commute: 18, walk: 12, lines: 1 },
  ],
  { weights, ranges, invert: { lines: true } },
);
assert.ok(scored.find((d) => d.id === "x").score < scored.find((d) => d.id === "y").score);

const tipping = computeTipping(scored[0], scored[1], { ranges, weights });
assert.ok(tipping.commute > 0);
