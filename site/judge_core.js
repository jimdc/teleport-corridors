export function paretoFront(items, { minimize = [], maximize = [] } = {}) {
  if (!Array.isArray(items)) return [];
  const dominates = (a, b) => {
    let better = false;
    for (const key of minimize) {
      if (a[key] > b[key]) return false;
      if (a[key] < b[key]) better = true;
    }
    for (const key of maximize) {
      if (a[key] < b[key]) return false;
      if (a[key] > b[key]) better = true;
    }
    return better;
  };
  return items.filter((item, i) => !items.some((other, j) => j !== i && dominates(other, item)));
}

export function scoreItems(items, { weights, ranges, invert = {} } = {}) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    let score = 0;
    for (const [key, weight] of Object.entries(weights || {})) {
      if (!weight) continue;
      const range = ranges?.[key] || { min: 0, max: 1 };
      const denom = range.max - range.min || 1;
      let t = (item[key] - range.min) / denom;
      if (invert[key]) t = 1 - t;
      score += weight * t;
    }
    return { ...item, score };
  });
}

export function evaluateThresholds(metrics, thresholds) {
  const reasons = [];
  if (!metrics || !thresholds) return reasons;
  const { commute, walk, lines } = metrics;
  const { maxCommute, maxWalk, minLines } = thresholds;
  if (commute == null || !Number.isFinite(commute)) {
    reasons.push("Commute unavailable");
  } else if (maxCommute != null && commute > maxCommute) {
    reasons.push(`Commute ${Math.round(commute)}m > ${maxCommute}m`);
  }
  if (walk == null || !Number.isFinite(walk)) {
    reasons.push("Walk unavailable");
  } else if (maxWalk != null && walk > maxWalk) {
    reasons.push(`Walk ${walk.toFixed(1)}m > ${maxWalk}m`);
  }
  if (minLines != null) {
    const lineCount = Number.isFinite(lines) ? lines : 0;
    if (lineCount < minLines) {
      reasons.push(`Only ${lineCount} lines (<${minLines})`);
    }
  }
  return reasons;
}

export function computeTipping(top, runnerUp, { ranges, weights } = {}) {
  if (!top || !runnerUp) return null;
  const diff = runnerUp.score - top.score;
  if (!Number.isFinite(diff) || diff <= 0) return null;
  const deltas = {};
  for (const [key, weight] of Object.entries(weights || {})) {
    if (!weight) continue;
    const range = ranges?.[key];
    if (!range) continue;
    const span = range.max - range.min || 1;
    const delta = (diff * span) / weight;
    if (Number.isFinite(delta)) deltas[key] = delta;
  }
  return deltas;
}
