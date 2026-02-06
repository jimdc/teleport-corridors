import { paretoFront, scoreItems, evaluateThresholds, computeTipping } from "./judge_core.js";

const DATA_DIR = "./data";
const ISOCHRONE_MINUTES = [15, 30, 45, 60, 90, 120, 150, 180];
const HUE_BY_LINE_ALWAYS_ON = true;
const ISOCHRONES_ALWAYS_ON = true;
const TELEPORT_EXPECTED_SPEED_KM_PER_MIN = 0.25; // ~15 km/h baseline for "minutes saved"
const WALK_SPEED_KM_PER_MIN = 0.0833; // 5 km/h walking speed
const LINE_RADIUS_KM = 0.65; // ~650m walk radius
const LABEL_BUDGET = 12;
const SPOKE_LABEL_COUNT = 10;
let walkMinutesById = new Map();
let lineCountById = new Map();
let neighborhoods = [];
let routes = [];
let stops = [];
let edges = [];
const HUB_HEX = {
  manhattan: "#06b6d4",
  brooklyn: "#10b981",
  queens: "#f59e0b",
};
const LIVING_COLORS = {
  teleportness: { r: 16, g: 185, b: 129 }, // emerald
};
const VIEWS_COLOR = { r: 59, g: 130, b: 246 }; // blue

const SCALAR_REGISTRY = {
  population: {
    label: "Population",
    valueKeys: [
      "population",
      "pop",
      "POPULATION",
      "POP",
      "Pop",
      "Population",
      "TotalPop",
      "TOTALPOP",
      "TotPop",
      "POP20",
      "POP2020",
      "POP2010",
      "P0010001",
    ],
    provider: (feature, ctx = {}) => {
      const props = feature?.properties || {};
      const keys = SCALAR_REGISTRY.population.valueKeys || [];
      for (const k of keys) {
        const v = parseNumber(props[k]);
        if (v != null) return v;
      }
      const id = String(props.atlas_id || "");
      const csvMap = ctx.csv || null;
      if (csvMap && id) {
        const v = csvMap.get(id);
        return v != null ? v : null;
      }
      return null;
    },
  },
  housing_units: {
    label: "Housing units",
    valueKeys: ["housing_units", "housingunits", "HousingUnits", "HU", "H0010001", "H0010002"],
    provider: (feature, ctx = {}) => {
      const props = feature?.properties || {};
      const keys = SCALAR_REGISTRY.housing_units.valueKeys || [];
      for (const k of keys) {
        const v = parseNumber(props[k]);
        if (v != null) return v;
      }
      const id = String(props.atlas_id || "");
      const csvMap = ctx.csv || null;
      if (csvMap && id) {
        const v = csvMap.get(id);
        return v != null ? v : null;
      }
      return null;
    },
  },
  jobs: {
    label: "Jobs",
    valueKeys: ["jobs", "employment", "emp", "jobs_total", "total_jobs"],
    provider: (feature, ctx = {}) => {
      const props = feature?.properties || {};
      const keys = SCALAR_REGISTRY.jobs.valueKeys || [];
      for (const k of keys) {
        const v = parseNumber(props[k]);
        if (v != null) return v;
      }
      const id = String(props.atlas_id || "");
      const csvMap = ctx.csv || null;
      if (csvMap && id) {
        const v = csvMap.get(id);
        return v != null ? v : null;
      }
      return null;
    },
  },
};

const VIEW_REGISTRY = {
  population: {
    label: "Population",
    higherIsBetter: true,
    unit: "people",
    type: "scalar",
    scalarKey: "population",
    description: "Total population in each region.",
  },
  population_density: {
    label: "Population density",
    higherIsBetter: true,
    unit: "people/km²",
    type: "density",
    scalarKey: "population",
    description: "Population divided by area.",
  },
  reachable_pop_30: {
    label: "Population within 30 min",
    higherIsBetter: true,
    unit: "people",
    type: "reachable",
    scalarKey: "population",
    threshold: 30,
    description: "Population reachable by subway within 30 minutes.",
  },
  reachable_pop_40: {
    label: "Population within 40 min",
    higherIsBetter: true,
    unit: "people",
    type: "reachable",
    scalarKey: "population",
    threshold: 40,
    description: "Population reachable by subway within 40 minutes.",
  },
  housing_units: {
    label: "Housing units",
    higherIsBetter: true,
    unit: "units",
    type: "scalar",
    scalarKey: "housing_units",
    description: "Housing units (requires a local CSV).",
    requiresScalar: "housing_units",
  },
  jobs: {
    label: "Jobs",
    higherIsBetter: true,
    unit: "jobs",
    type: "scalar",
    scalarKey: "jobs",
    description: "Jobs per neighborhood (requires a local CSV).",
    requiresScalar: "jobs",
  },
  reachable_jobs_30: {
    label: "Jobs within 30 min",
    higherIsBetter: true,
    unit: "jobs",
    type: "reachable",
    scalarKey: "jobs",
    threshold: 30,
    description: "Jobs reachable within 30 minutes (requires a jobs CSV).",
    requiresScalar: "jobs",
  },
  reachable_jobs_40: {
    label: "Jobs within 40 min",
    higherIsBetter: true,
    unit: "jobs",
    type: "reachable",
    scalarKey: "jobs",
    threshold: 40,
    description: "Jobs reachable within 40 minutes (requires a jobs CSV).",
    requiresScalar: "jobs",
  },
};

const SCALAR_KEYS = Object.keys(SCALAR_REGISTRY);
const DEFAULT_SCALAR_KEY = "population";
let availableScalarKeys = null;

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const a = sorted[base];
  const b = sorted[Math.min(sorted.length - 1, base + 1)];
  return a + (b - a) * rest;
}

function parseNumber(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  const cleaned = s.replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function formatNumber(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

function getMaxMinutes() {
  const el = document.getElementById("maxMinutes");
  if (!el) return 90;
  const v = Number(el.value || "90");
  return Number.isFinite(v) ? v : 90;
}

function minutesToFill(mins, maxMinutes) {
  if (mins == null) return { fill: "rgba(0,0,0,0)", fillOpacity: 1 };
  if (mins > maxMinutes) return { fill: "rgba(2,6,23,0.03)", fillOpacity: 1 };
  const t = clamp01(mins / maxMinutes);
  const strength = Math.pow(1 - t, 1.6);
  const alpha = 0.06 + 0.82 * strength;
  return { fill: `rgba(239,68,68,${alpha.toFixed(4)})`, fillOpacity: 1 };
}

function hexToRgb(hex) {
  if (!hex) return null;
  const h = String(hex).trim().replace(/^#/, "");
  if (h.length !== 6) return null;
  const n = Number.parseInt(h, 16);
  if (!Number.isFinite(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function hubColor(boroKeyValue, alpha = 0.65) {
  const rgb = hexToRgb(HUB_HEX[boroKeyValue]) || { r: 99, g: 102, b: 241 };
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
}

function minutesToFillHue(mins, maxMinutes, hexColor) {
  if (mins == null) return { fill: "rgba(0,0,0,0)", fillOpacity: 1 };
  if (mins > maxMinutes) return { fill: "rgba(2,6,23,0.03)", fillOpacity: 1 };
  const rgb = hexToRgb(hexColor) || { r: 239, g: 68, b: 68 };
  const t = clamp01(mins / maxMinutes);
  const strength = Math.pow(1 - t, 1.6);
  const alpha = 0.06 + 0.82 * strength;
  return { fill: `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha.toFixed(4)})`, fillOpacity: 1 };
}

function centralityToFill(score, min, max) {
  if (score == null || !Number.isFinite(score)) return { fill: "rgba(2,6,23,0.03)", fillOpacity: 1 };
  const denom = max - min;
  const t = denom > 0 ? clamp01((score - min) / denom) : 0.5;
  const alpha = 0.08 + 0.84 * Math.pow(t, 1.25);
  return { fill: `rgba(99,102,241,${alpha.toFixed(4)})`, fillOpacity: 1 };
}

function livingToFill(score, min, max, rgb) {
  if (score == null || !Number.isFinite(score)) return { fill: "rgba(2,6,23,0.02)", fillOpacity: 1 };
  const denom = max - min;
  const t = denom > 0 ? clamp01((score - min) / denom) : 0.5;
  const alpha = 0.06 + 0.86 * Math.pow(t, 1.22);
  const c = rgb || { r: 16, g: 185, b: 129 };
  return { fill: `rgba(${c.r},${c.g},${c.b},${alpha.toFixed(4)})`, fillOpacity: 1 };
}

function viewsToFill(score, min, max) {
  if (score == null || !Number.isFinite(score)) return { fill: "rgba(2,6,23,0.02)", fillOpacity: 1 };
  const denom = max - min;
  const t = denom > 0 ? clamp01((score - min) / denom) : 0.5;
  const alpha = 0.06 + 0.86 * Math.pow(t, 1.22);
  const c = VIEWS_COLOR;
  return { fill: `rgba(${c.r},${c.g},${c.b},${alpha.toFixed(4)})`, fillOpacity: 1 };
}

function formatViewValue(value, unit) {
  if (value == null || !Number.isFinite(value)) return "—";
  const u = String(unit || "").toLowerCase();
  if (u.includes("people")) return `${formatNumber(value)} people`;
  if (u.includes("jobs")) return `${formatNumber(value)} jobs`;
  if (u.includes("units")) return `${formatNumber(value)} units`;
  if (u.includes("km²") || u.includes("km2")) return `${formatNumber(Math.round(value))} ${unit}`;
  return formatNumber(value);
}

function formatRow(name, mins) {
  if (mins == null) return `${name} — unreachable`;
  return `${name} — ${mins} min`;
}

let reportError = (msg) => console.error(msg);

function setReportError(fn) {
  if (typeof fn === "function") reportError = fn;
}

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const msg = `Failed to fetch ${path}: ${res.status}`;
    reportError(msg);
    throw new Error(msg);
  }
  return await res.json();
}

async function fetchText(path) {
  const res = await fetch(path);
  if (!res.ok) return null;
  return await res.text();
}

async function loadScalarManifest() {
  const text = await fetchText(`${DATA_DIR}/scalars_manifest.json`);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const keys = Array.isArray(parsed) ? parsed : parsed?.keys;
    if (!Array.isArray(keys)) return null;
    return keys.map((k) => String(k));
  } catch (err) {
    return null;
  }
}

function parseCsvToMap(text, { idKeys = [], valueKeys = [] } = {}) {
  if (!text) return new Map();
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return new Map();
  const header = lines[0].split(",").map((h) => h.trim());
  const colIndex = (keys) => {
    for (const k of keys) {
      const idx = header.findIndex((h) => h.toLowerCase() === String(k).toLowerCase());
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const idIdx = colIndex(idKeys);
  const valIdx = colIndex(valueKeys);
  if (idIdx < 0 || valIdx < 0) return new Map();

  const out = new Map();
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(",").map((v) => v.trim());
    const id = row[idIdx];
    const val = parseNumber(row[valIdx]);
    if (!id || val == null) continue;
    out.set(String(id), val);
  }
  return out;
}

async function loadScalarCsv(key) {
  const path = `${DATA_DIR}/scalars_${key}.csv`;
  const text = await fetchText(path);
  if (!text) return null;
  const idKeys = ["atlas_id", "id", "nta", "NTACode", "nta_code"];
  const valueKeys = [key, "population", "pop", "value"];
  return parseCsvToMap(text, { idKeys, valueKeys });
}

async function attachScalars(features) {
  if (!features || !features.length) return new Map();
  const scalarValuesByKey = new Map();
  const csvByKey = new Map();
  const allowedKeys = new Set(
    Array.isArray(availableScalarKeys) && availableScalarKeys.length ? availableScalarKeys : ["population"],
  );
  for (const key of SCALAR_KEYS) {
    scalarValuesByKey.set(key, new Map());
    if (allowedKeys.has(key)) {
      csvByKey.set(key, await loadScalarCsv(key));
    } else {
      csvByKey.set(key, null);
    }
  }

  for (const feat of features) {
    const props = feat?.properties ? { ...feat.properties } : {};
    const id = String(props.atlas_id || "");
    if (!props.scalars) props.scalars = {};
    feat.properties = props;

    for (const key of SCALAR_KEYS) {
      let v = null;
      if (props.scalars && props.scalars[key] != null) {
        const n = parseNumber(props.scalars[key]);
        if (n != null) v = n;
      }
      const csvMap = csvByKey.get(key) || null;
      const provider = SCALAR_REGISTRY[key]?.provider;
      if (v == null && typeof provider === "function") {
        v = provider(feat, { csv: csvMap });
      }
      if (v == null) {
        const keys = SCALAR_REGISTRY[key]?.valueKeys || [];
        for (const k of keys) {
          if (props[k] != null) {
            const n = parseNumber(props[k]);
            if (n != null) {
              v = n;
              break;
            }
          }
        }
      }
      if (v == null && csvMap && id) v = csvMap.get(id) ?? null;
      if (v != null && Number.isFinite(v)) {
        props.scalars[key] = v;
        scalarValuesByKey.get(key)?.set(id, v);
      }
    }
  }

  return scalarValuesByKey;
}

function setList(el, rows) {
  el.replaceChildren(
    ...rows.map((r) => {
      const li = document.createElement("li");
      li.textContent = r;
      return li;
    }),
  );
}

function featureName(props) {
  return (
    props.primary_name ||
    props.name ||
    props.NTAName ||
    props.nta_name ||
    props.ntaname ||
    props.neighborhood ||
    props.atlas_id
  );
}

function getBorough(props) {
  if (!props) return "";
  const v = props.boroname || props.BoroName || props.boro_name || props.borough || props.Borough || "";
  return String(v || "").trim();
}

function isTriBorough(name) {
  const b = String(name || "").trim().toLowerCase();
  return b === "manhattan" || b === "brooklyn" || b === "queens";
}

function boroughKey(name) {
  const b = String(name || "").trim().toLowerCase();
  if (b === "manhattan") return "manhattan";
  if (b === "brooklyn") return "brooklyn";
  if (b === "queens") return "queens";
  return null;
}

function boroughAbbrev(name) {
  const k = boroughKey(name);
  if (k === "manhattan") return "M";
  if (k === "brooklyn") return "Bk";
  if (k === "queens") return "Q";
  return "";
}

function renderNameWithBorough(el, name, boroughName, confidence = null) {
  if (!el) return;
  el.replaceChildren();
  const b = boroughAbbrev(boroughName);
  const k = boroughKey(boroughName);
  if (b && k) {
    const pill = document.createElement("span");
    pill.className = `boro-pill boro-${k}`;
    pill.textContent = b;
    el.appendChild(pill);
    el.appendChild(document.createTextNode(" "));
  }
  el.appendChild(document.createTextNode(String(name || "")));
  if (confidence != null && Number.isFinite(confidence)) {
    const badge = document.createElement("span");
    badge.className = "name-confidence";
    badge.textContent = `conf ${Math.round(confidence * 100)}%`;
    el.appendChild(badge);
  }
}

function updatePanel({ originIndex, neighborhoods, minutesRow, routeRow, routes, nameFn }) {
  const fmt = typeof nameFn === "function" ? nameFn : (v) => v;
  const originNameEl = document.getElementById("originName");
  const destNameEl = document.getElementById("destName");
  const routeSummaryEl = document.getElementById("routeSummary");
  const routeStepsEl = document.getElementById("routeSteps");
  const closestEl = document.getElementById("closest");
  const farthestEl = document.getElementById("farthest");
  const withinHintEl = document.getElementById("withinHint");
  const maxMinutes = getMaxMinutes();

  if (!originNameEl || !destNameEl || !routeSummaryEl || !routeStepsEl || !closestEl || !farthestEl || !withinHintEl) {
    return;
  }

  if (originIndex == null) {
    originNameEl.textContent = "Click a neighborhood";
    destNameEl.textContent = "Hover a neighborhood";
    routeSummaryEl.textContent = "";
    setList(routeStepsEl, []);
    setList(closestEl, []);
    setList(farthestEl, []);
    withinHintEl.textContent = "";
    return;
  }

  const origin = neighborhoods[originIndex];
  renderNameWithBorough(
    originNameEl,
    fmt(nameForId(origin.id)),
    boroughForId(origin.id),
    confidenceForId(origin.id),
  );

  const rows = neighborhoods.map((n, idx) => ({
    idx,
    name: fmt(nameForId(n.id)),
    mins: minutesRow[idx],
    routeIdx: routeRow?.[idx] ?? null,
  }));

  const reachable = rows
    .filter((r) => r.idx !== originIndex && r.mins != null)
    .sort((a, b) => a.mins - b.mins);
  const unreachable = rows.filter((r) => r.idx !== originIndex && r.mins == null);
  const within = reachable.filter((r) => r.mins <= maxMinutes);

  const routeTag = (routeIdx) => {
    if (routeIdx == null) return "";
    const r = routes?.[routeIdx];
    const label = r?.short_name || r?.id;
    return label ? ` · ${label}` : "";
  };

  const closest = reachable
    .slice(0, 10)
    .map((r) => `${formatRow(r.name, r.mins)}${routeTag(r.routeIdx)}`);
  const farthest = reachable
    .slice(-10)
    .reverse()
    .map((r) => `${formatRow(r.name, r.mins)}${routeTag(r.routeIdx)}`);

  withinHintEl.textContent = `${within.length} within ${maxMinutes} min`;
  if (unreachable.length) farthest.push(`${unreachable.length} unreachable`);

  setList(closestEl, closest);
  setList(farthestEl, farthest);
}

// --- Minimal SVG "map" (Web Mercator projection + pan/zoom via viewBox) ---

function mercatorY(latDeg) {
  const lat = (Math.max(-85, Math.min(85, latDeg)) * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + lat / 2));
}

function projectLonLat([lon, lat]) {
  // Use Web Mercator radians for both axes so aspect ratio is sane.
  // Negate Y so north is up (SVG Y grows downward).
  const x = (lon * Math.PI) / 180;
  const y = -mercatorY(lat);
  return [x, y];
}

function haversineKm([lat1, lon1], [lat2, lon2]) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1);
  const dl = toRad(lon2 - lon1);
  const a =
    Math.sin(dp / 2) * Math.sin(dp / 2) +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

const computeWalkLineMetrics = () => {
  walkMinutesById = new Map();
  lineCountById = new Map();
  if (!stops?.length || !neighborhoods?.length) return;

  const routesByStop = Array.from({ length: stops.length }, () => new Set());
  for (const e of edges || []) {
    const ri = e?.[3];
    if (ri == null) continue;
    const a = e?.[0];
    const b = e?.[1];
    if (routesByStop[a]) routesByStop[a].add(ri);
    if (routesByStop[b]) routesByStop[b].add(ri);
  }

  const routeKey = (idx) => {
    const r = routes?.[idx];
    return r?.short_name || r?.id || String(idx);
  };

  for (const n of neighborhoods) {
    const id = String(n.id);
    const c = n?.centroid;
    if (!Array.isArray(c) || c.length < 2) {
      walkMinutesById.set(id, null);
      lineCountById.set(id, 0);
      continue;
    }
    let best = null;
    const lineSet = new Set();
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      if (!s) continue;
      const d = haversineKm([c[0], c[1]], [s.lat, s.lon]);
      if (!Number.isFinite(d)) continue;
      if (best == null || d < best) best = d;
      if (d <= LINE_RADIUS_KM) {
        for (const r of routesByStop[i]) lineSet.add(routeKey(r));
      }
    }
    const walkMinutes = best != null ? (best / WALK_SPEED_KM_PER_MIN) : null;
    walkMinutesById.set(id, walkMinutes);
    lineCountById.set(id, lineSet.size);
  }
};

function* iterLonLatCoords(geometry) {
  if (!geometry) return;
  const t = geometry.type;
  const c = geometry.coordinates;
  if (!c) return;

  const yieldRing = function* (ring) {
    for (const pt of ring) {
      if (Array.isArray(pt) && pt.length >= 2) yield [pt[0], pt[1]];
    }
  };

  if (t === "Polygon") {
    for (const ring of c) yield* yieldRing(ring);
  } else if (t === "MultiPolygon") {
    for (const poly of c) for (const ring of poly) yield* yieldRing(ring);
  } else if (t === "Point") {
    if (Array.isArray(c) && c.length >= 2) yield [c[0], c[1]];
  }
}

function ringAreaKm2(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  const toRad = (d) => (d * Math.PI) / 180;
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i + 1];
    const kmPerDegLon1 = 111.32 * Math.cos(toRad(lat1));
    const kmPerDegLon2 = 111.32 * Math.cos(toRad(lat2));
    const x1 = lon1 * kmPerDegLon1;
    const y1 = lat1 * 111.32;
    const x2 = lon2 * kmPerDegLon2;
    const y2 = lat2 * 111.32;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

function geometryAreaKm2(geometry) {
  if (!geometry) return 0;
  const t = geometry.type;
  const c = geometry.coordinates;
  if (!c) return 0;
  let total = 0;
  if (t === "Polygon") {
    for (let i = 0; i < c.length; i++) {
      const ring = c[i];
      const a = ringAreaKm2(ring);
      total += i === 0 ? a : -a;
    }
  } else if (t === "MultiPolygon") {
    for (const poly of c) {
      for (let i = 0; i < poly.length; i++) {
        const ring = poly[i];
        const a = ringAreaKm2(ring);
        total += i === 0 ? a : -a;
      }
    }
  }
  return Math.abs(total);
}

function computeViewBox(geojson) {
  const bounds = computeProjectedBounds(geojson);
  const padX = (bounds.maxX - bounds.minX) * 0.03;
  const padY = (bounds.maxY - bounds.minY) * 0.03;
  return {
    x: bounds.minX - padX,
    y: bounds.minY - padY,
    w: (bounds.maxX - bounds.minX) + 2 * padX,
    h: (bounds.maxY - bounds.minY) + 2 * padY,
  };
}

function formatScalarValue(key, value) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (key === "population") return `${formatNumber(value)} people`;
  if (key === "housing_units") return `${formatNumber(value)} units`;
  if (key === "jobs") return `${formatNumber(value)} jobs`;
  return formatNumber(value);
}

function computeDorlingCartogram({
  features,
  scalarKey,
  getValue,
  getCentroid,
  viewBox,
  iterations = 360,
  anchorStrength = 0.12,
  collisionStrength = 0.5,
  padding = 0.00015,
  minRadius = 0.00007,
  clampQuantile = null,
} = {}) {
  if (!features || !features.length) return [];
  const nodes = [];
  const values = [];

  for (const feat of features) {
    const props = feat?.properties || {};
    const id = String(props.atlas_id || "");
    if (!id) continue;
    const c = getCentroid ? getCentroid(feat) : null;
    if (!c) continue;
    const v = getValue ? getValue(feat, scalarKey) : null;
    if (v != null && Number.isFinite(v)) values.push(v);
    nodes.push({
      id,
      x0: c.x,
      y0: c.y,
      x: c.x,
      y: c.y,
      value: v,
    });
  }

  if (!nodes.length) return [];

  const finite = values.slice().sort((a, b) => a - b);
  let cap = null;
  if (clampQuantile != null && finite.length) {
    cap = quantile(finite, clampQuantile);
  }

  const areaScale = (val) => {
    if (val == null || !Number.isFinite(val) || val <= 0) return 0;
    const v = cap != null && Number.isFinite(cap) ? Math.min(val, cap) : val;
    return Math.sqrt(v / Math.PI);
  };

  const rawAreas = nodes.map((n) => areaScale(n.value)).filter((v) => v > 0);
  const medianRaw = rawAreas.length ? quantile(rawAreas.sort((a, b) => a - b), 0.5) : 1;
  const targetMedianRadius = viewBox ? Math.min(viewBox.w, viewBox.h) * 0.017 : 0.002;
  const k = medianRaw > 0 ? targetMedianRadius / medianRaw : 1;

  for (const n of nodes) {
    const r0 = k * areaScale(n.value);
    n.r = Math.max(minRadius, Number.isFinite(r0) && r0 > 0 ? r0 : minRadius);
  }

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.000001;
        const minDist = a.r + b.r + padding;
        if (dist >= minDist) continue;
        const overlap = (minDist - dist) * collisionStrength;
        const ux = dx / dist;
        const uy = dy / dist;
        const shift = overlap * 0.5;
        a.x -= ux * shift;
        a.y -= uy * shift;
        b.x += ux * shift;
        b.y += uy * shift;
      }
    }

    for (const n of nodes) {
      n.x += (n.x0 - n.x) * anchorStrength;
      n.y += (n.y0 - n.y) * anchorStrength;
    }
  }

  return nodes;
}

function geometryToPathD(geometry) {
  const t = geometry.type;
  const c = geometry.coordinates;
  if (!c) return "";

  const ringToD = (ring) => {
    let d = "";
    for (let i = 0; i < ring.length; i++) {
      const pt = ring[i];
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const [x, y] = projectLonLat(pt);
      d += `${i === 0 ? "M" : "L"} ${x} ${y} `;
    }
    d += "Z ";
    return d;
  };

  if (t === "Polygon") {
    return c.map(ringToD).join("");
  }
  if (t === "MultiPolygon") {
    return c.map((poly) => poly.map(ringToD).join("")).join("");
  }
  return "";
}

function computeProjectedBounds(geojson) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const feat of geojson.features || []) {
    for (const ll of iterLonLatCoords(feat.geometry)) {
      const [x, y] = projectLonLat(ll);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (!Number.isFinite(minX)) throw new Error("Could not compute bounds (empty GeoJSON?)");
  return { minX, minY, maxX, maxY };
}

function setSvgViewBox(svg, vb) {
  svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
}

function readViewBox(svg) {
  const raw = svg.getAttribute("viewBox");
  if (!raw) return null;
  const parts = raw.split(/\s+/).map((v) => Number(v));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = parts;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function setSvgViewBoxPixels(svg, width, height) {
  if (!svg) return;
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
}

function ensureValidViewBox(svg) {
  const vb = readViewBox(svg);
  if (vb) return vb;
  const fallback = svg.__atlasInitialViewBox;
  if (fallback) {
    setSvgViewBox(svg, { ...fallback });
    return fallback;
  }
  return null;
}

function formatViewBox(vb) {
  if (!vb) return "viewBox=?";
  const f = (n) => (Math.round(n * 1000) / 1000).toFixed(3);
  return `vb ${f(vb.x)} ${f(vb.y)} ${f(vb.w)} ${f(vb.h)}`;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function svgPointFromClient(svg, clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  const px = (clientX - rect.left) / rect.width;
  const py = (clientY - rect.top) / rect.height;

  const vb = ensureValidViewBox(svg);
  if (!vb) return null;
  const { x, y, w, h } = vb;
  return { x: x + px * w, y: y + py * h };
}

function installPanZoom(svg, { onViewBoxChange } = {}) {
  let isDragging = false;
  let last = null;
  let activePointerId = null;

  svg.addEventListener("pointerdown", (e) => {
    // If the user started on a neighborhood path, let the path handle clicks.
    if (e.target && typeof e.target.closest === "function" && e.target.closest("path")) return;
    activePointerId = e.pointerId;
    svg.setPointerCapture(e.pointerId);
    isDragging = true;
    last = { x: e.clientX, y: e.clientY };
  });

  svg.addEventListener("pointerup", (e) => {
    try {
      if (activePointerId === e.pointerId) svg.releasePointerCapture(e.pointerId);
    } catch {}
    isDragging = false;
    last = null;
    activePointerId = null;
  });

  svg.addEventListener("pointercancel", (e) => {
    try {
      if (activePointerId === e.pointerId) svg.releasePointerCapture(e.pointerId);
    } catch {}
    isDragging = false;
    last = null;
    activePointerId = null;
  });

  svg.addEventListener("pointermove", (e) => {
    if (!isDragging || !last || activePointerId !== e.pointerId) return;
    const rect = svg.getBoundingClientRect();
    const dxPx = e.clientX - last.x;
    const dyPx = e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };

    const vb = ensureValidViewBox(svg);
    if (!vb) return;
    const { x, y, w, h } = vb;
    const dx = (-dxPx / rect.width) * w;
    const dy = (-dyPx / rect.height) * h;
    setSvgViewBox(svg, { x: x + dx, y: y + dy, w, h });
    onViewBoxChange?.(readViewBox(svg));
  });

  svg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const vb = ensureValidViewBox(svg);
      if (!vb) return;
      const zoomIn = e.deltaY < 0;
      const factor = zoomIn ? 0.9 : 1.1;

      const { x, y, w, h } = vb;
      const p = svgPointFromClient(svg, e.clientX, e.clientY);
      if (!p) return;

      const nw = w * factor;
      const nh = h * factor;

      const rx = (p.x - x) / w;
      const ry = (p.y - y) / h;

      const nx = p.x - rx * nw;
      const ny = p.y - ry * nh;

      setSvgViewBox(svg, { x: nx, y: ny, w: nw, h: nh });
      onViewBoxChange?.(readViewBox(svg));
    },
    { passive: false },
  );
}

function renderGeojson(svg, geojson, onClickFeature, options = {}) {
  svg.replaceChildren();

  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const gOutline = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gPolys = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gHubHalos = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gIsochrones = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gOverlay = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gOverlayRoutes = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gOverlayStops = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gLivingNodes = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gHubMarkers = document.createElementNS("http://www.w3.org/2000/svg", "g");
  // Overlays should never block neighborhood clicks/drags.
  gIsochrones.setAttribute("pointer-events", "none");
  gOverlay.setAttribute("pointer-events", "none");
  gOverlayRoutes.setAttribute("pointer-events", "none");
  gOverlayStops.setAttribute("pointer-events", "none");
  gLivingNodes.setAttribute("pointer-events", "none");
  gHubHalos.setAttribute("pointer-events", "none");
  gHubMarkers.setAttribute("pointer-events", "none");
  gOutline.setAttribute("pointer-events", "none");
  gOverlay.appendChild(gOverlayRoutes);
  gOverlay.appendChild(gOverlayStops);
  gOverlay.appendChild(gLivingNodes);
  svg.appendChild(gOutline);
  svg.appendChild(gHubHalos);
  svg.appendChild(gPolys);
  svg.appendChild(gIsochrones);
  svg.appendChild(gOverlay);
  svg.appendChild(gHubMarkers);

  const vb = options.viewBox || computeViewBox(geojson);
  setSvgViewBox(svg, vb);

  const pathById = new Map();

  const outlineGeo = options.outlineGeo;
  const outlineStyle = options.outlineStyle || {};
  if (outlineGeo?.features?.length) {
    for (const feat of outlineGeo.features || []) {
      const d = geometryToPathD(feat.geometry);
      if (!d) continue;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("vector-effect", "non-scaling-stroke");
      path.setAttribute("fill", outlineStyle.fill || "none");
      path.setAttribute("stroke", outlineStyle.stroke || "rgba(15,23,42,0.55)");
      path.setAttribute("stroke-width", String(outlineStyle.strokeWidth ?? 2.2));
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("stroke-linecap", "round");
      if (outlineStyle.opacity != null) path.setAttribute("opacity", String(outlineStyle.opacity));
      gOutline.appendChild(path);
    }
  }

  for (const feat of geojson.features || []) {
    const props = feat.properties || {};
    const id = String(props.atlas_id);
    const d = geometryToPathD(feat.geometry);
    if (!d) continue;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("vector-effect", "non-scaling-stroke");
    path.setAttribute("fill", "rgba(0,0,0,0)");
    path.setAttribute("stroke", "rgba(15,23,42,0.35)");
    path.setAttribute("stroke-width", "1.2");
    path.style.cursor = "pointer";
    path.style.pointerEvents = "all";

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    if (typeof options.titleFn === "function") {
      title.textContent = String(options.titleFn(feat, props) || featureName(props));
    } else {
      title.textContent = String(featureName(props));
    }
    path.appendChild(title);

    path.addEventListener("click", (e) => {
      e.stopPropagation();
      onClickFeature(id, e);
    });

    path.addEventListener("pointerenter", () => {
      if (typeof onClickFeature.onHover === "function") onClickFeature.onHover(id);
    });
    path.addEventListener("pointerleave", () => {
      if (typeof onClickFeature.onHoverEnd === "function") onClickFeature.onHoverEnd(id);
    });

    gPolys.appendChild(path);
    pathById.set(id, path);
  }

  return {
    pathById,
    gIsochrones,
    gOverlayRoutes,
    gOverlayStops,
    gLivingNodes,
    gHubHalos,
    gHubMarkers,
    initialViewBox: vb,
  };
}

function renderCartogram(svg, nodes, onClickFeature, options = {}) {
  svg.replaceChildren();

  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const gPolys = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gHubHalos = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gIsochrones = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gOverlay = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gOverlayRoutes = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gOverlayStops = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gLivingNodes = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gHubMarkers = document.createElementNS("http://www.w3.org/2000/svg", "g");
  gIsochrones.setAttribute("pointer-events", "none");
  gOverlay.setAttribute("pointer-events", "none");
  gOverlayRoutes.setAttribute("pointer-events", "none");
  gOverlayStops.setAttribute("pointer-events", "none");
  gLivingNodes.setAttribute("pointer-events", "none");
  gHubHalos.setAttribute("pointer-events", "none");
  gHubMarkers.setAttribute("pointer-events", "none");
  gOverlay.appendChild(gOverlayRoutes);
  gOverlay.appendChild(gOverlayStops);
  gOverlay.appendChild(gLivingNodes);
  svg.appendChild(gHubHalos);
  svg.appendChild(gPolys);
  svg.appendChild(gIsochrones);
  svg.appendChild(gOverlay);
  svg.appendChild(gHubMarkers);

  const vb = options.viewBox;
  if (vb) setSvgViewBox(svg, vb);

  const pathById = new Map();
  for (const n of nodes) {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", String(n.x));
    circle.setAttribute("cy", String(n.y));
    circle.setAttribute("r", String(n.r));
    circle.setAttribute("vector-effect", "non-scaling-stroke");
    circle.setAttribute("fill", "rgba(0,0,0,0)");
    circle.setAttribute("stroke", "rgba(15,23,42,0.35)");
    circle.setAttribute("stroke-width", "1.2");
    circle.style.cursor = "pointer";
    circle.style.pointerEvents = "all";

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    if (typeof options.titleFn === "function") {
      title.textContent = String(options.titleFn(n) || n.id);
    } else {
      title.textContent = String(n.id);
    }
    circle.appendChild(title);

    circle.addEventListener("click", (e) => {
      e.stopPropagation();
      onClickFeature(n.id, e);
    });
    circle.addEventListener("pointerenter", () => {
      if (typeof onClickFeature.onHover === "function") onClickFeature.onHover(n.id);
    });
    circle.addEventListener("pointerleave", () => {
      if (typeof onClickFeature.onHoverEnd === "function") onClickFeature.onHoverEnd(n.id);
    });

    gPolys.appendChild(circle);
    pathById.set(String(n.id), circle);
  }

  return {
    pathById,
    gIsochrones,
    gOverlayRoutes,
    gOverlayStops,
    gLivingNodes,
    gHubHalos,
    gHubMarkers,
    initialViewBox: vb,
  };
}

class MinHeap {
  constructor() {
    this.arr = [];
  }
  push(item) {
    this.arr.push(item);
    this._siftUp(this.arr.length - 1);
  }
  pop() {
    if (this.arr.length === 0) return null;
    const top = this.arr[0];
    const last = this.arr.pop();
    if (this.arr.length && last) {
      this.arr[0] = last;
      this._siftDown(0);
    }
    return top;
  }
  _siftUp(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.arr[p][0] <= this.arr[i][0]) break;
      [this.arr[p], this.arr[i]] = [this.arr[i], this.arr[p]];
      i = p;
    }
  }
  _siftDown(i) {
    const n = this.arr.length;
    while (true) {
      let m = i;
      const l = i * 2 + 1;
      const r = i * 2 + 2;
      if (l < n && this.arr[l][0] < this.arr[m][0]) m = l;
      if (r < n && this.arr[r][0] < this.arr[m][0]) m = r;
      if (m === i) break;
      [this.arr[m], this.arr[i]] = [this.arr[i], this.arr[m]];
      i = m;
    }
  }
}

function dijkstraWithPrev(adj, start) {
  const n = adj.length;
  const dist = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  const prevRoute = new Array(n).fill(null); // routeIdx (null for transfer)
  const firstRoute = new Array(n).fill(null); // first non-transfer routeIdx

  dist[start] = 0;
  const heap = new MinHeap();
  heap.push([0, start]);

  while (true) {
    const item = heap.pop();
    if (!item) break;
    const [d, u] = item;
    if (d !== dist[u]) continue;
    for (const e of adj[u]) {
      const v = e.to;
      const nd = d + e.w;
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        prevRoute[v] = e.routeIdx;
        const inherited = firstRoute[u];
        firstRoute[v] = inherited != null ? inherited : e.routeIdx != null ? e.routeIdx : null;
        heap.push([nd, v]);
      }
    }
  }

  return { dist, prev, prevRoute, firstRoute };
}

function reconstructStopPath(prev, start, dest) {
  const path = [];
  let cur = dest;
  while (cur !== -1 && cur !== start) {
    path.push(cur);
    cur = prev[cur];
  }
  if (cur !== start) return null;
  path.push(start);
  path.reverse();
  return path;
}

async function main() {
  const statusEl = document.getElementById("status");
  const errorBannerEl = document.getElementById("errorBanner");
  const viewModeEl = document.getElementById("viewMode");
  const profileRadios = Array.from(document.querySelectorAll('input[name="profile"]'));
  const maxMinutesEl = document.getElementById("maxMinutes");
  const maxMinutesLabelEl = document.getElementById("maxMinutesLabel");
  const legendMaxEl = document.getElementById("legendMax");
  const compactNamesEl = document.getElementById("compactNames");
  const mapModeRadios = Array.from(document.querySelectorAll('input[name="mapMode"]'));
  const baseUnitRadios = Array.from(document.querySelectorAll('input[name="baseUnit"]'));
  const cartogramScalarSelectEl = document.getElementById("cartogramScalarSelect");
  const cartogramScalarValueEl = document.getElementById("cartogramScalarValue");
  const cartogramScalarWrapEl = document.getElementById("cartogramScalarWrap");
  const cartogramScalarHintEl = document.getElementById("cartogramScalarHint");
  const cartogramLegendNoteEl = document.getElementById("cartogramLegendNote");
  const viewsMetricSelectEl = document.getElementById("viewsMetricSelect");
  const viewsMetricNoteEl = document.getElementById("viewsMetricNote");
  const svg = document.getElementById("mapSvg");
  const leadersSvg = document.getElementById("labelLeaders");
  const labelRailLeftEl = document.getElementById("labelRailLeft");
  const labelRailRightEl = document.getElementById("labelRailRight");

  const getProfile = () => {
    const checked = profileRadios.find((r) => r.checked);
    return checked?.value || "weekday_am";
  };

  const getMapMode = () => {
    const checked = mapModeRadios.find((r) => r.checked);
    return checked?.value || "geographic";
  };

  const getBaseUnit = () => {
    const checked = baseUnitRadios.find((r) => r.checked);
    return checked?.value || "tract";
  };


  const loadPrefs = () => {
    if (compactNamesEl) {
      const c = localStorage.getItem("atlas.compactNames");
      compactNamesEl.checked = c == null ? true : c === "1";
    }
    const p = localStorage.getItem("atlas.profile");
    if (p && profileRadios.length) {
      const match = profileRadios.find((r) => r.value === p);
      if (match) match.checked = true;
    }
    if (mapModeRadios.length) {
      const m = localStorage.getItem("atlas.mapMode") || "geographic";
      const match = mapModeRadios.find((r) => r.value === m);
      if (match) match.checked = true;
    }
    if (baseUnitRadios.length) {
      const u = localStorage.getItem("atlas.baseUnit") || "derived";
      const match = baseUnitRadios.find((r) => r.value === u);
      if (match) match.checked = true;
    }
  };

  const savePrefs = () => {
    if (compactNamesEl) localStorage.setItem("atlas.compactNames", compactNamesEl.checked ? "1" : "0");
    if (profileRadios.length) localStorage.setItem("atlas.profile", getProfile());
    if (mapModeRadios.length) localStorage.setItem("atlas.mapMode", getMapMode());
    if (baseUnitRadios.length) localStorage.setItem("atlas.baseUnit", getBaseUnit());
  };

  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };

  const showError = (text) => {
    if (errorBannerEl) {
      errorBannerEl.textContent = text;
      errorBannerEl.hidden = false;
    }
  };

  const clearError = () => {
    if (errorBannerEl) errorBannerEl.hidden = true;
  };

  setReportError((msg) => {
    console.error(msg);
    showError(msg);
  });

  let scheduleLabelsRerender = null;

  installPanZoom(svg, {
    onViewBoxChange: (vb) => {
      scheduleLabelsRerender?.();
    },
  });
  loadPrefs();

  // Emergency "get me back" reset: double-click empty space or press "r".
  svg.addEventListener("dblclick", (e) => {
    if (e.target && typeof e.target.closest === "function" && e.target.closest("path")) return;
    if (svg.__atlasInitialViewBox) setSvgViewBox(svg, { ...svg.__atlasInitialViewBox });
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "r") return;
    if (svg.__atlasInitialViewBox) setSvgViewBox(svg, { ...svg.__atlasInitialViewBox });
    scheduleLabelsRerender?.();
  });

  // Debug/helper reset callable from DevTools.
  window.atlasResetView = () => {
    if (svg.__atlasInitialViewBox) setSvgViewBox(svg, { ...svg.__atlasInitialViewBox });
    scheduleLabelsRerender?.();
  };

  neighborhoods = [];
  routes = [];
  stops = [];
  edges = [];
  let adjacency = [];
  let minutesMatrix = null; // neighborhood x neighborhood minutes (filtered to visible set)
  let matrixRoutes = []; // routes referenced by matrix.first_route (filtered)
  let firstRouteMatrix = null; // neighborhood x neighborhood first-route indices (filtered)
  let centralityConfig = null; // matrix centrality payload (filtered)
  let scalarValuesByKey = new Map();
  let cartogramScalarKey = DEFAULT_SCALAR_KEY;
  let cartogramNodesById = new Map();
  let cartogramScaleById = new Map();
  let cartogramCacheKey = null;
  let baseViewBox = null;
  let visibleGeo = null;
  let visibleIds = new Set();
  let originId = null;
  let hoveredDestId = null;
  let pinnedDestId = null;
  let originStopIndex = null;
  let destStopIndex = null;
  let lastRun = null; // {dist, prev, prevRoute, firstRoute}
  let svgIndex = null;
  let initialViewBox = null;
  let centralityById = new Map();
  let centralityRawById = new Map(); // value shown in UI (may be minutes, etc.)
  let centralityLabel = "Centrality";
  let centralityHigherIsBetter = true;
  let centralityStats = { min: 0, max: 1 };
  let hoveredRailId = null;
  let hubPresetIdByKey = new Map();
  let hubPresetById = new Map();
  let hubCentralityIsUser = false;
  let livingHubIsUser = false;
  let centralityMetricKey = "hub";

  // Living mode: map-level metrics aimed at “underrated to live in”.
  let livingMetricKey = "teleportness"; // teleportness only (for now)
  let livingHubId = null;
  let livingHubLabel = "Midtown";
  let livingExcludeShortTrips = true;
  let livingColorKey = "teleportness";
  let livingRawHigherIsBetter = true;

  // Judge mode: hard thresholds + ranked recommendations.
  let judgeConfig = {
    maxCommute: 45,
    maxWalk: 10,
    minLines: 2,
    priority: "balanced",
  };
  const JUDGE_WEIGHTS = {
    balanced: { commute: 0.5, walk: 0.3, lines: 0.2 },
    commute: { commute: 0.7, walk: 0.2, lines: 0.1 },
    access: { commute: 0.4, walk: 0.2, lines: 0.4 },
  };
  let judgeById = new Map();
  let judgeResults = { recommended: [], disqualified: [], tipping: null };
  let judgeCacheKey = "";

  // Views mode: scalar surfaces (population, density, reachable population/jobs).
  let viewsMetricKey = "population";
  let viewsById = new Map();
  let viewsRawById = new Map();
  let viewsStats = { min: 0, max: 1 };
  let viewsLabel = "";
  let viewsHigherIsBetter = true;
  let viewsNote = "";
  let viewsAreaById = new Map();
  let viewsAreaCacheKey = "";
  let viewsReachableCache = new Map();

  let tractsGeo = null;
  let tractsScalars = new Map();
  let derivedGeo = null;
  let derivedScalars = null;
  let derivedLoaded = false;
  let geoMetaById = new Map();

  const ensureDerivedGeo = async () => {
    if (derivedLoaded) return derivedGeo;
    derivedLoaded = true;
    try {
      derivedGeo = await fetchJson(`${DATA_DIR}/derived_regions.geojson`);
      derivedScalars = await attachScalars(derivedGeo?.features || []);
    } catch (err) {
      derivedGeo = null;
      derivedScalars = null;
    }
    return derivedGeo;
  };

  const checkDerivedAvailable = async () => {
    try {
      const res = await fetch(`${DATA_DIR}/derived_regions.geojson`, { method: "HEAD" });
      return res.ok;
    } catch (err) {
      return false;
    }
  };

  const applyBaseUnit = async () => {
    let unit = getBaseUnit();
    let geo = tractsGeo;
    let scalars = tractsScalars;

    if (unit === "derived") {
      await ensureDerivedGeo();
      if (derivedGeo) {
        geo = derivedGeo;
        scalars = derivedScalars || new Map();
      } else {
        unit = "tract";
        const fallback = baseUnitRadios.find((r) => r.value === "tract");
        if (fallback) fallback.checked = true;
        localStorage.setItem("atlas.baseUnit", "tract");
        showError("Derived data missing. Run ./buildonly.sh to generate derived files.");
      }
    }

    scalarValuesByKey = scalars;
    const triFeatures = (geo?.features || []).filter((f) => isTriBorough(getBorough(f?.properties || {})));
    visibleGeo = triFeatures.length > 0 ? { type: "FeatureCollection", features: triFeatures } : geo;
    geoMetaById = new Map();
    for (const feat of visibleGeo?.features || []) {
      const props = feat?.properties || {};
      const id = String(props.atlas_id || "");
      if (!id) continue;
      geoMetaById.set(id, {
        name: featureName(props),
        borough: getBorough(props) || props.borough || "",
        name_confidence: props.name_confidence,
      });
    }
    visibleIds = new Set(
      (visibleGeo?.features || [])
        .map((f) => String((f?.properties || {}).atlas_id || ""))
        .filter(Boolean),
    );
    baseViewBox = computeViewBox(visibleGeo);
    cartogramCacheKey = null;
    viewsAreaCacheKey = "";
    viewsAreaById = new Map();
    viewsReachableCache = new Map();
  };
  let livingLabel = "Teleportness";
  let livingById = new Map(); // oriented so "higher is better"
  let livingRawById = new Map(); // raw values (minutes saved, walk minutes, line count)
  let livingDetailsById = new Map(); // id -> object with metric-specific details
  let livingStats = { min: 0, max: 1 };
  let livingRawStats = { min: 0, max: 1 };

  const syncMaxLabel = () => {
    const v = String(getMaxMinutes());
    maxMinutesLabelEl.textContent = v;
    if (legendMaxEl) legendMaxEl.textContent = v;
  };

  const isCompactNames = () => !!compactNamesEl?.checked;

  const shortenName = (raw) => {
    let name = String(raw || "").trim();
    if (!name) return name;

    // Drop parenthetical qualifiers and normalize whitespace.
    name = name.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();

    const parts = name.split(/\s*-\s*/g).filter(Boolean);
    const base = parts.length > 2 ? parts[0] : parts.slice(0, 2).join(" / ");

    const replacements = [
      [/\bUpper West Side\b/gi, "UWS"],
      [/\bUpper East Side\b/gi, "UES"],
      [/\bLower East Side\b/gi, "LES"],
      [/\bEast Village\b/gi, "EV"],
      [/\bWest Village\b/gi, "WV"],
      [/\bGreenwich Village\b/gi, "GV"],
      [/\bLong Island City\b/gi, "LIC"],
      [/\bHell's Kitchen\b/gi, "HK"],
      [/\bFinancial District\b/gi, "FiDi"],
      [/\bTimes Square\b/gi, "TSQ"],
      [/\bBedford[- ]Stuyvesant\b/gi, "Bed-Stuy"],
      [/\bWilliamsburg\b/gi, "W'burg"],
      [/\bCrown Heights\b/gi, "Crown Hts"],
      [/\bWashington Heights\b/gi, "Wash Hts"],
      [/\bMorningside Heights\b/gi, "Morningside"],
      [/\bProspect Lefferts Gardens\b/gi, "PLG"],
      [/\bJohn F\\. Kennedy International Airport\b/gi, "JFK"],
      [/\bLaGuardia Airport\b/gi, "LGA"],
      [/\bInternational Airport\b/gi, "Intl"],
      [/\bStaten Island\b/gi, "StI"],
      [/\bCentral Park\b/gi, "Central Pk"],
      [/\bForest Hills\b/gi, "Forest Hls"],
      [/\bKew Gardens\b/gi, "Kew Gdns"],
      [/\bBorough Park\b/gi, "Boro Pk"],
      [/\bKings Highway\b/gi, "Kings Hwy"],
      [/\bManhattan Beach\b/gi, "Mhtn Bch"],
      [/\bSheepshead Bay\b/gi, "Sheepshead"],
      [/\bGerritsen Beach\b/gi, "Gerritsen"],
    ];
    let out = base;
    for (const [re, sub] of replacements) out = out.replace(re, sub);

    out = out
      .replace(/\bHeights\b/gi, "Hts")
      .replace(/\bPark\b/gi, "Pk")
      .replace(/\bParkway\b/gi, "Pkwy")
      .replace(/\bBoulevard\b/gi, "Blvd")
      .replace(/\bAvenue\b/gi, "Ave")
      .replace(/\bStreet\b/gi, "St")
      .replace(/\bRoad\b/gi, "Rd")
      .replace(/\bDrive\b/gi, "Dr")
      .replace(/\bCourt\b/gi, "Ct")
      .replace(/\bTerrace\b/gi, "Ter")
      .replace(/\bCenter\b/gi, "Ctr")
      .replace(/\bGardens\b/gi, "Gdns")
      .replace(/\bVillage\b/gi, "Vlg")
      .replace(/\bJunction\b/gi, "Jct")
      .replace(/\bBroadway\b/gi, "Bdwy")
      .replace(/\bBeach\b/gi, "Bch")
      .replace(/\bHarbor\b/gi, "Hbr")
      .replace(/\bPoint\b/gi, "Pt")
      .replace(/\bIsland\b/gi, "Is");

    out = out
      .replace(/\bNorth\b/gi, "N")
      .replace(/\bSouth\b/gi, "S")
      .replace(/\bEast\b/gi, "E")
      .replace(/\bWest\b/gi, "W");

    const maxLen = 16;
    if (out.length > maxLen) out = `${out.slice(0, maxLen - 1)}…`;
    return out;
  };

  const displayName = (raw) => (isCompactNames() ? shortenName(raw) : String(raw || ""));

  const loadMatrix = async (profile) => {
    const unitSuffix = getBaseUnit() === "derived" ? "_derived" : "";
    let graph;
    let matrix;
    try {
      [graph, matrix] = await Promise.all([
        fetchJson(`${DATA_DIR}/graph_${profile}${unitSuffix}.json`),
        fetchJson(`${DATA_DIR}/matrix_${profile}${unitSuffix}.json`),
      ]);
    } catch (err) {
      if (unitSuffix) {
        // Fallback to tracts if derived data is missing.
        const [g, m] = await Promise.all([
          fetchJson(`${DATA_DIR}/graph_${profile}.json`),
          fetchJson(`${DATA_DIR}/matrix_${profile}.json`),
        ]);
        graph = g;
        matrix = m;
        const fallback = baseUnitRadios.find((r) => r.value === "tract");
        if (fallback) fallback.checked = true;
        localStorage.setItem("atlas.baseUnit", "tract");
        await applyBaseUnit();
        showError("Derived data missing. Falling back to Tracts. Run ./buildonly.sh to rebuild derived data.");
      } else {
        throw err;
      }
    }
    const allNeighborhoods = graph.neighborhoods || [];
    const keptNeighborhoods = [];
    const keptOrigIdx = [];
    for (let i = 0; i < allNeighborhoods.length; i++) {
      const n = allNeighborhoods[i];
      if (!visibleIds.has(String(n?.id))) continue;
      keptNeighborhoods.push(n);
      keptOrigIdx.push(i);
    }
    neighborhoods = keptNeighborhoods;
    routes = graph.routes || [];
    stops = graph.stops || [];
    edges = graph.edges || [];
    computeWalkLineMetrics();

    const allMinutes = matrix?.minutes || null;
    if (Array.isArray(allMinutes) && keptOrigIdx.length) {
      const sub = [];
      for (const i of keptOrigIdx) {
        const row = allMinutes[i];
        if (!Array.isArray(row)) continue;
        sub.push(keptOrigIdx.map((j) => (j < row.length ? row[j] : null)));
      }
      minutesMatrix = sub.length === keptOrigIdx.length ? sub : null;
    } else {
      minutesMatrix = null;
    }

    matrixRoutes = Array.isArray(matrix?.routes) ? matrix.routes : [];

    const allFirst = matrix?.first_route || null;
    if (Array.isArray(allFirst) && keptOrigIdx.length) {
      const sub = [];
      for (const i of keptOrigIdx) {
        const row = allFirst[i];
        if (!Array.isArray(row)) continue;
        sub.push(keptOrigIdx.map((j) => (j < row.length ? row[j] : null)));
      }
      firstRouteMatrix = sub.length === keptOrigIdx.length ? sub : null;
    } else {
      firstRouteMatrix = null;
    }

    // Filter centrality metrics to the visible neighborhood set.
    const c = matrix?.centrality || {};
    const metrics = c?.metrics || null;
    if (metrics && typeof metrics === "object") {
      centralityConfig = { ...c, metrics: {} };
      for (const [k, v] of Object.entries(metrics)) {
        const scores = Array.isArray(v?.scores) ? v.scores : [];
        centralityConfig.metrics[k] = {
          label: v?.label || k,
          higher_is_better: !!v?.higher_is_better,
          transfer_penalty_minutes: v?.transfer_penalty_minutes,
          scores: keptOrigIdx.map((i) => (i < scores.length ? scores[i] : null)),
        };
      }
    } else {
      // Back-compat: old schema.
      const scores = Array.isArray(c?.scores) ? c.scores : [];
      centralityConfig = {
        default: "harmonic",
        metrics: {
          harmonic: {
            label: c?.metric || "harmonic",
            higher_is_better: true,
            scores: keptOrigIdx.map((i) => (i < scores.length ? scores[i] : null)),
          },
        },
      };
    }

    // Default centrality map (used on Centrality page; harmless elsewhere).
    const defaultKey = centralityConfig?.default || "harmonic";
    const m0 = centralityConfig?.metrics?.[defaultKey] || centralityConfig?.metrics?.harmonic;
    const scores0 = Array.isArray(m0?.scores) ? m0.scores : [];
    centralityLabel = m0?.label || defaultKey;
    centralityHigherIsBetter = !!m0?.higher_is_better;
    centralityRawById = new Map();
    centralityById = new Map();
    for (let i = 0; i < Math.min(neighborhoods.length, scores0.length); i++) {
      const id = String(neighborhoods[i].id);
      const raw = scores0[i];
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      centralityRawById.set(id, n);
      centralityById.set(id, centralityHigherIsBetter ? n : -n);
    }
    const finite = Array.from(centralityById.values()).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const lo = quantile(finite, 0.05) ?? (finite[0] ?? 0);
    const hi = quantile(finite, 0.95) ?? (finite[finite.length - 1] ?? 1);
    centralityStats = { min: lo, max: hi };

    adjacency = new Array(stops.length).fill(0).map(() => []);
    for (const e of edges) {
      const [from, to, minutes, routeIdx] = e;
      if (from == null || to == null || minutes == null) continue;
      adjacency[from].push({ to, w: minutes, routeIdx: routeIdx ?? null });
    }

    buildHubIndex();
    hubSpokeCache.clear();
    viewsReachableCache = new Map();

  };

  const nbById = () => new Map(neighborhoods.map((n) => [String(n.id), n]));

  const geoMetaForId = (id) => geoMetaById.get(String(id)) || null;

  const nameForId = (id) => {
    const meta = geoMetaForId(id);
    if (meta?.name) return meta.name;
    const nb = nbById().get(String(id));
    return nb?.name || String(id);
  };

  const boroughForId = (id) => {
    const meta = geoMetaForId(id);
    if (meta?.borough) return meta.borough;
    const nb = nbById().get(String(id));
    return nb?.borough || "";
  };

  const confidenceForId = (id) => {
    const meta = geoMetaForId(id);
    if (meta?.name_confidence != null) return meta.name_confidence;
    const nb = nbById().get(String(id));
    return nb?.name_confidence;
  };

  const indexById = () => new Map(neighborhoods.map((n, i) => [String(n.id), i]));

  const getScalarValueById = (id, key) => {
    const map = scalarValuesByKey.get(key);
    if (!map) return null;
    const v = map.get(String(id));
    return v != null && Number.isFinite(v) ? v : null;
  };

  const updateCartogramScalar = (id) => {
    if (!cartogramScalarValueEl) return;
    if (getMapMode() !== "cartogram") {
      cartogramScalarValueEl.textContent = "";
      cartogramScalarValueEl.hidden = true;
      return;
    }
    if (!id) {
      cartogramScalarValueEl.textContent = "";
      cartogramScalarValueEl.hidden = true;
      return;
    }
    const val = getScalarValueById(id, cartogramScalarKey);
    const label = SCALAR_REGISTRY[cartogramScalarKey]?.label || cartogramScalarKey;
    if (val == null) {
      cartogramScalarValueEl.textContent = `${label}: —`;
    } else {
      cartogramScalarValueEl.textContent = `${label}: ${formatScalarValue(cartogramScalarKey, val)}`;
    }
    cartogramScalarValueEl.hidden = false;
  };

  const getScalarValueForFeature = (feature, key) => {
    const props = feature?.properties || {};
    const scalars = props.scalars || {};
    const v = scalars[key];
    return v != null && Number.isFinite(v) ? v : null;
  };

  const getProjectedCentroidForFeature = (feature) => {
    const props = feature?.properties || {};
    const id = String(props.atlas_id || "");
    const nb = nbById().get(id);
    const c = nb?.centroid;
    if (Array.isArray(c) && c.length >= 2) {
      const [lat, lon] = c;
      const [x, y] = projectLonLat([lon, lat]);
      return { x, y, lat, lon };
    }
    // Fallback: approximate centroid from geometry.
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (const [lon, lat] of iterLonLatCoords(feature?.geometry)) {
      const [x, y] = projectLonLat([lon, lat]);
      sumX += x;
      sumY += y;
      count += 1;
    }
    if (!count) return null;
    return { x: sumX / count, y: sumY / count };
  };

  const ensureCartogram = () => {
    const key = cartogramScalarKey || DEFAULT_SCALAR_KEY;
    const cacheKey = `${key}:${visibleGeo?.features?.length || 0}`;
    if (cartogramCacheKey === cacheKey && cartogramNodesById.size) return;
    const features = visibleGeo?.features || [];
    const nodes = [];
    const values = [];
    for (const feat of features) {
      const props = feat?.properties || {};
      const id = String(props.atlas_id || "");
      if (!id) continue;
      const c = getProjectedCentroidForFeature(feat);
      if (!c) continue;
      const v = getScalarValueForFeature(feat, key);
      if (v != null && Number.isFinite(v)) values.push(v);
      nodes.push({ id, x: c.x, y: c.y, value: v });
    }

    const finite = values.slice().sort((a, b) => a - b);
    const median = quantile(finite, 0.5) ?? 1;
    const cap = quantile(finite, 0.95);
    const minScale = 0.45;
    const maxScale = 2.6;
    cartogramScaleById = new Map();
    for (const n of nodes) {
      let val = n.value;
      if (val == null || !Number.isFinite(val)) val = median;
      if (cap != null && Number.isFinite(cap)) val = Math.min(val, cap);
      let scale = median > 0 ? Math.sqrt(val / median) : 1;
      if (!Number.isFinite(scale) || scale <= 0) scale = 1;
      scale = Math.max(minScale, Math.min(maxScale, scale));
      cartogramScaleById.set(String(n.id), scale);
    }

    cartogramNodesById = new Map(nodes.map((n) => [String(n.id), n]));
    cartogramCacheKey = cacheKey;
  };

  const setCentralityFromScores = ({ label, higherIsBetter, scoresByIndex, rawUnit }) => {
    centralityLabel = label || "Centrality";
    centralityHigherIsBetter = !!higherIsBetter;
    centralityRawById = new Map();
    centralityById = new Map();
    for (let i = 0; i < Math.min(neighborhoods.length, scoresByIndex.length); i++) {
      const id = String(neighborhoods[i].id);
      const raw = scoresByIndex[i];
      if (raw == null) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      centralityRawById.set(id, n);
      centralityById.set(id, centralityHigherIsBetter ? n : -n);
    }
    const finite = Array.from(centralityById.values()).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const lo = quantile(finite, 0.05) ?? (finite[0] ?? 0);
    const hi = quantile(finite, 0.95) ?? (finite[finite.length - 1] ?? 1);
    centralityStats = { min: lo, max: hi };
  };

  const setLivingFromRawScores = ({ label, higherIsBetter, rawScoresByIndex, colorKey, detailsById }) => {
    livingColorKey = colorKey || livingMetricKey;
    livingRawHigherIsBetter = !!higherIsBetter;
    livingRawById = new Map();
    livingById = new Map();
    livingDetailsById = detailsById instanceof Map ? detailsById : new Map();

    for (let i = 0; i < Math.min(neighborhoods.length, rawScoresByIndex.length); i++) {
      const id = String(neighborhoods[i].id);
      const raw = rawScoresByIndex[i];
      if (raw == null) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      livingRawById.set(id, n);
      livingById.set(id, livingRawHigherIsBetter ? n : -n);
    }

    const orientedFinite = Array.from(livingById.values()).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const lo = quantile(orientedFinite, 0.05) ?? (orientedFinite[0] ?? 0);
    const hi = quantile(orientedFinite, 0.95) ?? (orientedFinite[orientedFinite.length - 1] ?? 1);
    livingStats = { min: lo, max: hi };

    const rawFinite = Array.from(livingRawById.values()).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const rlo = quantile(rawFinite, 0.05) ?? (rawFinite[0] ?? 0);
    const rhi = quantile(rawFinite, 0.95) ?? (rawFinite[rawFinite.length - 1] ?? 1);
    livingRawStats = { min: rlo, max: rhi };

    livingLabel = String(label || "");
  };

  const isCentralityPage = document.body.classList.contains("centrality-page");
  const isLivingPage = document.body.classList.contains("living-page");
  const isViewsPage = document.body.classList.contains("views-page");
  const isDecidePage = document.body.classList.contains("decide-page");
  const getViewMode = () => {
    if (isCentralityPage || isDecidePage) return "centrality";
    if (isLivingPage) return "living";
    if (isViewsPage) return "views";
    return viewModeEl?.value || "time";
  };
  let hubCentralityHubId = null;
  let hubCentralityHubLabel = "Midtown";

  const presetHubs = [
    { key: "midtown", label: "Midtown", lat: 40.754, lon: -73.984, boro: "manhattan" },
    { key: "downtown", label: "Downtown", lat: 40.707, lon: -74.011, boro: "manhattan" },
    { key: "hudson_yards", label: "Hudson Yards", lat: 40.754, lon: -74.002, boro: "manhattan" },
    { key: "williamsburg", label: "Williamsburg", lat: 40.711, lon: -73.958, boro: "brooklyn" },
    { key: "downtown_bk", label: "Downtown BK", lat: 40.692, lon: -73.985, boro: "brooklyn" },
    { key: "greenpoint", label: "Greenpoint", lat: 40.729, lon: -73.955, boro: "brooklyn" },
    { key: "bushwick", label: "Bushwick", lat: 40.695, lon: -73.918, boro: "brooklyn" },
    { key: "lic", label: "LIC", lat: 40.744, lon: -73.949, boro: "queens" },
    { key: "astoria", label: "Astoria", lat: 40.764, lon: -73.923, boro: "queens" },
  ];

  const nearestNeighborhoodId = (lat, lon) => {
    let bestId = null;
    let bestD = null;
    for (const n of neighborhoods) {
      const c = n?.centroid;
      if (!Array.isArray(c) || c.length < 2) continue;
      const d = haversineKm([lat, lon], [c[0], c[1]]);
      if (bestD == null || d < bestD) {
        bestD = d;
        bestId = String(n.id);
      }
    }
    return bestId;
  };

  const buildHubIndex = () => {
    hubPresetIdByKey = new Map();
    hubPresetById = new Map();

    const featureById = new Map();
    for (const feat of visibleGeo?.features || []) {
      const props = feat?.properties || {};
      const id = String(props.atlas_id || "");
      if (!id) continue;
      featureById.set(id, feat);
      if (props.is_hub) {
        delete props.is_hub;
        delete props.hub_key;
        delete props.hub_label;
        delete props.hub_boro;
      }
    }

    for (const h of presetHubs) {
      const id = nearestNeighborhoodId(h.lat, h.lon);
      if (!id) continue;
      hubPresetIdByKey.set(h.key, id);
      const entry = { ...h, id };
      hubPresetById.set(id, entry);
      const feat = featureById.get(id);
      if (feat) {
        const props = feat.properties || {};
        props.is_hub = true;
        props.hub_key = h.key;
        props.hub_label = h.label;
        props.hub_boro = h.boro || "";
        feat.properties = props;
      }
    }

    for (const n of neighborhoods) {
      const id = String(n.id);
      const hub = hubPresetById.get(id);
      n.isHub = !!hub;
      n.hubKey = hub?.key || null;
      n.hubLabel = hub?.label || null;
      n.hubBoro = hub?.boro || null;
    }
  };

  const applyHubCentrality = () => {
    if (!minutesMatrix || !hubCentralityHubId) return;
    const hubIdx = indexById().get(String(hubCentralityHubId));
    if (hubIdx == null) return;
    const scores = minutesMatrix.map((row) => (Array.isArray(row) ? row[hubIdx] : null));
    // Lower minutes is better; invert for visual mapping.
    setCentralityFromScores({
      label: `To hub: ${hubCentralityHubLabel}`,
      higherIsBetter: false,
      scoresByIndex: scores,
      rawUnit: "min",
    });
  };

  let centralityUiBound = false;
  let centralityApplyUi = () => {};
  let centralityPresetIdByKey = new Map();

  const setupCentralityUi = () => {
    if (!isCentralityPage && !isDecidePage) return;
    const metricRadios = Array.from(document.querySelectorAll('input[name="centralityMetric"]'));
    const hubPresetRadios = Array.from(document.querySelectorAll('input[name="centralityHubPreset"]'));
    const hubControlsEl = document.getElementById("hubControls");
    const hubNameEl = document.getElementById("centralityHubName");
    const hubCustomEl = document.getElementById("centralityHubCustom");
    const hubGroupEl = document.getElementById("centralityHubGroup");
    const userHubGroupEl = document.getElementById("centralityUserHubGroup");
    const userHubNameEl = document.getElementById("centralityUserHubName");
    const userHubPillEl = document.getElementById("centralityUserHubPill");

    // Populate custom hub dropdown.
    if (hubCustomEl) {
      hubCustomEl.replaceChildren();
      const opt0 = document.createElement("option");
      opt0.value = "";
      opt0.textContent = "— Select a neighborhood —";
      hubCustomEl.appendChild(opt0);
      const groupBy = { manhattan: [], brooklyn: [], queens: [] };
      for (const n of neighborhoods) {
        const k = boroughKey(n?.borough);
        if (!k) continue;
        groupBy[k].push(n);
      }
      const order = [
        ["manhattan", "Manhattan"],
        ["brooklyn", "Brooklyn"],
        ["queens", "Queens"],
      ];
      for (const [k, label] of order) {
        const og = document.createElement("optgroup");
        og.label = label;
        groupBy[k].slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).forEach((n) => {
          const o = document.createElement("option");
          o.value = String(n.id);
          o.textContent = String(n.name || n.id);
          og.appendChild(o);
        });
        hubCustomEl.appendChild(og);
      }
    }

    // Resolve preset hub ids.
    centralityPresetIdByKey = hubPresetIdByKey;

    const updateUserHubChip = (customId) => {
      if (!userHubGroupEl || !hubGroupEl) return;
      if (!customId) {
        userHubGroupEl.hidden = true;
        return;
      }
      const name = displayName(nameForId(customId));
      const boro = boroughForId(customId);
      userHubGroupEl.hidden = false;
      if (userHubNameEl) userHubNameEl.textContent = name;
      if (userHubPillEl) {
        const abbrev = boroughAbbrev(boro) || "U";
        userHubPillEl.textContent = abbrev;
        userHubPillEl.className = `boro-pill ${boro ? `boro-${boroughKey(boro)}` : ""}`.trim();
      }
    };

    const loadUiPrefs = () => {
      const metric = localStorage.getItem("atlas.centralityMetric") || "hub";
      const m = metricRadios.find((r) => r.value === metric);
      if (m) m.checked = true;

      const preset = localStorage.getItem("atlas.centralityHubPreset") || "midtown";
      const p = hubPresetRadios.find((r) => r.value === preset);
      if (p) p.checked = true;

      const custom = localStorage.getItem("atlas.centralityHubCustom") || "";
      if (hubCustomEl) hubCustomEl.value = custom;
      updateUserHubChip(custom);
    };

    centralityApplyUi = () => {
      const metric = metricRadios.find((r) => r.checked)?.value || "hub";
      centralityMetricKey = metric;
      if (hubControlsEl) {
        hubControlsEl.hidden = metric !== "hub";
        hubControlsEl.style.display = metric === "hub" ? "" : "none";
      }

      if (metric === "hub") {
        let presetKey = hubPresetRadios.find((r) => r.checked)?.value || "midtown";
        if (presetKey === "user" && !hubCustomEl?.value) presetKey = "midtown";
        const presetMeta = presetHubs.find((h) => h.key === presetKey);
        const presetId = centralityPresetIdByKey.get(presetKey) || null;
        const customId = hubCustomEl?.value ? String(hubCustomEl.value) : "";
        const useCustom = presetKey === "user" && customId;
        const useId = useCustom ? customId : presetId || null;
        const useLabel = useCustom
          ? (nbById().get(customId)?.name || customId)
          : presetMeta?.label || presetKey;

        hubCentralityIsUser = !!useCustom;
        hubCentralityHubId = useId;
        hubCentralityHubLabel = String(useLabel || "");
        if (hubNameEl) hubNameEl.textContent = hubCentralityHubLabel;
        updateUserHubChip(customId);
        judgeCacheKey = "";
        applyHubCentrality();
      } else {
        const metricKey = metric;
        const mm = centralityConfig?.metrics?.[metricKey];
        const scores = Array.isArray(mm?.scores) ? mm.scores : [];
        hubCentralityIsUser = false;
        hubCentralityHubId = null;
        hubCentralityHubLabel = "";
        setCentralityFromScores({
          label: mm?.label || metricKey,
          higherIsBetter: !!mm?.higher_is_better,
          scoresByIndex: scores,
        });
      }

      restyle();
      renderLabels();
      renderCentralityPanel();
      renderSpokesPanel();
    };

    loadUiPrefs();
    centralityApplyUi();

    if (!centralityUiBound) {
      centralityUiBound = true;
      for (const r of metricRadios) {
        r.addEventListener("change", () => {
          localStorage.setItem("atlas.centralityMetric", r.value);
          centralityApplyUi();
        });
      }
      for (const r of hubPresetRadios) {
        r.addEventListener("change", () => {
          localStorage.setItem("atlas.centralityHubPreset", r.value);
          // Clear custom hub when changing presets.
          if (hubCustomEl) {
            hubCustomEl.value = "";
            localStorage.setItem("atlas.centralityHubCustom", "");
          }
          updateUserHubChip("");
          centralityApplyUi();
        });
      }
      hubCustomEl?.addEventListener("change", () => {
        const val = hubCustomEl.value || "";
        localStorage.setItem("atlas.centralityHubCustom", val);
        if (val) {
          localStorage.setItem("atlas.centralityHubPreset", "user");
          const userRadio = hubPresetRadios.find((r) => r.value === "user");
          if (userRadio) userRadio.checked = true;
        } else {
          const current = hubPresetRadios.find((r) => r.checked);
          if (current?.value === "user") {
            const fallback = hubPresetRadios.find((r) => r.value === "midtown");
            if (fallback) fallback.checked = true;
            localStorage.setItem("atlas.centralityHubPreset", "midtown");
          }
        }
        updateUserHubChip(val);
        centralityApplyUi();
      });
    }
  };

  let judgeUiBound = false;
  const setupJudgeUi = () => {
    if (!isCentralityPage && !isDecidePage) return;
    const maxCommuteEl = document.getElementById("judgeMaxCommute");
    const maxWalkEl = document.getElementById("judgeMaxWalk");
    const minLinesEl = document.getElementById("judgeMinLines");
    const priorityRadios = Array.from(document.querySelectorAll('input[name="judgePriority"]'));
    if (!maxCommuteEl || !maxWalkEl || !minLinesEl) return;

    const storedMaxCommute = Number(localStorage.getItem("atlas.judgeMaxCommute") || judgeConfig.maxCommute);
    const storedMaxWalk = Number(localStorage.getItem("atlas.judgeMaxWalk") || judgeConfig.maxWalk);
    const storedMinLines = Number(localStorage.getItem("atlas.judgeMinLines") || judgeConfig.minLines);
    const storedPriority = localStorage.getItem("atlas.judgePriority") || judgeConfig.priority;

    judgeConfig.maxCommute = Number.isFinite(storedMaxCommute) ? storedMaxCommute : judgeConfig.maxCommute;
    judgeConfig.maxWalk = Number.isFinite(storedMaxWalk) ? storedMaxWalk : judgeConfig.maxWalk;
    judgeConfig.minLines = Number.isFinite(storedMinLines) ? storedMinLines : judgeConfig.minLines;
    judgeConfig.priority = storedPriority;

    maxCommuteEl.value = String(judgeConfig.maxCommute);
    maxWalkEl.value = String(judgeConfig.maxWalk);
    minLinesEl.value = String(judgeConfig.minLines);
    const p = priorityRadios.find((r) => r.value === judgeConfig.priority);
    if (p) p.checked = true;

    if (judgeUiBound) {
      renderJudgePanels();
      return;
    }
    judgeUiBound = true;

    const update = () => {
      judgeConfig.maxCommute = Number(maxCommuteEl.value || judgeConfig.maxCommute);
      judgeConfig.maxWalk = Number(maxWalkEl.value || judgeConfig.maxWalk);
      judgeConfig.minLines = Number(minLinesEl.value || judgeConfig.minLines);
      judgeConfig.priority = priorityRadios.find((r) => r.checked)?.value || judgeConfig.priority;
      localStorage.setItem("atlas.judgeMaxCommute", String(judgeConfig.maxCommute));
      localStorage.setItem("atlas.judgeMaxWalk", String(judgeConfig.maxWalk));
      localStorage.setItem("atlas.judgeMinLines", String(judgeConfig.minLines));
      localStorage.setItem("atlas.judgePriority", judgeConfig.priority);
      judgeCacheKey = "";
      renderJudgePanels();
    };

    maxCommuteEl.addEventListener("change", update);
    maxWalkEl.addEventListener("change", update);
    minLinesEl.addEventListener("change", update);
    for (const r of priorityRadios) r.addEventListener("change", update);
    renderJudgePanels();
  };

  const formatSignedMinutes = (v) => {
    if (v == null || !Number.isFinite(v)) return "—";
    const sign = v >= 0 ? "+" : "−";
    return `${sign}${Math.abs(v).toFixed(1)} min`;
  };

  const applyLivingMetric = () => {
    const rawScores = new Array(neighborhoods.length).fill(null);
    const details = new Map();

    // Teleportness: minutes saved vs baseline speed to the selected hub.
    const hubId = livingHubId ? String(livingHubId) : null;
    if (!hubId || !minutesMatrix) {
      setLivingFromRawScores({
        label: "Teleportness",
        higherIsBetter: true,
        rawScoresByIndex: rawScores,
        colorKey: "teleportness",
        detailsById: details,
      });
      return;
    }

    const hubIdx = indexById().get(hubId);
    const hubNb = nbById().get(hubId);
    const hubC = hubNb?.centroid;
    if (hubIdx == null || !Array.isArray(hubC) || hubC.length < 2) return;

    const maxMinutes = getMaxMinutes();
    for (let i = 0; i < neighborhoods.length; i++) {
      if (i === hubIdx) continue;
      const n = neighborhoods[i];
      const id = String(n.id);
      const c = n?.centroid;
      if (!Array.isArray(c) || c.length < 2) continue;

      const mins = minutesMatrix?.[i]?.[hubIdx] ?? null;
      if (mins == null || !Number.isFinite(mins) || mins <= 0 || mins > maxMinutes) continue;

      const dKm = haversineKm(c, hubC);
      if (!Number.isFinite(dKm)) continue;
      if (livingExcludeShortTrips && dKm < 6) continue;

      const expected = dKm / TELEPORT_EXPECTED_SPEED_KM_PER_MIN;
      const saved = expected - Number(mins);

      rawScores[i] = Math.round(saved * 10) / 10;

      const ridx = firstRouteMatrix?.[i]?.[hubIdx] ?? null;
      const r = ridx != null && ridx >= 0 && ridx < matrixRoutes.length ? matrixRoutes[ridx] : null;
      const firstLine = r?.short_name || r?.id || null;

      details.set(id, {
        metric: "teleportness",
        hub_id: hubId,
        hub_name: hubNb?.name || hubId,
        minutes: Math.round(Number(mins)),
        distance_km: Math.round(dKm * 100) / 100,
        expected_minutes: Math.round(expected * 10) / 10,
        minutes_saved: Math.round(saved * 10) / 10,
        first_line: firstLine,
        first_color: r?.color || null,
      });
    }

    setLivingFromRawScores({
      label: `Teleportness to ${livingHubLabel || "hub"}`,
      higherIsBetter: true,
      rawScoresByIndex: rawScores,
      colorKey: "teleportness",
      detailsById: details,
    });
  };

  const viewMetricAvailable = (metric) => {
    if (!metric) return false;
    const scalarKey = metric.requiresScalar || metric.scalarKey;
    if (scalarKey) {
      const map = scalarValuesByKey.get(scalarKey);
      if (!map || map.size === 0) return false;
    }
    if (metric.type === "reachable" && !minutesMatrix) return false;
    return true;
  };

  const rebuildViewsAreaCache = () => {
    const key = `${getBaseUnit()}|${visibleGeo?.features?.length || 0}`;
    if (key === viewsAreaCacheKey) return;
    viewsAreaById = new Map();
    for (const feat of visibleGeo?.features || []) {
      const props = feat?.properties || {};
      const id = String(props.atlas_id || "");
      if (!id) continue;
      const area = geometryAreaKm2(feat.geometry);
      if (area > 0) viewsAreaById.set(id, area);
    }
    viewsAreaCacheKey = key;
  };

  const computeReachableScalar = (threshold, scalarKey) => {
    const cacheKey = `${scalarKey}|${threshold}|${getProfile()}|${getBaseUnit()}`;
    if (viewsReachableCache.has(cacheKey)) return viewsReachableCache.get(cacheKey);
    const result = new Map();
    const scalarMap = scalarValuesByKey.get(scalarKey) || new Map();
    if (!minutesMatrix || !neighborhoods.length) {
      viewsReachableCache.set(cacheKey, result);
      return result;
    }
    const ids = neighborhoods.map((n) => String(n.id));
    for (let i = 0; i < ids.length; i++) {
      const row = minutesMatrix[i];
      if (!Array.isArray(row)) continue;
      let sum = 0;
      for (let j = 0; j < ids.length; j++) {
        const mins = row[j];
        if (mins == null || !Number.isFinite(mins) || mins > threshold) continue;
        const v = scalarMap.get(ids[j]);
        if (v != null && Number.isFinite(v)) sum += v;
      }
      result.set(ids[i], sum);
    }
    viewsReachableCache.set(cacheKey, result);
    return result;
  };

  const applyViewsMetric = () => {
    const metric = VIEW_REGISTRY[viewsMetricKey] || VIEW_REGISTRY.population;
    viewsLabel = metric?.label || viewsMetricKey;
    viewsHigherIsBetter = metric?.higherIsBetter !== false;
    viewsNote = metric?.description || "";

    if (!viewMetricAvailable(metric)) {
      const key = metric?.requiresScalar || metric?.scalarKey;
      if (key) {
        const hint = `Add data/raw/scalars_${key}.csv and run ./buildonly.sh to enable this view.`;
        viewsNote = viewsNote ? `${viewsNote} ${hint}` : hint;
      }
      viewsById = new Map();
      viewsRawById = new Map();
      viewsStats = { min: 0, max: 1 };
      if (viewsMetricNoteEl) viewsMetricNoteEl.textContent = viewsNote;
      return;
    }

    viewsRawById = new Map();
    if (metric.type === "scalar") {
      for (const n of neighborhoods) {
        const id = String(n.id);
        const v = getScalarValueById(id, metric.scalarKey);
        if (v != null) viewsRawById.set(id, v);
      }
    } else if (metric.type === "density") {
      rebuildViewsAreaCache();
      for (const n of neighborhoods) {
        const id = String(n.id);
        const v = getScalarValueById(id, metric.scalarKey);
        const area = viewsAreaById.get(id);
        if (v != null && area != null && area > 0) {
          viewsRawById.set(id, v / area);
        }
      }
    } else if (metric.type === "reachable") {
      viewsRawById = computeReachableScalar(metric.threshold, metric.scalarKey);
    }

    viewsById = new Map();
    for (const [id, v] of viewsRawById.entries()) {
      if (!Number.isFinite(v)) continue;
      viewsById.set(id, viewsHigherIsBetter ? v : -v);
    }

    const oriented = Array.from(viewsById.values()).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const lo = quantile(oriented, 0.05) ?? (oriented[0] ?? 0);
    const hi = quantile(oriented, 0.95) ?? (oriented[oriented.length - 1] ?? 1);
    viewsStats = { min: lo, max: hi };
    if (viewsMetricNoteEl) viewsMetricNoteEl.textContent = viewsNote;
  };

  const renderViewsPanel = () => {
    if (!isViewsPage) return;
    const panel = document.getElementById("viewsPanel");
    const topEl = document.getElementById("viewsTop");
    const botEl = document.getElementById("viewsBottom");
    const hoverNameEl = document.getElementById("viewsHoverName");
    const hoverMetaEl = document.getElementById("viewsHoverMeta");
    if (!panel || !topEl || !botEl || !hoverNameEl || !hoverMetaEl) return;

    const mode = getViewMode();
    panel.hidden = mode !== "views";
    if (mode !== "views") return;

    const metric = VIEW_REGISTRY[viewsMetricKey] || VIEW_REGISTRY.population;
    const rows = neighborhoods
      .map((n) => ({
        id: String(n.id),
        name: displayName(nameForId(n.id)),
        sort: viewsById.get(String(n.id)),
        raw: viewsRawById.get(String(n.id)),
      }))
      .filter((r) => Number.isFinite(r.sort) && Number.isFinite(r.raw));

    rows.sort((a, b) => b.sort - a.sort);
    const fmt = (r) => `${r.name} — ${formatViewValue(r.raw, metric?.unit)}`;
    setList(topEl, rows.slice(0, 10).map(fmt));
    setList(botEl, rows.slice(-10).reverse().map(fmt));

    const activeId = pinnedDestId != null ? pinnedDestId : hoveredDestId;
    if (!activeId) {
      hoverNameEl.textContent = "Hover a neighborhood";
      hoverMetaEl.textContent = "";
      return;
    }

    const name = displayName(nameForId(activeId));
    const raw = viewsRawById.get(String(activeId));
    hoverNameEl.textContent = name;
    hoverMetaEl.textContent = `${viewsLabel}: ${formatViewValue(raw, metric?.unit)}`;
  };

  let viewsUiBound = false;
  const setupViewsUi = () => {
    if (!isViewsPage) return;
    if (!viewsMetricSelectEl) return;

    const applyMetricFromUi = () => {
      const val = viewsMetricSelectEl.value;
      viewsMetricKey = VIEW_REGISTRY[val] ? val : "population";
      localStorage.setItem("atlas.viewsMetric", viewsMetricKey);
      applyViewsMetric();
      restyle();
      renderLabels();
      renderViewsPanel();
    };

    const stored = localStorage.getItem("atlas.viewsMetric") || "population";
    const metrics = Object.entries(VIEW_REGISTRY);

    if (!viewsUiBound) {
      viewsMetricSelectEl.addEventListener("change", () => applyMetricFromUi());
      viewsUiBound = true;
    }

    viewsMetricSelectEl.replaceChildren();
    let fallbackKey = null;
    for (const [key, metric] of metrics) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = metric.label || key;
      const available = viewMetricAvailable(metric);
      if (!available) {
        opt.disabled = true;
        opt.textContent = `${metric.label || key} (add data)`;
      }
      if (fallbackKey == null && available) fallbackKey = key;
      viewsMetricSelectEl.appendChild(opt);
    }

    const initialKey = viewMetricAvailable(VIEW_REGISTRY[stored]) ? stored : fallbackKey || "population";
    viewsMetricKey = initialKey;
    viewsMetricSelectEl.value = initialKey;
    applyViewsMetric();
    renderViewsPanel();
  };

  let livingUiBound = false;
  let livingApplyUi = () => {};
  let livingPresetIdByKey = new Map();

  const setupLivingUi = () => {
    if (!isLivingPage) return;
    const metricRadios = Array.from(document.querySelectorAll('input[name="livingMetric"]'));
    const hubPresetRadios = Array.from(document.querySelectorAll('input[name="livingHubPreset"]'));
    const hubControlsEl = document.getElementById("livingTeleportControls");
    const hubNameEl = document.getElementById("livingHubName");
    const hubCustomEl = document.getElementById("livingHubCustom");
    const hubGroupEl = document.getElementById("livingHubGroup");
    const userHubGroupEl = document.getElementById("livingUserHubGroup");
    const userHubNameEl = document.getElementById("livingUserHubName");
    const userHubPillEl = document.getElementById("livingUserHubPill");
    const excludeShortEl = document.getElementById("livingExcludeShort");
    const hasMetricRadios = metricRadios.length > 0;

    // Populate custom hub dropdown (tri-borough only).
    if (hubCustomEl) {
      hubCustomEl.replaceChildren();
      const opt0 = document.createElement("option");
      opt0.value = "";
      opt0.textContent = "— Select a neighborhood —";
      hubCustomEl.appendChild(opt0);
      const groupBy = { manhattan: [], brooklyn: [], queens: [] };
      for (const n of neighborhoods) {
        const k = boroughKey(n?.borough);
        if (!k) continue;
        groupBy[k].push(n);
      }
      const order = [
        ["manhattan", "Manhattan"],
        ["brooklyn", "Brooklyn"],
        ["queens", "Queens"],
      ];
      for (const [k, label] of order) {
        const og = document.createElement("optgroup");
        og.label = label;
        groupBy[k].slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).forEach((n) => {
          const o = document.createElement("option");
          o.value = String(n.id);
          o.textContent = String(n.name || n.id);
          og.appendChild(o);
        });
        hubCustomEl.appendChild(og);
      }
    }

    // Resolve preset hub ids.
    livingPresetIdByKey = hubPresetIdByKey;

    const updateUserHubChip = (customId) => {
      if (!userHubGroupEl || !hubGroupEl) return;
      if (!customId) {
        userHubGroupEl.hidden = true;
        return;
      }
      const name = displayName(nameForId(customId));
      const boro = boroughForId(customId);
      userHubGroupEl.hidden = false;
      if (userHubNameEl) userHubNameEl.textContent = name;
      if (userHubPillEl) {
        const abbrev = boroughAbbrev(boro) || "U";
        userHubPillEl.textContent = abbrev;
        userHubPillEl.className = `boro-pill ${boro ? `boro-${boroughKey(boro)}` : ""}`.trim();
      }
    };

    const loadUiPrefs = () => {
      if (hasMetricRadios) {
        const metric = localStorage.getItem("atlas.livingMetric") || "teleportness";
        const m = metricRadios.find((r) => r.value === metric);
        if (m) m.checked = true;
      }

      const preset = localStorage.getItem("atlas.livingHubPreset") || "midtown";
      const p = hubPresetRadios.find((r) => r.value === preset);
      if (p) p.checked = true;

      const custom = localStorage.getItem("atlas.livingHubCustom") || "";
      if (hubCustomEl) hubCustomEl.value = custom;
      updateUserHubChip(custom);

      const ex = localStorage.getItem("atlas.livingExcludeShort");
      if (excludeShortEl) excludeShortEl.checked = ex == null ? true : ex === "1";
    };

    livingApplyUi = () => {
      livingMetricKey = "teleportness";
      if (hubControlsEl) hubControlsEl.hidden = false;

        let presetKey = hubPresetRadios.find((r) => r.checked)?.value || "midtown";
        if (presetKey === "user" && !hubCustomEl?.value) presetKey = "midtown";
        const presetMeta = presetHubs.find((h) => h.key === presetKey);
        const presetId = livingPresetIdByKey.get(presetKey) || null;
      const customId = hubCustomEl?.value ? String(hubCustomEl.value) : "";
      const useCustom = presetKey === "user" && customId;
      const useId = useCustom ? customId : presetId || null;
      const useLabel = useCustom
        ? (nbById().get(customId)?.name || customId)
        : presetMeta?.label || presetKey;

      livingHubIsUser = !!useCustom;
      livingHubId = useId;
      livingHubLabel = String(useLabel || "");
      if (hubNameEl) hubNameEl.textContent = livingHubLabel;
      livingExcludeShortTrips = !!excludeShortEl?.checked;

      applyLivingMetric();
      restyle();
      renderLabels();
      renderLivingPanel();
      renderSpokesPanel();
    };

    loadUiPrefs();
    livingApplyUi();

    if (!livingUiBound) {
      livingUiBound = true;

      for (const r of metricRadios) {
        r.addEventListener("change", () => {
          localStorage.setItem("atlas.livingMetric", r.value);
          livingApplyUi();
        });
      }

      for (const r of hubPresetRadios) {
        r.addEventListener("change", () => {
          localStorage.setItem("atlas.livingHubPreset", r.value);
          if (hubCustomEl) {
            hubCustomEl.value = "";
            localStorage.setItem("atlas.livingHubCustom", "");
          }
          updateUserHubChip("");
          livingApplyUi();
        });
      }

      hubCustomEl?.addEventListener("change", () => {
        const val = hubCustomEl.value || "";
        localStorage.setItem("atlas.livingHubCustom", val);
        if (val) {
          localStorage.setItem("atlas.livingHubPreset", "user");
          const userRadio = hubPresetRadios.find((r) => r.value === "user");
          if (userRadio) userRadio.checked = true;
        } else {
          const current = hubPresetRadios.find((r) => r.checked);
          if (current?.value === "user") {
            const fallback = hubPresetRadios.find((r) => r.value === "midtown");
            if (fallback) fallback.checked = true;
            localStorage.setItem("atlas.livingHubPreset", "midtown");
          }
        }
        updateUserHubChip(val);
        livingApplyUi();
      });

      excludeShortEl?.addEventListener("change", () => {
        localStorage.setItem("atlas.livingExcludeShort", excludeShortEl.checked ? "1" : "0");
        livingApplyUi();
      });
    }
  };

  let cartogramUiBound = false;
  const setupCartogramUi = () => {
    if (!mapModeRadios.length) return;

    // Populate scalar dropdown.
    if (cartogramScalarSelectEl) {
      cartogramScalarSelectEl.replaceChildren();
      const cartogramKeys = SCALAR_KEYS.filter((k) => (SCALAR_REGISTRY[k]?.type || "scalar") === "scalar");
      const availableKeys = cartogramKeys.filter((k) => (scalarValuesByKey.get(k)?.size || 0) > 0);
      const keysToShow = availableKeys.length ? availableKeys : cartogramKeys;
      for (const key of keysToShow) {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = SCALAR_REGISTRY[key]?.label || key;
        cartogramScalarSelectEl.appendChild(opt);
      }
      const storedKey = localStorage.getItem("atlas.cartogramScalar") || DEFAULT_SCALAR_KEY;
      cartogramScalarKey = keysToShow.includes(storedKey) ? storedKey : keysToShow[0] || DEFAULT_SCALAR_KEY;
      cartogramScalarSelectEl.value = cartogramScalarKey;
    }

    const applyMapModeUi = (preserveState = true) => {
      const mode = getMapMode();
      if (cartogramScalarWrapEl) {
        cartogramScalarWrapEl.hidden = false;
        cartogramScalarWrapEl.classList.toggle("is-disabled", mode !== "cartogram");
      }
      if (cartogramScalarSelectEl) cartogramScalarSelectEl.disabled = mode !== "cartogram";
      if (cartogramScalarHintEl) cartogramScalarHintEl.hidden = mode === "cartogram";
      if (cartogramLegendNoteEl) cartogramLegendNoteEl.hidden = mode !== "cartogram";
      if (mode === "cartogram") {
        ensureCartogram();
      }
      render({ preserveState });
    };

    applyMapModeUi(false);

    if (cartogramUiBound) return;
    cartogramUiBound = true;

    for (const r of mapModeRadios) {
      r.addEventListener("change", () => {
        savePrefs();
        applyMapModeUi(true);
      });
    }

    cartogramScalarSelectEl?.addEventListener("change", () => {
      const val = cartogramScalarSelectEl.value;
      const cartogramKeys = SCALAR_KEYS.filter((k) => (SCALAR_REGISTRY[k]?.type || "scalar") === "scalar");
      cartogramScalarKey = cartogramKeys.includes(val) ? val : DEFAULT_SCALAR_KEY;
      localStorage.setItem("atlas.cartogramScalar", cartogramScalarKey);
      cartogramCacheKey = null;
      ensureCartogram();
      render({ preserveState: true });
    });
  };

  const boroughStrokeForId = (id) => {
    const nb = nbById().get(String(id));
    const k = boroughKey(nb?.borough);
    if (k === "manhattan") return "rgba(6,182,212,0.28)";
    if (k === "brooklyn") return "rgba(16,185,129,0.26)";
    if (k === "queens") return "rgba(245,158,11,0.24)";
    return "rgba(15,23,42,0.35)";
  };

  const formatCentralityValue = (id) => {
    const raw = centralityRawById.get(String(id));
    if (raw == null || !Number.isFinite(raw)) return "—";
    if (!centralityHigherIsBetter) return `${Math.round(raw)} min`;
    // Harmonic-like scores: keep compact.
    return raw.toFixed(3);
  };

  const getActiveHubInfo = () => {
    const mode = getViewMode();
    if (mode === "living") {
      if (!livingHubId) return null;
      return { id: String(livingHubId), label: livingHubLabel || "", isUser: !!livingHubIsUser };
    }
    if (mode === "centrality" && centralityMetricKey === "hub") {
      if (!hubCentralityHubId) return null;
      return { id: String(hubCentralityHubId), label: hubCentralityHubLabel || "", isUser: !!hubCentralityIsUser };
    }
    return null;
  };

  const minsFromOriginToId = (id) => {
    if (!lastRun) return null;
    const nb = nbById().get(String(id));
    const si = nb?.stop_index;
    if (si == null) return null;
    const d = lastRun.dist[si];
    return Number.isFinite(d) ? d : null;
  };

  const firstRouteForId = (id) => {
    if (!lastRun) return null;
    const nb = nbById().get(String(id));
    const si = nb?.stop_index;
    if (si == null) return null;
    const routeIdx = lastRun.firstRoute[si];
    if (routeIdx == null) return null;
    return routes?.[routeIdx] || null;
  };

  let hubSpokeCache = new Map();
  const getHubSpokeData = (hubId) => {
    if (!hubId || !minutesMatrix) return [];
    const key = `${getProfile()}|${hubId}|${getMaxMinutes()}`;
    if (hubSpokeCache.has(key)) return hubSpokeCache.get(key) || [];

    const hubIdx = indexById().get(String(hubId));
    const hubNb = nbById().get(String(hubId));
    const hubC = hubNb?.centroid;
    if (hubIdx == null || !Array.isArray(hubC) || hubC.length < 2) return [];

    const maxMinutes = getMaxMinutes();
    const out = [];
    for (let i = 0; i < neighborhoods.length; i++) {
      if (i === hubIdx) continue;
      const n = neighborhoods[i];
      const id = String(n.id);
      const mins = minutesMatrix?.[i]?.[hubIdx] ?? null;
      if (mins == null || !Number.isFinite(mins) || mins <= 0 || mins > maxMinutes) continue;
      const c = n?.centroid;
      if (!Array.isArray(c) || c.length < 2) continue;
      const distKm = haversineKm(c, hubC);
      const expected = Number.isFinite(distKm) ? distKm / TELEPORT_EXPECTED_SPEED_KM_PER_MIN : null;
      const minutesSaved = expected != null ? expected - mins : null;
      const ridx = firstRouteMatrix?.[i]?.[hubIdx] ?? null;
      const route = ridx != null ? matrixRoutes?.[ridx] || routes?.[ridx] : null;
      const line = route?.short_name || route?.id || null;
      out.push({
        id,
        name: n.name || id,
        minutes: mins,
        distanceKm: distKm,
        minutesSaved,
        line,
        borough: n?.borough || "",
      });
    }
    hubSpokeCache.set(key, out);
    return out;
  };

  const getOriginSpokeIds = (count = SPOKE_LABEL_COUNT) => {
    if (!originId || !lastRun) return [];
    const maxMinutes = getMaxMinutes();
    const rows = neighborhoods
      .map((n) => ({ id: String(n.id), minutes: minsFromOriginToId(n.id) }))
      .filter(
        (r) =>
          r.id !== String(originId) &&
          r.minutes != null &&
          Number.isFinite(r.minutes) &&
          r.minutes <= maxMinutes,
      )
      .sort((a, b) => a.minutes - b.minutes)
      .slice(0, count);
    return rows.map((r) => r.id);
  };

  const stopProjected = (stopIndex) => {
    const st = stops[stopIndex];
    return projectLonLat([st.lon, st.lat]);
  };

  const clearIsochrones = () => {
    if (svgIndex?.gIsochrones) svgIndex.gIsochrones.replaceChildren();
  };

  const renderIsochrones = () => {
    if (!svgIndex?.gIsochrones) return;
    svgIndex.gIsochrones.replaceChildren();
    if (!ISOCHRONES_ALWAYS_ON) return;
    if (!originId || !lastRun) return;
    if (getViewMode() !== "time") return;

    const maxMinutes = getMaxMinutes();
    const thresholds = ISOCHRONE_MINUTES.filter((t) => t <= maxMinutes);
    if (!thresholds.length) return;

    const frag = document.createDocumentFragment();

    // Draw outer rings first so inner rings sit on top.
    for (let i = thresholds.length - 1; i >= 0; i--) {
      const t = thresholds[i];
      const strokeW = 2.7 - i * 0.2;
      const opacity = 0.20 + (thresholds.length - 1 - i) * 0.06;

      for (const [id, basePath] of svgIndex.pathById.entries()) {
        const mins = minsFromOriginToId(id);
        if (mins == null || mins > t) continue;
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", basePath.getAttribute("d") || "");
        p.setAttribute("class", "isochrone-path");
        p.setAttribute("stroke-width", String(Math.max(0.8, strokeW)));
        p.setAttribute("stroke-opacity", String(Math.min(0.6, opacity)));
        frag.appendChild(p);
      }
    }

    svgIndex.gIsochrones.appendChild(frag);
  };

  const clearOverlay = () => {
    if (svgIndex?.gOverlayRoutes) svgIndex.gOverlayRoutes.replaceChildren();
    if (svgIndex?.gOverlayStops) svgIndex.gOverlayStops.replaceChildren();
  };

  const clearLivingNodes = () => {
    if (svgIndex?.gLivingNodes) svgIndex.gLivingNodes.replaceChildren();
  };

  const renderLivingNodes = () => {
    if (!svgIndex?.gLivingNodes) return;
    const g = svgIndex.gLivingNodes;
    g.replaceChildren();
    if (getViewMode() !== "living") return;

    const rgb = LIVING_COLORS[livingColorKey] || LIVING_COLORS.teleportness;
    const denom = livingStats.max - livingStats.min;
    const norm = (v) => {
      if (v == null || !Number.isFinite(v)) return null;
      const t = denom > 0 ? clamp01((v - livingStats.min) / denom) : 0.5;
      return t;
    };

    const frag = document.createDocumentFragment();
    const r0 = 0.00007;
    const r1 = 0.00022;

    for (const n of neighborhoods) {
      const id = String(n.id);
      const c = n?.centroid;
      if (!Array.isArray(c) || c.length < 2) continue;
      const s = livingById.get(id);
      const t = norm(s);
      if (t == null) continue;
      const [x, y] = projectLonLat([Number(c[1]), Number(c[0])]);
      const r = r0 + r1 * Math.pow(t, 0.75);

      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", String(x));
      dot.setAttribute("cy", String(y));
      dot.setAttribute("r", String(r));
      dot.setAttribute("fill", `rgba(${rgb.r},${rgb.g},${rgb.b},0.55)`);
      dot.setAttribute("stroke", "rgba(255,255,255,0.85)");
      dot.setAttribute("stroke-width", "0.9");
      dot.setAttribute("vector-effect", "non-scaling-stroke");
      frag.appendChild(dot);
    }

    g.appendChild(frag);
  };

  const hubPositionForId = (id) => {
    const mapMode = getMapMode();
    if (mapMode === "cartogram") {
      const node = cartogramNodesById.get(String(id));
      if (node) return { x: node.x, y: node.y };
    }
    const nb = nbById().get(String(id));
    const c = nb?.centroid;
    if (!Array.isArray(c) || c.length < 2) return null;
    const [x, y] = projectLonLat([Number(c[1]), Number(c[0])]);
    return { x, y };
  };

  const renderHubMarkers = () => {
    if (!svgIndex?.gHubMarkers || !svgIndex?.gHubHalos) return;
    const mode = getViewMode();
    if (mode === "centrality" && centralityMetricKey !== "hub") {
      svgIndex.gHubMarkers.replaceChildren();
      svgIndex.gHubHalos.replaceChildren();
      return;
    }
    const gMarkers = svgIndex.gHubMarkers;
    const gHalos = svgIndex.gHubHalos;
    gMarkers.replaceChildren();
    gHalos.replaceChildren();

    const hubAllowed = !(mode === "centrality" && centralityMetricKey !== "hub");
    const activeHub = hubAllowed ? getActiveHubInfo() : null;
    const activeHubId = activeHub?.id ? String(activeHub.id) : null;
    const hasActiveHub = !!activeHubId;
    const showHalos = true;
    const minDim = baseViewBox ? Math.min(baseViewBox.w, baseViewBox.h) : 0.01;
    const ringR = minDim * 0.018;
    const coreR = ringR * 0.45;
    const haloRActive = minDim * 0.24;
    const haloRIdle = minDim * 0.14;

    const hubs = [];
    for (const [id, hub] of hubPresetById.entries()) {
      hubs.push({
        id,
        label: hub.label,
        boro: hub.boro || "",
        isActive: activeHubId != null && String(id) === String(activeHubId),
        isUser: false,
      });
    }
    if (activeHubId && !hubPresetById.has(String(activeHubId))) {
      const nb = nbById().get(String(activeHubId));
      hubs.push({
        id: String(activeHubId),
        label: activeHub?.label || (nb?.name || activeHubId),
        boro: nb?.borough || "",
        isActive: true,
        isUser: true,
      });
    }

    const haloFrag = document.createDocumentFragment();
    const markerFrag = document.createDocumentFragment();

    for (const hub of hubs) {
      const pos = hubPositionForId(hub.id);
      if (!pos) continue;
      const boroKeyValue = boroughKey(hub.boro);
      const ringColor = hubColor(boroKeyValue, hub.isActive ? 0.9 : 0.6);

      if (showHalos) {
        const drawHalo = hub.isActive || !hasActiveHub;
        if (drawHalo) {
          const halo = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          halo.setAttribute("cx", String(pos.x));
          halo.setAttribute("cy", String(pos.y));
          halo.setAttribute("r", String(hub.isActive ? haloRActive : haloRIdle));
          halo.setAttribute("fill", hubColor(boroKeyValue, hub.isActive ? 0.18 : 0.1));
          halo.setAttribute("class", "hub-halo");
          haloFrag.appendChild(halo);
        }
      }

      const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      ring.setAttribute("cx", String(pos.x));
      ring.setAttribute("cy", String(pos.y));
      ring.setAttribute("r", String(ringR * (hub.isActive ? 1.15 : 1)));
      ring.setAttribute("fill", "rgba(255,255,255,0.96)");
      ring.setAttribute("stroke", ringColor);
      ring.setAttribute("stroke-width", hub.isActive ? "2.2" : "1.5");
      ring.setAttribute("vector-effect", "non-scaling-stroke");
      ring.setAttribute("class", "hub-marker-ring");
      markerFrag.appendChild(ring);

      const core = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      core.setAttribute("cx", String(pos.x));
      core.setAttribute("cy", String(pos.y));
      core.setAttribute("r", String(coreR * (hub.isActive ? 1.1 : 1)));
      core.setAttribute("fill", ringColor);
      core.setAttribute("class", "hub-marker-core");
      markerFrag.appendChild(core);
    }

    gHalos.appendChild(haloFrag);
    gMarkers.appendChild(markerFrag);
  };

  const drawStopDots = ({ stopIndices, hueByLine, maxMinutes }) => {
    if (!svgIndex?.gOverlayStops) return;
    const g = svgIndex.gOverlayStops;
    g.replaceChildren();
    if (!stopIndices || stopIndices.length === 0) return;

    const frag = document.createDocumentFragment();

    // Approximate "pixel-ish" dot sizes in projected radians.
    const r = 0.00006;
    const rBig = 0.0001;

    const mkCircle = (idx, { big, color, stroke, strokeOpacity }) => {
      const [x, y] = stopProjected(idx);
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", String(x));
      c.setAttribute("cy", String(y));
      c.setAttribute("r", String(big ? rBig : r));
      c.setAttribute("fill", color || "rgba(2,6,23,0.35)");
      c.setAttribute("fill-opacity", "1");
      c.setAttribute("stroke", stroke || "rgba(255,255,255,0.0)");
      c.setAttribute("stroke-opacity", String(strokeOpacity ?? 0));
      c.setAttribute("stroke-width", "1.25");
      c.setAttribute("vector-effect", "non-scaling-stroke");
      return c;
    };

    for (const idx of stopIndices) {
      const d = lastRun?.dist?.[idx];
      if (!Number.isFinite(d)) continue;
      if (d > maxMinutes) continue;
      const firstIdx = lastRun?.firstRoute?.[idx];
      const route = hueByLine && firstIdx != null ? routes?.[firstIdx] : null;
      const fill = route?.color ? route.color : "rgba(2,6,23,0.25)";
      frag.appendChild(mkCircle(idx, { big: false, color: fill, stroke: "rgba(255,255,255,0.0)", strokeOpacity: 0 }));
    }

    if (originStopIndex != null) {
      frag.appendChild(
        mkCircle(originStopIndex, {
          big: true,
          color: "rgba(255,255,255,0.95)",
          stroke: "rgba(2,6,23,0.85)",
          strokeOpacity: 1,
        }),
      );
    }
    if (destStopIndex != null) {
      frag.appendChild(
        mkCircle(destStopIndex, {
          big: true,
          color: "rgba(2,6,23,0.85)",
          stroke: "rgba(255,255,255,0.95)",
          strokeOpacity: 1,
        }),
      );
    }

    g.appendChild(frag);
  };

  const drawRouteToDest = () => {
    clearOverlay();
    if (!lastRun || originStopIndex == null || destStopIndex == null || !svgIndex?.gOverlayRoutes) return;
    const path = reconstructStopPath(lastRun.prev, originStopIndex, destStopIndex);
    if (!path || path.length < 2) return;

    const g = svgIndex.gOverlayRoutes;
    for (let i = 1; i < path.length; i++) {
      const to = path[i];
      const from = path[i - 1];
      const routeIdx = lastRun.prevRoute[to]; // edge used to reach 'to'
      const route = routeIdx != null ? routes?.[routeIdx] : null;
      const color = route?.color || "#111827";
      const dashed = routeIdx == null;

      const [x1, y1] = stopProjected(from);
      const [x2, y2] = stopProjected(to);
      const seg = document.createElementNS("http://www.w3.org/2000/svg", "path");
      seg.setAttribute("d", `M ${x1} ${y1} L ${x2} ${y2}`);
      seg.setAttribute("fill", "none");
      seg.setAttribute("stroke", dashed ? "rgba(2,6,23,0.35)" : color);
      seg.setAttribute("stroke-width", "2.5");
      seg.setAttribute("stroke-linecap", "round");
      seg.setAttribute("stroke-linejoin", "round");
      seg.setAttribute("vector-effect", "non-scaling-stroke");
      if (dashed) seg.setAttribute("stroke-dasharray", "5 4");
      g.appendChild(seg);
    }

    const maxMinutes = getMaxMinutes();
    const hueByLine = HUE_BY_LINE_ALWAYS_ON;
    drawStopDots({ stopIndices: path, hueByLine, maxMinutes });
  };

  const drawSpreadFromOrigin = () => {
    clearOverlay();
    if (!lastRun || originStopIndex == null || !svgIndex?.gOverlayRoutes) return;
    const maxMinutes = getMaxMinutes();
    const hueByLine = HUE_BY_LINE_ALWAYS_ON;
    const corridors = true;

    // Corridor strength: size of subtree in the shortest-path tree (more downstream stops = thicker).
    const n = lastRun.prev.length;
    const children = new Array(n).fill(0).map(() => []);
    for (let v = 0; v < n; v++) {
      const u = lastRun.prev[v];
      if (u != null && u >= 0) children[u].push(v);
    }
    const order = [];
    const stack = [originStopIndex];
    while (stack.length) {
      const u = stack.pop();
      order.push(u);
      for (const v of children[u]) stack.push(v);
    }
    const subtree = new Array(n).fill(0);
    for (let i = order.length - 1; i >= 0; i--) {
      const u = order[i];
      let s = 1;
      for (const v of children[u]) s += subtree[v];
      subtree[u] = s;
    }
    const maxSub = Math.max(1, ...subtree);

    const g = svgIndex.gOverlayRoutes;
    const frag = document.createDocumentFragment();
    const seen = new Set();
    const includedStops = new Set([originStopIndex]);

    for (let v = 0; v < lastRun.prev.length; v++) {
      if (v === originStopIndex) continue;
      const d = lastRun.dist[v];
      if (!Number.isFinite(d) || d > maxMinutes) continue;
      const u = lastRun.prev[v];
      if (u == null || u < 0) continue;

      const key = `${u}-${v}`;
      if (seen.has(key)) continue;
      seen.add(key);
      includedStops.add(u);
      includedStops.add(v);

      const routeIdx = lastRun.prevRoute[v];
      const firstIdx = lastRun.firstRoute[v];
      const route = hueByLine
        ? routes?.[firstIdx != null ? firstIdx : routeIdx]
        : null;
      const color = route?.color || "rgba(2,6,23,0.22)";
      const dashed = routeIdx == null;
      const wNorm = corridors ? Math.sqrt(Math.max(0, subtree[v] - 1) / Math.max(1, maxSub - 1)) : 0;
      const strokeW = dashed ? 1.6 : corridors ? 0.9 + 4.3 * wNorm : 2.2;
      const alpha = dashed ? 0.65 : corridors ? 0.18 + 0.82 * wNorm : 0.9;

      const [x1, y1] = stopProjected(u);
      const [x2, y2] = stopProjected(v);
      const seg = document.createElementNS("http://www.w3.org/2000/svg", "path");
      seg.setAttribute("d", `M ${x1} ${y1} L ${x2} ${y2}`);
      seg.setAttribute("fill", "none");
      seg.setAttribute("stroke", dashed ? "rgba(2,6,23,0.25)" : color);
      seg.setAttribute("stroke-width", String(strokeW.toFixed(2)));
      seg.setAttribute("stroke-linecap", "round");
      seg.setAttribute("stroke-linejoin", "round");
      seg.setAttribute("vector-effect", "non-scaling-stroke");
      seg.setAttribute("opacity", String(alpha.toFixed(3)));
      if (dashed) seg.setAttribute("stroke-dasharray", "4 4");
      frag.appendChild(seg);
    }

    g.appendChild(frag);

    drawStopDots({ stopIndices: Array.from(includedStops), hueByLine, maxMinutes });
  };

  const restyle = () => {
    if (!svgIndex) return;
    const mode = getViewMode();
    const mapMode = getMapMode();
    const isDerived = getBaseUnit() === "derived";
    const origin = originId;
    const activeDestId = pinnedDestId != null ? pinnedDestId : hoveredDestId;
    const maxMinutes = getMaxMinutes();
    const hueByLine = HUE_BY_LINE_ALWAYS_ON;
    const hasOrigin = originId != null && lastRun != null;
    const livingRgb = LIVING_COLORS[livingColorKey] || LIVING_COLORS.teleportness;
    const showBase = mode === "time" && !hasOrigin;
    const baseFill = "rgba(15,23,42,0.14)";
    const baseStroke = "rgba(15,23,42,0.48)";

    for (const [id, path] of svgIndex.pathById.entries()) {
      const mins = minsFromOriginToId(id);
      const score = centralityById.get(String(id));
      const livingScore = livingById.get(String(id));
      const viewsScore = viewsById.get(String(id));
      let decideEntry = null;
      let decideStatus = null;
      const decideActive = isDecidePage;
      if (decideActive) {
        ensureJudgeResults();
        decideEntry = judgeById.get(String(id)) || null;
        if (decideEntry) decideStatus = decideEntry.reasons?.length ? "disqualified" : "recommended";
      }

      let { fill, fillOpacity } =
        mode === "centrality"
          ? centralityToFill(score, centralityStats.min, centralityStats.max)
          : mode === "living"
            ? livingToFill(livingScore, livingStats.min, livingStats.max, livingRgb)
            : mode === "views"
              ? viewsToFill(viewsScore, viewsStats.min, viewsStats.max)
            : !hasOrigin
              ? showBase
                ? { fill: baseFill, fillOpacity: 1 }
                : { fill: "rgba(0,0,0,0)", fillOpacity: 1 }
              : hueByLine
                ? minutesToFillHue(mins, maxMinutes, firstRouteForId(id)?.color)
                : minutesToFill(mins, maxMinutes);

      if (decideActive && judgeById.size) {
        if (decideStatus === "recommended") {
          fill = "rgba(34, 197, 94, 0.35)";
          fillOpacity = 1;
        } else if (decideStatus === "disqualified") {
          fill = "rgba(239, 68, 68, 0.28)";
          fillOpacity = 1;
        } else {
          fill = "rgba(148, 163, 184, 0.12)";
          fillOpacity = 1;
        }
      }
      const isOrigin = origin != null && String(origin) === String(id);
      const isHub =
        mode === "living" &&
        livingMetricKey === "teleportness" &&
        livingHubId != null &&
        String(livingHubId) === String(id);
      const isDest = activeDestId != null && String(activeDestId) === String(id);

      path.setAttribute("fill", fill);
      path.setAttribute("fill-opacity", isOrigin || isDest || isHub ? "1" : String(fillOpacity));
      path.setAttribute(
        "stroke",
        isOrigin
          ? "rgba(2,6,23,0.85)"
          : isHub
            ? "rgba(2,6,23,0.85)"
            : isDest
              ? "rgba(2,6,23,0.85)"
              : showBase
                ? baseStroke
                : boroughStrokeForId(id),
      );
      path.setAttribute(
        "stroke-opacity",
        isOrigin || isDest || isHub ? "1" : showBase ? "0.9" : isDerived ? "0.35" : "0.85",
      );
      path.setAttribute("stroke-width", isOrigin || isDest || isHub ? "2" : isDerived ? "0.7" : "1.2");

      if (mapMode === "cartogram") {
        const node = cartogramNodesById.get(String(id));
        const scale = cartogramScaleById.get(String(id)) || 1;
        if (node && Number.isFinite(scale)) {
          path.setAttribute(
            "transform",
            `translate(${node.x} ${node.y}) scale(${scale}) translate(${-node.x} ${-node.y})`,
          );
        }
      } else {
        path.removeAttribute("transform");
      }
    }

    renderHubMarkers();

    if (mode === "centrality") {
      clearOverlay();
      clearIsochrones();
      clearLivingNodes();
      return;
    }
    if (mode === "living") {
      clearOverlay();
      clearIsochrones();
      renderLivingNodes();
      return;
    }
    if (mode === "views") {
      clearOverlay();
      clearIsochrones();
      clearLivingNodes();
      return;
    }
    if (mapMode === "cartogram") {
      clearOverlay();
      clearIsochrones();
      clearLivingNodes();
      return;
    }
    clearLivingNodes();
    renderIsochrones();
    if (destStopIndex != null) drawRouteToDest();
    else if (originStopIndex != null) drawSpreadFromOrigin();
    else clearOverlay();
  };

  const onClickFeature = (id, event = null) => {
    const nb = nbById().get(String(id));
    if (!nb) return;
    const mode = getViewMode();
    if (mode === "centrality") return;

    if (mode === "views") {
      const clickedId = String(id);
      pinnedDestId = pinnedDestId === clickedId ? null : clickedId;
      hoveredDestId = pinnedDestId ? clickedId : null;
      restyle();
      renderLabels();
      renderViewsPanel();
      return;
    }

    if (mode === "living") {
      const clickedId = String(id);
      pinnedDestId = pinnedDestId === clickedId ? null : clickedId;
      hoveredDestId = null;
      originId = null;
      originStopIndex = null;
      destStopIndex = null;
      lastRun = null;
      restyle();
      renderLabels();
      renderLivingPanel();
      return;
    }

    const clickedId = String(id);
    const isShift = !!event?.shiftKey;
    const prevOriginId = originId != null ? String(originId) : null;

    // Default behavior: clicking sets the origin (so you can change origin freely).
    // Hold Shift while clicking to pin/unpin a destination.
    if (!isShift) {
      originId = clickedId;
      hoveredDestId = null;
      pinnedDestId = null;
    } else if (originId != null && clickedId !== String(originId)) {
      pinnedDestId = pinnedDestId === clickedId ? null : clickedId;
    }

    const originNb = originId != null ? nbById().get(String(originId)) : null;
    originStopIndex = originNb?.stop_index ?? null;
    if (originStopIndex != null) {
      lastRun = dijkstraWithPrev(adjacency, originStopIndex);
    } else {
      lastRun = null;
    }

    const activeDestId = pinnedDestId != null ? pinnedDestId : hoveredDestId;
    const destNb = activeDestId != null ? nbById().get(String(activeDestId)) : null;
    destStopIndex = destNb?.stop_index ?? null;

    restyle();
    if (!isShift && prevOriginId !== String(originId)) renderLabels();

    updateListsAndDirections();
  };

  const showCentralityHover = (id) => {
    const destNameEl = document.getElementById("destName");
    const routeSummaryEl = document.getElementById("routeSummary");
    const routeStepsEl = document.getElementById("routeSteps");
    if (!destNameEl || !routeSummaryEl || !routeStepsEl) return;
    renderNameWithBorough(
      destNameEl,
      displayName(nameForId(id)),
      boroughForId(id),
      confidenceForId(id),
    );
    routeSummaryEl.textContent = `${centralityLabel}: ${formatCentralityValue(id)}`;
    setList(routeStepsEl, []);
    updateCartogramScalar(id);
  };

  const resetCentralityHover = () => {
    const destNameEl = document.getElementById("destName");
    const routeSummaryEl = document.getElementById("routeSummary");
    const routeStepsEl = document.getElementById("routeSteps");
    if (!destNameEl || !routeSummaryEl || !routeStepsEl) return;
    destNameEl.replaceChildren(document.createTextNode("Hover a neighborhood"));
    routeSummaryEl.textContent = "";
    setList(routeStepsEl, []);
    updateCartogramScalar(null);
  };

  onClickFeature.onHover = (id) => {
    const mode = getViewMode();
    if (mode === "centrality") {
      hoveredDestId = String(id);
      showCentralityHover(id);
      restyle();
      renderLabels();
      return;
    }
    if (mode === "views") {
      if (pinnedDestId != null) return;
      hoveredDestId = String(id);
      restyle();
      renderViewsPanel();
      return;
    }
    if (mode === "living") {
      if (pinnedDestId != null) return;
      hoveredDestId = String(id);
      destStopIndex = null;
      restyle();
      renderLivingPanel();
      return;
    }
    if (originId == null) return;
    if (pinnedDestId != null) return;
    if (String(id) === String(originId)) return;
    hoveredDestId = String(id);
    const destNb = nbById().get(String(hoveredDestId));
    destStopIndex = destNb?.stop_index ?? null;
    restyle();
    updateListsAndDirections();
  };

  onClickFeature.onHoverEnd = (id) => {
    const mode = getViewMode();
    if (mode === "centrality") {
      if (pinnedDestId) {
        hoveredDestId = String(pinnedDestId);
        showCentralityHover(pinnedDestId);
        restyle();
        renderLabels();
        return;
      }
      hoveredDestId = null;
      resetCentralityHover();
      restyle();
      renderLabels();
      return;
    }
    if (mode === "views") {
      if (pinnedDestId != null) return;
      if (hoveredDestId == null) return;
      if (String(id) !== String(hoveredDestId)) return;
      hoveredDestId = null;
      restyle();
      renderViewsPanel();
      return;
    }
    if (mode === "living") {
      if (pinnedDestId != null) return;
      if (hoveredDestId == null) return;
      if (String(id) !== String(hoveredDestId)) return;
      hoveredDestId = null;
      restyle();
      renderLivingPanel();
      return;
    }
    if (pinnedDestId != null) return;
    if (hoveredDestId == null) return;
    if (String(id) !== String(hoveredDestId)) return;
    hoveredDestId = null;
    destStopIndex = null;
    restyle();
    updateListsAndDirections();
  };

  const render = ({ preserveState = false } = {}) => {
    const mapMode = getMapMode();
    const baseUnit = getBaseUnit();
    const isDerived = baseUnit === "derived";
    if (mapMode === "cartogram") {
      ensureCartogram();
      const titleFn = (feature, props) => {
        const id = String(props?.atlas_id || "");
        const nb = nbById().get(String(id));
        const name = nb?.name || props?.name || id;
        const val = getScalarValueById(id, cartogramScalarKey);
        const label = SCALAR_REGISTRY[cartogramScalarKey]?.label || cartogramScalarKey;
        return val != null ? `${name}\n${label}: ${formatScalarValue(cartogramScalarKey, val)}` : String(name);
      };
      const outlineGeo = isDerived ? { type: "FeatureCollection", features: (tractsGeo?.features || []).filter((f) => isTriBorough(getBorough(f?.properties || {}))) } : null;
      svgIndex = renderGeojson(svg, visibleGeo, onClickFeature, {
        viewBox: baseViewBox,
        titleFn,
        outlineGeo,
        outlineStyle: { stroke: "rgba(15,23,42,0.55)", strokeWidth: 2.0, opacity: 0.9 },
      });
    } else {
      const outlineGeo = isDerived ? { type: "FeatureCollection", features: (tractsGeo?.features || []).filter((f) => isTriBorough(getBorough(f?.properties || {}))) } : null;
      svgIndex = renderGeojson(svg, visibleGeo, onClickFeature, {
        viewBox: baseViewBox,
        outlineGeo,
        outlineStyle: { stroke: "rgba(15,23,42,0.55)", strokeWidth: 2.0, opacity: 0.9 },
      });
    }

    initialViewBox = baseViewBox ? { ...baseViewBox } : svgIndex?.initialViewBox ? { ...svgIndex.initialViewBox } : null;
    if (initialViewBox) {
      svg.__atlasInitialViewBox = { ...initialViewBox };
      setSvgViewBox(svg, { ...initialViewBox });
    }

    if (!preserveState) {
      originId = null;
      hoveredDestId = null;
      pinnedDestId = null;
      originStopIndex = null;
      destStopIndex = null;
      lastRun = null;
    }

    restyle();
    updateListsAndDirections();
    setStatus(`${svgIndex.pathById.size} nabes loaded.`);
    renderLabels();
  };

  const renderLabels = () => {
    if (!labelRailLeftEl || !labelRailRightEl || !leadersSvg) return;
    labelRailLeftEl.replaceChildren();
    labelRailRightEl.replaceChildren();
    leadersSvg.replaceChildren();

    const mode = getViewMode();
    const vb = readViewBox(svg);
    if (!vb) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const worldToScreen = (x, y) => ({
      x: ((x - vb.x) / vb.w) * rect.width,
      y: ((y - vb.y) / vb.h) * rect.height,
    });

    const hasOrigin = originId != null && lastRun != null;
    const mapMode = getMapMode();

    const candidates = [];
    const nameOverrideById = new Map();
    for (const feat of visibleGeo?.features || []) {
      const props = feat?.properties || {};
      const id = String(props.atlas_id || "");
      if (!id) continue;
      const nm = featureName(props);
      if (nm) nameOverrideById.set(id, nm);
    }
    for (const n of neighborhoods) {
      const c = n?.centroid;
      const name = nameOverrideById.get(String(n?.id)) || n?.name;
      if (!c || !name) continue;
      const [lat, lon] = c;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      let x;
      let y;
      if (mapMode === "cartogram") {
        const node = cartogramNodesById.get(String(n.id));
        if (node) {
          x = node.x;
          y = node.y;
        }
      }
      if (x == null || y == null) {
        [x, y] = projectLonLat([lon, lat]);
      }
      if (x < vb.x - vb.w * 0.05 || x > vb.x + vb.w * 1.05) continue;
      if (y < vb.y - vb.h * 0.05 || y > vb.y + vb.h * 1.05) continue;

      const mins = hasOrigin ? minsFromOriginToId(n.id) : null;
      const centrality = centralityById.get(String(n.id)) ?? 0;
      const living = livingById.get(String(n.id)) ?? 0;
      const s = worldToScreen(x, y);
      candidates.push({
        id: String(n.id),
        name,
        x,
        y,
        sx: s.x,
        sy: s.y,
        mins,
        centroid: c,
        centrality,
        living,
      });
    }

    const candidateById = new Map(candidates.map((c) => [String(c.id), c]));
    const labelTargets = new Map();
    const hubAllowed = !(mode === "centrality" && centralityMetricKey !== "hub");
    const activeHub = hubAllowed ? getActiveHubInfo() : null;
    const activeHubId = activeHub?.id ? String(activeHub.id) : null;
    const allowSpokes = true;

    const addLabel = (id, priority, meta = {}) => {
      if (!id) return;
      const key = String(id);
      const c = candidateById.get(key);
      if (!c) return;
      const existing = labelTargets.get(key);
      const isHub = (meta.isHub ?? hubPresetById.has(key)) || key === activeHubId;
      const entry = { ...c, priority, isHub, isActiveHub: meta.isActiveHub || false, isSpoke: meta.isSpoke || false };
      if (!existing || priority > existing.priority) labelTargets.set(key, entry);
    };

    if (hoveredDestId) addLabel(hoveredDestId, 120);
    if (hoveredRailId) addLabel(hoveredRailId, 118);
    if (pinnedDestId) addLabel(pinnedDestId, 110);
    if (originId) addLabel(originId, 105);
    if (activeHubId) addLabel(activeHubId, 100, { isHub: true, isActiveHub: true });

    if (allowSpokes && hubAllowed) {
      if (activeHubId) {
        const spokes = getHubSpokeData(activeHubId)
          .slice()
          .sort((a, b) => a.minutes - b.minutes)
          .slice(0, SPOKE_LABEL_COUNT);
        spokes.forEach((s, idx) => addLabel(s.id, 80 - idx, { isSpoke: true }));
      } else if (hasOrigin) {
        const ids = getOriginSpokeIds(SPOKE_LABEL_COUNT);
        ids.forEach((sid, idx) => addLabel(sid, 75 - idx, { isSpoke: true }));
      }
    }

    let chosen = Array.from(labelTargets.values());
    chosen.sort((a, b) => b.priority - a.priority);
    if (chosen.length > LABEL_BUDGET) chosen = chosen.slice(0, LABEL_BUDGET);

    const left = [];
    const right = [];
    for (const c of chosen) (c.sx < rect.width * 0.5 ? left : right).push(c);

    if (!chosen.length) {
      labelRailLeftEl.style.display = "none";
      labelRailRightEl.style.display = "none";
      leadersSvg.replaceChildren();
      return;
    }

    labelRailLeftEl.style.display = "";
    labelRailRightEl.style.display = "";

    const railWidth = 220;
    const padTop = 10;
    const padBottom = 10;
    const usableH = Math.max(0, rect.height - padTop - padBottom);
    const minGap = 16;
    const maxPerSide = LABEL_BUDGET;

    const place = (items) => {
      const pts = items
        .slice()
        .sort((a, b) => a.sy - b.sy)
        .map((c) => ({ ...c, y: clamp(c.sy - padTop, 0, usableH) }));
      for (let i = 1; i < pts.length; i++) pts[i].y = Math.max(pts[i].y, pts[i - 1].y + minGap);
      if (pts.length) {
        const overflow = pts[pts.length - 1].y - usableH;
        if (overflow > 0) {
          for (const p of pts) p.y -= overflow;
          for (let i = pts.length - 2; i >= 0; i--) pts[i].y = Math.min(pts[i].y, pts[i + 1].y - minGap);
          for (const p of pts) p.y = clamp(p.y, 0, usableH);
        }
      }
      return pts;
    };

    const leftPlacedAll = place(left);
    const rightPlacedAll = place(right);
    const leftPlaced = leftPlacedAll.slice(0, maxPerSide);
    const rightPlaced = rightPlacedAll.slice(0, maxPerSide);
    const leftHidden = Math.max(0, leftPlacedAll.length - leftPlaced.length);
    const rightHidden = Math.max(0, rightPlacedAll.length - rightPlaced.length);
    const activeId = hoveredRailId || hoveredDestId || pinnedDestId || null;

    const mkLabel = (c, yPx) => {
      const d = document.createElement("div");
      d.className = "rail-label";
      d.style.top = `${Math.round(yPx - 8)}px`;
      d.textContent = displayName(c.name);
      if (c.isHub) d.classList.add("is-hub");
      if (c.isActiveHub) d.classList.add("is-active-hub");
      if (c.isSpoke) d.classList.add("is-spoke");
      if (activeId && String(activeId) === String(c.id)) d.classList.add("is-active");
      d.addEventListener("mouseenter", () => {
        hoveredRailId = c.id;
        onClickFeature.onHover?.(c.id);
        scheduleLabelsRerender?.();
      });
      d.addEventListener("mouseleave", () => {
        if (hoveredRailId === c.id) hoveredRailId = null;
        onClickFeature.onHoverEnd?.(c.id);
        scheduleLabelsRerender?.();
      });
      return d;
    };

    for (const c of leftPlaced) labelRailLeftEl.appendChild(mkLabel(c, c.y + padTop));
    for (const c of rightPlaced) labelRailRightEl.appendChild(mkLabel(c, c.y + padTop));

    const mkMore = (hidden) => {
      if (!hidden) return null;
      const d = document.createElement("div");
      d.className = "rail-more";
      d.style.bottom = "0px";
      d.textContent = `+ ${hidden} more`;
      return d;
    };
    const lm = mkMore(leftHidden);
    const rm = mkMore(rightHidden);
    if (lm) labelRailLeftEl.appendChild(lm);
    if (rm) labelRailRightEl.appendChild(rm);

    // Leader lines: only for origin/pinned/hovered (avoid spiderweb).
    setSvgViewBoxPixels(leadersSvg, Math.round(rect.width), Math.round(rect.height));
    const activeLeaderIds = new Set();
    if (originId) activeLeaderIds.add(String(originId));
    if (pinnedDestId) activeLeaderIds.add(String(pinnedDestId));
    if (hoveredRailId) activeLeaderIds.add(String(hoveredRailId));
    if (hoveredDestId) activeLeaderIds.add(String(hoveredDestId));
    if (activeHubId && labelTargets.has(String(activeHubId))) activeLeaderIds.add(String(activeHubId));
    if (!activeLeaderIds.size) return;

    const byId = new Map();
    for (const c of leftPlaced) byId.set(String(c.id), { ...c, side: "left", railY: c.y + padTop });
    for (const c of rightPlaced) byId.set(String(c.id), { ...c, side: "right", railY: c.y + padTop });

    const frag = document.createDocumentFragment();
    const mkLeader = (fromX, fromY, toX, toY, midX, bold) => {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", `M ${fromX} ${fromY} L ${midX} ${fromY} L ${toX} ${toY}`);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", bold ? "rgba(15, 23, 42, 0.38)" : "rgba(15, 23, 42, 0.22)");
      p.setAttribute("stroke-width", bold ? "1.8" : "1.25");
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
      return p;
    };

    const leftTextX = railWidth - 6;
    const leftElbowX = railWidth + 6;
    const rightTextX = rect.width - railWidth + 6;
    const rightElbowX = rect.width - railWidth - 6;

    for (const id of activeLeaderIds) {
      const c = byId.get(String(id));
      if (!c) continue;
      const bold =
        String(id) === String(originId) || String(id) === String(pinnedDestId) || String(id) === String(hoveredRailId);
      if (c.side === "left") frag.appendChild(mkLeader(leftTextX, c.railY, c.sx, c.sy, leftElbowX, bold));
      else frag.appendChild(mkLeader(rightTextX, c.railY, c.sx, c.sy, rightElbowX, bold));
    }

    leadersSvg.appendChild(frag);
  };

  scheduleLabelsRerender = (() => {
    let raf = null;
    return () => {
      if (raf != null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        renderLabels();
      });
    };
  })();

  const renderLivingPanel = () => {
    if (!isLivingPage) return;
    const mode = getViewMode();
    if (mode !== "living") return;

    const hintEl = document.getElementById("livingMetricHint");
    const topTitleEl = document.getElementById("livingTopTitle");
    const botTitleEl = document.getElementById("livingBottomTitle");
    const topEl = document.getElementById("livingTop");
    const botEl = document.getElementById("livingBottom");
    const hoverNameEl = document.getElementById("livingHoverName");
    const hoverMetaEl = document.getElementById("livingHoverMeta");
    const hoverExtraEl = document.getElementById("livingHoverExtra");
    const legendGradEl = document.getElementById("livingLegendGradient");
    const legendLeftEl = document.getElementById("livingLegendLeft");
    const legendRightEl = document.getElementById("livingLegendRight");
    if (!topEl || !botEl || !hoverNameEl || !hoverMetaEl || !hoverExtraEl) return;

    const rgb = LIVING_COLORS[livingColorKey] || LIVING_COLORS.teleportness;
    if (legendGradEl) {
      legendGradEl.style.background = `linear-gradient(90deg, rgba(${rgb.r},${rgb.g},${rgb.b},0.0), rgba(${rgb.r},${rgb.g},${rgb.b},0.90))`;
    }

    if (hintEl) {
      hintEl.textContent = `“Minutes saved” vs a baseline speed to ${livingHubLabel || "the hub"}. Higher = more “teleport-y”.`;
    }
    if (topTitleEl) topTitleEl.textContent = `Most teleport-y to ${livingHubLabel || "hub"}`;
    if (botTitleEl) botTitleEl.textContent = `Least teleport-y to ${livingHubLabel || "hub"}`;
    if (legendLeftEl) legendLeftEl.textContent = formatSignedMinutes(livingRawStats.min);
    if (legendRightEl) legendRightEl.textContent = formatSignedMinutes(livingRawStats.max);

    const rows = neighborhoods
      .map((n) => {
        const id = String(n.id);
        return {
          id,
          name: displayName(nameForId(n.id)),
          sort: livingById.get(id),
          raw: livingRawById.get(id),
        };
      })
      .filter((r) => Number.isFinite(r.sort) && Number.isFinite(r.raw));
    rows.sort((a, b) => b.sort - a.sort);

    const fmtRow = (r) => {
      const d = livingDetailsById.get(String(r.id)) || {};
      const line = d.first_line ? ` · ${d.first_line}` : "";
      return `${r.name} — ${formatSignedMinutes(Number(r.raw))} saved · ${d.minutes ?? "—"} min${line}`;
    };

    setList(topEl, rows.slice(0, 10).map(fmtRow));
    setList(botEl, rows.slice(-10).reverse().map(fmtRow));

    const activeId = pinnedDestId != null ? pinnedDestId : hoveredDestId;
    if (!activeId) {
      hoverNameEl.replaceChildren(document.createTextNode("Hover a neighborhood"));
      hoverMetaEl.textContent = "";
      hoverExtraEl.textContent = "";
      updateCartogramScalar(null);
      renderSpokesPanel();
      return;
    }

    renderNameWithBorough(
      hoverNameEl,
      displayName(nameForId(activeId)),
      boroughForId(activeId),
      confidenceForId(activeId),
    );

    const d = livingDetailsById.get(String(activeId)) || null;
    if (!d) {
      hoverMetaEl.textContent = "—";
      hoverExtraEl.textContent = "";
      return;
    }

    const line = d.first_line ? ` · ${d.first_line}` : "";
    hoverMetaEl.textContent = `${d.minutes} min · ${d.distance_km} km · ${formatSignedMinutes(d.minutes_saved)} saved${line}`;
    hoverExtraEl.textContent = `expected ${d.expected_minutes} min`;
    updateCartogramScalar(activeId);
    renderSpokesPanel();
  };

  const computeJudgeResults = () => {
    judgeById = new Map();
    judgeResults = { recommended: [], disqualified: [], tipping: null };

    if (!minutesMatrix?.length || (!isDecidePage && centralityMetricKey !== "hub") || !hubCentralityHubId) return;
    const hubIdx = indexById().get(String(hubCentralityHubId));
    if (hubIdx == null) return;

    const recommended = [];
    const disqualified = [];
    for (let i = 0; i < neighborhoods.length; i++) {
      const n = neighborhoods[i];
      const id = String(n.id);
      const commute = minutesMatrix?.[i]?.[hubIdx];
      const walk = walkMinutesById.get(id);
      const lines = lineCountById.get(id) ?? 0;

      const reasons = evaluateThresholds({ commute, walk, lines }, judgeConfig);
      const entry = {
        id,
        name: displayName(nameForId(id)),
        commute,
        walk,
        lines,
        reasons,
      };
      judgeById.set(id, entry);

      if (reasons.length) {
        let severity = 0;
        if (Number.isFinite(commute) && commute > judgeConfig.maxCommute) severity += commute - judgeConfig.maxCommute;
        if (Number.isFinite(walk) && walk > judgeConfig.maxWalk) severity += (walk - judgeConfig.maxWalk) * 1.5;
        if (Number.isFinite(lines) && lines < judgeConfig.minLines) severity += (judgeConfig.minLines - lines) * 5;
        entry.severity = severity;
        disqualified.push(entry);
      } else {
        recommended.push(entry);
      }
    }

    const pareto = paretoFront(recommended, { minimize: ["commute", "walk"], maximize: ["lines"] });
    const pool = pareto.length ? pareto : recommended;

    const ranges = {};
    for (const key of ["commute", "walk", "lines"]) {
      const vals = pool.map((d) => d[key]).filter((v) => Number.isFinite(v));
      if (!vals.length) continue;
      ranges[key] = { min: Math.min(...vals), max: Math.max(...vals) };
    }

    const weights = JUDGE_WEIGHTS[judgeConfig.priority] || JUDGE_WEIGHTS.balanced;
    const scored = scoreItems(pool, { weights, ranges, invert: { lines: true } });
    scored.sort((a, b) => a.score - b.score);

    disqualified.sort((a, b) => (b.severity || 0) - (a.severity || 0));

    const tipping = computeTipping(scored[0], scored[1], { ranges, weights });
    judgeResults = { recommended: scored, disqualified, tipping, ranges, weights };
  };

  const ensureJudgeResults = () => {
    const key = [
      hubCentralityHubId || "",
      getProfile(),
      getBaseUnit(),
      judgeConfig.maxCommute,
      judgeConfig.maxWalk,
      judgeConfig.minLines,
      judgeConfig.priority,
      neighborhoods.length,
    ].join("|");
    if (key === judgeCacheKey) return;
    computeJudgeResults();
    judgeCacheKey = key;
  };

  const renderJudgeList = (el, items, formatWhy) => {
    if (!el) return;
    el.replaceChildren();
    for (const item of items) {
      const li = document.createElement("li");
      li.className = "judge-item";

      const name = document.createElement("div");
      name.className = "judge-item-name";
      name.textContent = item.name;

      const why = document.createElement("div");
      why.className = "judge-item-why";
      why.textContent = formatWhy(item);

      li.appendChild(name);
      li.appendChild(why);

      li.addEventListener("mouseenter", () => onClickFeature.onHover?.(item.id));
      li.addEventListener("mouseleave", () => onClickFeature.onHoverEnd?.(item.id));
      li.addEventListener("click", (e) => {
        e.preventDefault();
        const clicked = String(item.id);
        pinnedDestId = pinnedDestId === clicked ? null : clicked;
        hoveredDestId = null;
        if (pinnedDestId) {
          onClickFeature.onHover?.(pinnedDestId);
        } else {
          onClickFeature.onHoverEnd?.(clicked);
        }
        restyle();
        renderLabels();
        updateListsAndDirections();
      });

      el.appendChild(li);
    }
  };

  const renderJudgePanels = () => {
    if (!isCentralityPage && !isDecidePage) return;
    const panel = document.getElementById("judgePanel");
    const recEl = document.getElementById("judgeRecommended");
    const disqEl = document.getElementById("judgeDisqualified");
    const threshEl = document.getElementById("judgeThresholds");
    const tipEl = document.getElementById("judgeTipping");

    if (!panel || !recEl || !disqEl || !threshEl || !tipEl) return;
    if (!isDecidePage && centralityMetricKey !== "hub") {
      panel.hidden = false;
      recEl.replaceChildren();
      disqEl.replaceChildren();
      threshEl.textContent = "Switch to “To hub” to use Judge.";
      tipEl.textContent = "—";
      return;
    }

    ensureJudgeResults();
    const top = judgeResults.recommended.slice(0, 8);
    const bottom = judgeResults.disqualified.slice(0, 8);

    renderJudgeList(recEl, top, (d) => {
      const commute = Number.isFinite(d.commute) ? `${Math.round(d.commute)}m` : "—";
      const walk = Number.isFinite(d.walk) ? `${d.walk.toFixed(1)}m walk` : "—";
      return `Commute ${commute} · ${walk} · ${d.lines} lines`;
    });

    renderJudgeList(disqEl, bottom, (d) => (d.reasons?.length ? d.reasons.join("; ") : "Fails thresholds"));

    const activeId = pinnedDestId != null ? pinnedDestId : hoveredDestId;
    if (!activeId || !judgeById.has(String(activeId))) {
      threshEl.textContent = "Hover a neighborhood to see threshold checks.";
    } else {
      const entry = judgeById.get(String(activeId));
      if (!entry?.reasons?.length) {
        threshEl.textContent = "Passes all thresholds.";
      } else {
        threshEl.textContent = entry.reasons.join(" · ");
      }
    }

    if (judgeResults?.tipping) {
      const deltas = judgeResults.tipping;
      const parts = [];
      if (deltas.commute) parts.push(`+${Math.round(deltas.commute)} min commute`);
      if (deltas.walk) parts.push(`+${deltas.walk.toFixed(1)} min walk`);
      if (deltas.lines) parts.push(`-${Math.max(1, Math.round(deltas.lines))} lines`);
      tipEl.textContent = parts.length ? `Top pick flips with ${parts.join(", ")}.` : "—";
    } else {
      tipEl.textContent = "Not enough candidates to compute tipping point.";
    }
  };

  const renderSpokeList = (el, items, formatFn) => {
    if (!el) return;
    el.replaceChildren();
    const mode = getViewMode();
    for (const item of items) {
      const li = document.createElement("li");
      li.className = "spoke-item";
      li.textContent = formatFn(item);
      if (pinnedDestId && String(pinnedDestId) === String(item.id)) li.classList.add("is-pinned");

      li.addEventListener("mouseenter", () => {
        onClickFeature.onHover?.(item.id);
      });
      li.addEventListener("mouseleave", () => {
        onClickFeature.onHoverEnd?.(item.id);
      });
      li.addEventListener("click", (e) => {
        e.preventDefault();
        if (mode === "living") {
          onClickFeature(item.id);
          return;
        }
        if (mode === "centrality") {
          const clicked = String(item.id);
          pinnedDestId = pinnedDestId === clicked ? null : clicked;
          hoveredDestId = null;
          if (pinnedDestId) {
            onClickFeature.onHover?.(pinnedDestId);
          } else {
            onClickFeature.onHoverEnd?.(clicked);
          }
          restyle();
          renderLabels();
        }
      });

      el.appendChild(li);
    }
  };

  const renderSpokesPanel = () => {
    const panelEl = document.getElementById("spokesPanel");
    const hubLabelEl = document.getElementById("spokesHubLabel");
    const closestEl = document.getElementById("spokesClosest");
    const teleportEl = document.getElementById("spokesTeleport");
    if (!panelEl || !closestEl || !teleportEl) return;

    const mode = getViewMode();
    const activeHub = getActiveHubInfo();
    if (!activeHub || (mode === "centrality" && centralityMetricKey !== "hub")) {
      panelEl.hidden = true;
      return;
    }

    const hubId = String(activeHub.id);
    let data = getHubSpokeData(hubId);
    if (mode === "living" && livingExcludeShortTrips) {
      data = data.filter((d) => d.distanceKm != null && d.distanceKm >= 6);
    }
    if (!data.length) {
      panelEl.hidden = true;
      return;
    }

    panelEl.hidden = false;
    if (hubLabelEl) hubLabelEl.textContent = activeHub.label || "Hub";

    const closest = data
      .slice()
      .sort((a, b) => a.minutes - b.minutes)
      .slice(0, 10);

    const teleporty = data
      .filter((d) => d.minutesSaved != null && Number.isFinite(d.minutesSaved))
      .sort((a, b) => b.minutesSaved - a.minutesSaved)
      .slice(0, 8);

    renderSpokeList(closestEl, closest, (d) => {
      const line = d.line ? ` · ${d.line}` : "";
      const name = displayName(nameForId(d.id || d.name));
      return `${name} — ${Math.round(d.minutes)} min${line}`;
    });

    renderSpokeList(teleportEl, teleporty, (d) => {
      const line = d.line ? ` · ${d.line}` : "";
      const name = displayName(nameForId(d.id || d.name));
      const saved = formatSignedMinutes(Number(d.minutesSaved));
      return `${name} — ${saved} saved · ${Math.round(d.minutes)} min${line}`;
    });
  };

  const renderCentralityPanel = () => {
    const panel = document.getElementById("centralityPanel");
    const topEl = document.getElementById("centralTop");
    const botEl = document.getElementById("centralBottom");
    if (!panel || !topEl || !botEl) {
      renderJudgePanels();
      renderSpokesPanel();
      return;
    }

    const mode = getViewMode();
    panel.hidden = mode !== "centrality";
    if (mode !== "centrality") {
      renderSpokesPanel();
      return;
    }
    updateCartogramScalar(null);

    const rows = neighborhoods
      .map((n) => ({
        id: String(n.id),
        name: displayName(nameForId(n.id)),
        sort: centralityById.get(String(n.id)),
        raw: centralityRawById.get(String(n.id)),
      }))
      .filter((r) => Number.isFinite(r.sort) && Number.isFinite(r.raw));
    rows.sort((a, b) => b.sort - a.sort);

    const fmt = (r) => `${r.name} — ${formatCentralityValue(r.id)}`;
    setList(topEl, rows.slice(0, 10).map(fmt));
    setList(botEl, rows.slice(-10).reverse().map(fmt));
    renderJudgePanels();
    renderSpokesPanel();
  };

  const updateListsAndDirections = () => {
    const mode = getViewMode();
    if (mode === "centrality") {
      renderCentralityPanel();
      return;
    }
    if (mode === "living") {
      renderLivingPanel();
      return;
    }
    if (mode === "views") {
      renderViewsPanel();
      return;
    }
    if (!originId || !lastRun) {
      updatePanel({ originIndex: null, neighborhoods: [], minutesRow: [], routeRow: [], routes: [], nameFn: displayName });
      updateCartogramScalar(null);
      return;
    }

    const originIdx = neighborhoods.findIndex((n) => String(n.id) === String(originId));
    const minutesRow = neighborhoods.map((n) => minsFromOriginToId(n.id));
    const routeRow = neighborhoods.map((n) => {
      const nb = nbById().get(String(n.id));
      const si = nb?.stop_index;
      if (si == null) return null;
      return lastRun.firstRoute[si];
    });

    updatePanel({ originIndex: originIdx, neighborhoods, minutesRow, routeRow, routes, nameFn: displayName });

    const destNameEl = document.getElementById("destName");
    const routeSummaryEl = document.getElementById("routeSummary");
    const routeStepsEl = document.getElementById("routeSteps");

    const activeDestId = pinnedDestId != null ? pinnedDestId : hoveredDestId;
    if (!activeDestId || destStopIndex == null || originStopIndex == null) {
      destNameEl.replaceChildren(document.createTextNode("Hover a neighborhood"));
      routeSummaryEl.textContent = "";
      setList(routeStepsEl, []);
      updateCartogramScalar(originId);
      return;
    }

    renderNameWithBorough(
      destNameEl,
      displayName(nameForId(activeDestId)),
      boroughForId(activeDestId),
      confidenceForId(activeDestId),
    );

    const destMinutes = minsFromOriginToId(activeDestId);
    if (destMinutes == null) {
      routeSummaryEl.textContent = "Unreachable";
      setList(routeStepsEl, []);
      return;
    }

    const stopPath = reconstructStopPath(lastRun.prev, originStopIndex, destStopIndex);
    if (!stopPath) {
      routeSummaryEl.textContent = "Unreachable";
      setList(routeStepsEl, []);
      return;
    }

    // Build route-sequence like Q → B → D and step list with transfer points.
    const segments = [];
    let current = null;
    let segStart = stopPath[0];

    for (let i = 1; i < stopPath.length; i++) {
      const to = stopPath[i];
      const ridx = lastRun.prevRoute[to];
      const label = ridx == null ? null : routes?.[ridx]?.short_name || routes?.[ridx]?.id || null;
      if (label !== current) {
        if (current != null) segments.push({ line: current, from: segStart, to: stopPath[i - 1] });
        current = label;
        segStart = stopPath[i - 1];
      }
    }
    if (current != null) segments.push({ line: current, from: segStart, to: stopPath[stopPath.length - 1] });

    const seq = segments.map((s) => s.line).filter(Boolean);
    routeSummaryEl.textContent = `${destMinutes} min · ${seq.join(" → ") || "—"}`;

    const steps = [];
    for (const s of segments) {
      const fromName = stops[s.from]?.name || stops[s.from]?.id;
      const toName = stops[s.to]?.name || stops[s.to]?.id;
      steps.push(`${s.line}: ${fromName} → ${toName}`);
    }
    setList(routeStepsEl, steps.slice(0, 8));
    updateCartogramScalar(activeDestId);
  };

  const init = async () => {
    clearError();
    try {
      availableScalarKeys = await loadScalarManifest();
      tractsGeo = await fetchJson(`${DATA_DIR}/neighborhoods.geojson`);
      tractsScalars = await attachScalars(tractsGeo?.features || []);
      if (baseUnitRadios.length) {
        const derivedRadio = baseUnitRadios.find((r) => r.value === "derived");
        if (derivedRadio) {
          const ok = await checkDerivedAvailable();
          derivedRadio.disabled = !ok;
          if (!ok && derivedRadio.checked) {
            const fallback = baseUnitRadios.find((r) => r.value === "tract");
            if (fallback) fallback.checked = true;
            localStorage.setItem("atlas.baseUnit", "tract");
            showError("Derived data missing. Run ./buildonly.sh to generate derived files.");
          }
        }
      }
      await applyBaseUnit();
      await loadMatrix(getProfile());
      render();
      setupCentralityUi();
      setupJudgeUi();
      setupLivingUi();
      setupCartogramUi();
      setupViewsUi();
    } catch (err) {
      setStatus("Error loading data");
      showError(err?.message || "Failed to load map data. Run ./buildonly.sh and refresh.");
    }
  };

  for (const r of profileRadios) {
    r.addEventListener("change", async () => {
      savePrefs();
      clearError();
      try {
        await applyBaseUnit();
        await loadMatrix(getProfile());
        render();
        setupCentralityUi();
        setupJudgeUi();
        setupLivingUi();
        setupCartogramUi();
        setupViewsUi();
      } catch (err) {
        setStatus("Error loading data");
        showError(err?.message || "Failed to load map data. Run ./buildonly.sh and refresh.");
      }
    });
  }

  maxMinutesEl.addEventListener("input", () => {
    syncMaxLabel();
    if (getViewMode() === "living") applyLivingMetric();
    restyle();
    if (getViewMode() === "living") renderLabels();
    updateListsAndDirections();
  });

  for (const r of baseUnitRadios) {
    r.addEventListener("change", async () => {
      savePrefs();
      clearError();
      try {
        await applyBaseUnit();
        await loadMatrix(getProfile());
        render();
        setupCentralityUi();
        setupJudgeUi();
        setupLivingUi();
        setupCartogramUi();
        setupViewsUi();
      } catch (err) {
        setStatus("Error loading data");
        showError(err?.message || "Failed to load map data. Run ./buildonly.sh and refresh.");
      }
    });
  }

  viewModeEl?.addEventListener("change", () => {
    originId = null;
    hoveredDestId = null;
    pinnedDestId = null;
    originStopIndex = null;
    destStopIndex = null;
    lastRun = null;
    clearOverlay();
    restyle();
    updateListsAndDirections();
  });

  compactNamesEl?.addEventListener("change", () => {
    savePrefs();
    renderLabels();
    updateListsAndDirections();
  });

  window.addEventListener("resize", () => {
    scheduleLabelsRerender?.();
  });

  syncMaxLabel();
  await init();
}

main().catch((err) => {
  console.error(err);
  alert(err?.message || String(err));
});
