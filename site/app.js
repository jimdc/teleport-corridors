const DATA_DIR = "./data";
const ISOCHRONE_MINUTES = [15, 30, 45, 60, 90, 120, 150, 180];
const HUE_BY_LINE_ALWAYS_ON = true;
const ISOCHRONES_ALWAYS_ON = true;
const TELEPORT_EXPECTED_SPEED_KM_PER_MIN = 0.25; // ~15 km/h baseline for "minutes saved"
const WALK_SPEED_M_PER_MIN = 80; // ~4.8 km/h
const LINE_DIVERSITY_RADIUS_M = 650;

const LIVING_COLORS = {
  teleportness: { r: 16, g: 185, b: 129 }, // emerald
  walk: { r: 59, g: 130, b: 246 }, // blue
  lines: { r: 245, g: 158, b: 11 }, // amber
};

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

function formatRow(name, mins) {
  if (mins == null) return `${name} — unreachable`;
  return `${name} — ${mins} min`;
}

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return await res.json();
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

function renderNameWithBorough(el, name, boroughName) {
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
  renderNameWithBorough(originNameEl, fmt(origin.name || origin.id), origin.borough);

  const rows = neighborhoods.map((n, idx) => ({
    idx,
    name: fmt(n.name || n.id),
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

function renderGeojson(svg, geojson, onClickFeature) {
  svg.replaceChildren();

  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const gPolys = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gIsochrones = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gOverlay = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gOverlayRoutes = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gOverlayStops = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gLivingNodes = document.createElementNS("http://www.w3.org/2000/svg", "g");
  // Overlays should never block neighborhood clicks/drags.
  gIsochrones.setAttribute("pointer-events", "none");
  gOverlay.setAttribute("pointer-events", "none");
  gOverlayRoutes.setAttribute("pointer-events", "none");
  gOverlayStops.setAttribute("pointer-events", "none");
  gLivingNodes.setAttribute("pointer-events", "none");
  gOverlay.appendChild(gOverlayRoutes);
  gOverlay.appendChild(gOverlayStops);
  gOverlay.appendChild(gLivingNodes);
  svg.appendChild(gPolys);
  svg.appendChild(gIsochrones);
  svg.appendChild(gOverlay);

  const bounds = computeProjectedBounds(geojson);
  const padX = (bounds.maxX - bounds.minX) * 0.03;
  const padY = (bounds.maxY - bounds.minY) * 0.03;
  const vb = {
    x: bounds.minX - padX,
    y: bounds.minY - padY,
    w: (bounds.maxX - bounds.minX) + 2 * padX,
    h: (bounds.maxY - bounds.minY) + 2 * padY,
  };
  setSvgViewBox(svg, vb);

  const pathById = new Map();

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

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = String(featureName(props));
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

  return { pathById, gIsochrones, gOverlayRoutes, gOverlayStops, gLivingNodes, initialViewBox: vb };
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
  const viewModeEl = document.getElementById("viewMode");
  const profileRadios = Array.from(document.querySelectorAll('input[name="profile"]'));
  const maxMinutesEl = document.getElementById("maxMinutes");
  const maxMinutesLabelEl = document.getElementById("maxMinutesLabel");
  const legendMaxEl = document.getElementById("legendMax");
  const compactNamesEl = document.getElementById("compactNames");
  const svg = document.getElementById("mapSvg");
  const leadersSvg = document.getElementById("labelLeaders");
  const labelRailLeftEl = document.getElementById("labelRailLeft");
  const labelRailRightEl = document.getElementById("labelRailRight");

  const getProfile = () => {
    const checked = profileRadios.find((r) => r.checked);
    return checked?.value || "weekday_am";
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
  };

  const savePrefs = () => {
    if (compactNamesEl) localStorage.setItem("atlas.compactNames", compactNamesEl.checked ? "1" : "0");
    if (profileRadios.length) localStorage.setItem("atlas.profile", getProfile());
  };

  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };

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

  const neighborhoodsGeo = await fetchJson(`${DATA_DIR}/neighborhoods.geojson`);
  const triFeatures = (neighborhoodsGeo?.features || []).filter((f) => isTriBorough(getBorough(f?.properties || {})));
  const visibleGeo =
    triFeatures.length > 0
      ? { type: "FeatureCollection", features: triFeatures }
      : neighborhoodsGeo;
  const visibleIds = new Set(
    (visibleGeo?.features || [])
      .map((f) => String((f?.properties || {}).atlas_id || ""))
      .filter(Boolean),
  );

  let neighborhoods = [];
  let routes = [];
  let stops = [];
  let edges = [];
  let adjacency = [];
  let minutesMatrix = null; // neighborhood x neighborhood minutes (filtered to visible set)
  let matrixRoutes = []; // routes referenced by matrix.first_route (filtered)
  let firstRouteMatrix = null; // neighborhood x neighborhood first-route indices (filtered)
  let centralityConfig = null; // matrix centrality payload (filtered)
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

  // Living mode: map-level metrics aimed at “underrated to live in”.
  let livingMetricKey = "teleportness"; // teleportness | walk | lines
  let livingHubId = null;
  let livingHubLabel = "Midtown";
  let livingExcludeShortTrips = true;
  let livingColorKey = "teleportness";
  let livingRawHigherIsBetter = true;
  let livingLabel = "Teleportness";
  let livingById = new Map(); // oriented so "higher is better"
  let livingRawById = new Map(); // raw values (minutes saved, walk minutes, line count)
  let livingDetailsById = new Map(); // id -> object with metric-specific details
  let livingStats = { min: 0, max: 1 };
  let livingRawStats = { min: 0, max: 1 };
  let livingWalkMinutesById = new Map();
  let livingWalkMetersById = new Map();
  let livingWalkStopNameById = new Map();
  let livingLineCountById = new Map();
  let livingLinesById = new Map(); // id -> Array<string>

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
    const base = parts.slice(0, 2).join(" / ");

    const replacements = [
      [/\bUpper West Side\b/gi, "UWS"],
      [/\bUpper East Side\b/gi, "UES"],
      [/\bLower East Side\b/gi, "LES"],
      [/\bEast Village\b/gi, "EV"],
      [/\bWest Village\b/gi, "WV"],
      [/\bGreenwich Village\b/gi, "GV"],
      [/\bHell's Kitchen\b/gi, "HK"],
      [/\bFinancial District\b/gi, "FiDi"],
      [/\bLong Island City\b/gi, "LIC"],
      [/\bBedford[- ]Stuyvesant\b/gi, "Bed-Stuy"],
      [/\bWilliamsburg\b/gi, "W'burg"],
      [/\bCrown Heights\b/gi, "Crown Hts"],
      [/\bWashington Heights\b/gi, "Wash Hts"],
      [/\bMorningside Heights\b/gi, "Morningside"],
      [/\bProspect Lefferts Gardens\b/gi, "PLG"],
      [/\bJohn F\\. Kennedy International Airport\b/gi, "JFK"],
      [/\bInternational Airport\b/gi, "Intl"],
      [/\bTimes Square\b/gi, "TSQ"],
    ];
    let out = base;
    for (const [re, sub] of replacements) out = out.replace(re, sub);

    out = out
      .replace(/\bHeights\b/gi, "Hts")
      .replace(/\bPark\b/gi, "Pk")
      .replace(/\bGardens\b/gi, "Gdns")
      .replace(/\bVillage\b/gi, "Vlg")
      .replace(/\bJunction\b/gi, "Jct");

    out = out
      .replace(/\bNorth\b/gi, "N")
      .replace(/\bSouth\b/gi, "S")
      .replace(/\bEast\b/gi, "E")
      .replace(/\bWest\b/gi, "W");

    const maxLen = 20;
    if (out.length > maxLen) out = `${out.slice(0, maxLen - 1)}…`;
    return out;
  };

  const displayName = (raw) => (isCompactNames() ? shortenName(raw) : String(raw || ""));

  const loadMatrix = async (profile) => {
    const [graph, matrix] = await Promise.all([
      fetchJson(`${DATA_DIR}/graph_${profile}.json`),
      fetchJson(`${DATA_DIR}/matrix_${profile}.json`),
    ]);
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

    computeLivingStaticMetrics();
  };

  const nbById = () => new Map(neighborhoods.map((n) => [String(n.id), n]));

  const indexById = () => new Map(neighborhoods.map((n, i) => [String(n.id), i]));

  function computeLivingStaticMetrics() {
    livingWalkMinutesById = new Map();
    livingWalkMetersById = new Map();
    livingWalkStopNameById = new Map();
    livingLineCountById = new Map();
    livingLinesById = new Map();

    if (!neighborhoods.length || !stops.length) return;

    const routeLabels = routes.map((r) => String(r?.short_name || r?.id || ""));
    const linesAtStop = new Array(stops.length).fill(0).map(() => new Set());

    for (const e of edges) {
      const [from, to, minutes, routeIdx] = e;
      if (minutes == null) continue;
      if (routeIdx == null) continue;
      const label = routeLabels[routeIdx] || null;
      if (!label) continue;
      if (from != null && from >= 0 && from < linesAtStop.length) linesAtStop[from].add(label);
      if (to != null && to >= 0 && to < linesAtStop.length) linesAtStop[to].add(label);
    }

    for (const n of neighborhoods) {
      const id = String(n.id);
      const c = n?.centroid;
      if (!Array.isArray(c) || c.length < 2) continue;
      const lat = Number(c[0]);
      const lon = Number(c[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const si = n?.stop_index;
      if (si != null && si >= 0 && si < stops.length) {
        const st = stops[si];
        const dM = haversineKm([lat, lon], [Number(st.lat), Number(st.lon)]) * 1000;
        if (Number.isFinite(dM)) {
          livingWalkMetersById.set(id, Math.round(dM));
          livingWalkMinutesById.set(id, Math.round((dM / WALK_SPEED_M_PER_MIN) * 10) / 10);
          livingWalkStopNameById.set(id, String(st.name || st.id || ""));
        }
      }

      const lines = new Set();
      for (let s = 0; s < stops.length; s++) {
        const st = stops[s];
        const dM = haversineKm([lat, lon], [Number(st.lat), Number(st.lon)]) * 1000;
        if (!Number.isFinite(dM)) continue;
        if (dM > LINE_DIVERSITY_RADIUS_M) continue;
        for (const l of linesAtStop[s]) lines.add(l);
      }
      const lineList = Array.from(lines).filter(Boolean).sort((a, b) => a.localeCompare(b));
      livingLinesById.set(id, lineList);
      livingLineCountById.set(id, lineList.length);
    }
  }

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
  let hubCentralityHubId = null;
  let hubCentralityHubLabel = "Midtown";

  const presetHubs = [
    { key: "midtown", label: "Midtown", lat: 40.754, lon: -73.984 },
    { key: "downtown", label: "Downtown", lat: 40.707, lon: -74.011 },
    { key: "williamsburg", label: "Williamsburg", lat: 40.711, lon: -73.958 },
    { key: "downtown_bk", label: "Downtown BK", lat: 40.692, lon: -73.985 },
    { key: "lic", label: "LIC", lat: 40.744, lon: -73.949 },
    { key: "hudson_yards", label: "Hudson Yards", lat: 40.754, lon: -74.002 },
    { key: "greenpoint", label: "Greenpoint", lat: 40.729, lon: -73.955 },
    { key: "bushwick", label: "Bushwick", lat: 40.695, lon: -73.918 },
    { key: "astoria", label: "Astoria", lat: 40.764, lon: -73.923 },
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
    if (!isCentralityPage) return;
    const metricRadios = Array.from(document.querySelectorAll('input[name="centralityMetric"]'));
    const hubPresetRadios = Array.from(document.querySelectorAll('input[name="centralityHubPreset"]'));
    const hubControlsEl = document.getElementById("hubControls");
    const hubNameEl = document.getElementById("centralityHubName");
    const hubCustomEl = document.getElementById("centralityHubCustom");

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
    centralityPresetIdByKey = new Map();
    for (const h of presetHubs) {
      const id = nearestNeighborhoodId(h.lat, h.lon);
      if (id) centralityPresetIdByKey.set(h.key, id);
    }

    const loadUiPrefs = () => {
      const metric = localStorage.getItem("atlas.centralityMetric") || "hub";
      const m = metricRadios.find((r) => r.value === metric);
      if (m) m.checked = true;

      const preset = localStorage.getItem("atlas.centralityHubPreset") || "midtown";
      const p = hubPresetRadios.find((r) => r.value === preset);
      if (p) p.checked = true;

      const custom = localStorage.getItem("atlas.centralityHubCustom") || "";
      if (hubCustomEl) hubCustomEl.value = custom;
    };

    centralityApplyUi = () => {
      const metric = metricRadios.find((r) => r.checked)?.value || "hub";
      if (hubControlsEl) hubControlsEl.hidden = metric !== "hub";

      if (metric === "hub") {
        const presetKey = hubPresetRadios.find((r) => r.checked)?.value || "midtown";
        const presetMeta = presetHubs.find((h) => h.key === presetKey);
        const presetId = centralityPresetIdByKey.get(presetKey) || null;
        const customId = hubCustomEl?.value ? String(hubCustomEl.value) : "";
        const useId = customId || presetId || null;
        const useLabel = customId
          ? (nbById().get(customId)?.name || customId)
          : presetMeta?.label || presetKey;

        hubCentralityHubId = useId;
        hubCentralityHubLabel = String(useLabel || "");
        if (hubNameEl) hubNameEl.textContent = hubCentralityHubLabel;
        applyHubCentrality();
      } else {
        const metricKey = metric;
        const mm = centralityConfig?.metrics?.[metricKey];
        const scores = Array.isArray(mm?.scores) ? mm.scores : [];
        setCentralityFromScores({
          label: mm?.label || metricKey,
          higherIsBetter: !!mm?.higher_is_better,
          scoresByIndex: scores,
        });
      }

      restyle();
      renderLabels();
      renderCentralityPanel();
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
          centralityApplyUi();
        });
      }
      hubCustomEl?.addEventListener("change", () => {
        localStorage.setItem("atlas.centralityHubCustom", hubCustomEl.value || "");
        centralityApplyUi();
      });
    }
  };

  const formatSignedMinutes = (v) => {
    if (v == null || !Number.isFinite(v)) return "—";
    const sign = v >= 0 ? "+" : "−";
    return `${sign}${Math.abs(v).toFixed(1)} min`;
  };

  const applyLivingMetric = () => {
    const rawScores = new Array(neighborhoods.length).fill(null);
    const details = new Map();

    if (livingMetricKey === "walk") {
      for (let i = 0; i < neighborhoods.length; i++) {
        const id = String(neighborhoods[i].id);
        const m = livingWalkMinutesById.get(id);
        if (m == null || !Number.isFinite(m)) continue;
        rawScores[i] = m;
        details.set(id, {
          metric: "walk",
          walk_minutes: m,
          walk_meters: livingWalkMetersById.get(id) ?? null,
          stop_name: livingWalkStopNameById.get(id) ?? null,
        });
      }
      setLivingFromRawScores({
        label: "Walk to subway",
        higherIsBetter: false,
        rawScoresByIndex: rawScores,
        colorKey: "walk",
        detailsById: details,
      });
      return;
    }

    if (livingMetricKey === "lines") {
      for (let i = 0; i < neighborhoods.length; i++) {
        const id = String(neighborhoods[i].id);
        const n = livingLineCountById.get(id);
        if (n == null || !Number.isFinite(n)) continue;
        rawScores[i] = n;
        details.set(id, {
          metric: "lines",
          line_count: n,
          lines: livingLinesById.get(id) || [],
        });
      }
      setLivingFromRawScores({
        label: `Lines (≤${LINE_DIVERSITY_RADIUS_M}m)`,
        higherIsBetter: true,
        rawScoresByIndex: rawScores,
        colorKey: "lines",
        detailsById: details,
      });
      return;
    }

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
    const excludeShortEl = document.getElementById("livingExcludeShort");

    if (!metricRadios.length) return;

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
    livingPresetIdByKey = new Map();
    for (const h of presetHubs) {
      const id = nearestNeighborhoodId(h.lat, h.lon);
      if (id) livingPresetIdByKey.set(h.key, id);
    }

    const loadUiPrefs = () => {
      const metric = localStorage.getItem("atlas.livingMetric") || "teleportness";
      const m = metricRadios.find((r) => r.value === metric);
      if (m) m.checked = true;

      const preset = localStorage.getItem("atlas.livingHubPreset") || "midtown";
      const p = hubPresetRadios.find((r) => r.value === preset);
      if (p) p.checked = true;

      const custom = localStorage.getItem("atlas.livingHubCustom") || "";
      if (hubCustomEl) hubCustomEl.value = custom;

      const ex = localStorage.getItem("atlas.livingExcludeShort");
      if (excludeShortEl) excludeShortEl.checked = ex == null ? true : ex === "1";
    };

    livingApplyUi = () => {
      livingMetricKey = metricRadios.find((r) => r.checked)?.value || "teleportness";
      if (hubControlsEl) hubControlsEl.hidden = livingMetricKey !== "teleportness";

      if (livingMetricKey === "teleportness") {
        const presetKey = hubPresetRadios.find((r) => r.checked)?.value || "midtown";
        const presetMeta = presetHubs.find((h) => h.key === presetKey);
        const presetId = livingPresetIdByKey.get(presetKey) || null;
        const customId = hubCustomEl?.value ? String(hubCustomEl.value) : "";
        const useId = customId || presetId || null;
        const useLabel = customId
          ? (nbById().get(customId)?.name || customId)
          : presetMeta?.label || presetKey;

        livingHubId = useId;
        livingHubLabel = String(useLabel || "");
        if (hubNameEl) hubNameEl.textContent = livingHubLabel;
        livingExcludeShortTrips = !!excludeShortEl?.checked;
      }

      applyLivingMetric();
      restyle();
      renderLabels();
      renderLivingPanel();
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
          livingApplyUi();
        });
      }

      hubCustomEl?.addEventListener("change", () => {
        localStorage.setItem("atlas.livingHubCustom", hubCustomEl.value || "");
        livingApplyUi();
      });

      excludeShortEl?.addEventListener("change", () => {
        localStorage.setItem("atlas.livingExcludeShort", excludeShortEl.checked ? "1" : "0");
        livingApplyUi();
      });
    }
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
    if ((viewModeEl?.value || "time") !== "time") return;

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
    if ((viewModeEl?.value || "time") !== "living") return;

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
      dot.setAttribute("fill", `rgba(${rgb.r},${rgb.g},${rgb.b},0.86)`);
      dot.setAttribute("stroke", "rgba(255,255,255,0.92)");
      dot.setAttribute("stroke-width", "1.1");
      dot.setAttribute("vector-effect", "non-scaling-stroke");
      frag.appendChild(dot);
    }

    // Hub marker for teleportness.
    if (livingMetricKey === "teleportness" && livingHubId) {
      const hubNb = nbById().get(String(livingHubId));
      const c = hubNb?.centroid;
      if (Array.isArray(c) && c.length >= 2) {
        const [x, y] = projectLonLat([Number(c[1]), Number(c[0])]);
        const hub = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        hub.setAttribute("cx", String(x));
        hub.setAttribute("cy", String(y));
        hub.setAttribute("r", String(r0 + r1 * 0.9));
        hub.setAttribute("fill", "rgba(255,255,255,0.96)");
        hub.setAttribute("stroke", "rgba(2,6,23,0.85)");
        hub.setAttribute("stroke-width", "1.6");
        hub.setAttribute("vector-effect", "non-scaling-stroke");
        frag.appendChild(hub);
      }
    }

    g.appendChild(frag);
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
    const mode = viewModeEl?.value || "time";
    const origin = originId;
    const activeDestId = pinnedDestId != null ? pinnedDestId : hoveredDestId;
    const maxMinutes = getMaxMinutes();
    const hueByLine = HUE_BY_LINE_ALWAYS_ON;
    const hasOrigin = originId != null && lastRun != null;
    const livingRgb = LIVING_COLORS[livingColorKey] || LIVING_COLORS.teleportness;

    for (const [id, path] of svgIndex.pathById.entries()) {
      const mins = minsFromOriginToId(id);
      const score = centralityById.get(String(id));
      const livingScore = livingById.get(String(id));
      const { fill, fillOpacity } =
        mode === "centrality"
          ? centralityToFill(score, centralityStats.min, centralityStats.max)
          : mode === "living"
            ? livingToFill(livingScore, livingStats.min, livingStats.max, livingRgb)
          : !hasOrigin
            ? { fill: "rgba(0,0,0,0)", fillOpacity: 1 }
            : hueByLine
              ? minutesToFillHue(mins, maxMinutes, firstRouteForId(id)?.color)
              : minutesToFill(mins, maxMinutes);
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
              : boroughStrokeForId(id),
      );
      path.setAttribute("stroke-opacity", isOrigin || isDest || isHub ? "1" : "0.85");
      path.setAttribute("stroke-width", isOrigin || isDest || isHub ? "2" : "1.2");
    }

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
    clearLivingNodes();
    renderIsochrones();
    if (destStopIndex != null) drawRouteToDest();
    else if (originStopIndex != null) drawSpreadFromOrigin();
    else clearOverlay();
  };

  const onClickFeature = (id, event = null) => {
    const nb = nbById().get(String(id));
    if (!nb) return;
    const mode = viewModeEl?.value || "time";
    if (mode === "centrality") return;

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

  onClickFeature.onHover = (id) => {
    const mode = viewModeEl?.value || "time";
    if (mode === "centrality") {
      const nb = nbById().get(String(id));
      const destNameEl = document.getElementById("destName");
      const routeSummaryEl = document.getElementById("routeSummary");
      const routeStepsEl = document.getElementById("routeSteps");
      renderNameWithBorough(destNameEl, displayName(nb?.name || String(id)), nb?.borough);
      routeSummaryEl.textContent = `${centralityLabel}: ${formatCentralityValue(id)}`;
      setList(routeStepsEl, []);
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
    const mode = viewModeEl?.value || "time";
    if (mode === "centrality") {
      const destNameEl = document.getElementById("destName");
      const routeSummaryEl = document.getElementById("routeSummary");
      const routeStepsEl = document.getElementById("routeSteps");
      destNameEl.replaceChildren(document.createTextNode("Hover a neighborhood"));
      routeSummaryEl.textContent = "";
      setList(routeStepsEl, []);
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

  const render = () => {
    svgIndex = renderGeojson(svg, visibleGeo, onClickFeature);
    initialViewBox = svgIndex?.initialViewBox ? { ...svgIndex.initialViewBox } : null;
    if (initialViewBox) {
      svg.__atlasInitialViewBox = { ...initialViewBox };
      setSvgViewBox(svg, { ...initialViewBox });
    }
    originId = null;
    hoveredDestId = null;
    pinnedDestId = null;
    originStopIndex = null;
    destStopIndex = null;
    lastRun = null;
    restyle();
    updateListsAndDirections();
    setStatus(`ready (${svgIndex.pathById.size} neighborhoods)`);
    renderLabels();
  };

  const renderLabels = () => {
    if (!labelRailLeftEl || !labelRailRightEl || !leadersSvg) return;
    labelRailLeftEl.replaceChildren();
    labelRailRightEl.replaceChildren();
    leadersSvg.replaceChildren();

    const vb = readViewBox(svg);
    if (!vb) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const worldToScreen = (x, y) => ({
      x: ((x - vb.x) / vb.w) * rect.width,
      y: ((y - vb.y) / vb.h) * rect.height,
    });

    const hasOrigin = originId != null && lastRun != null;
    const maxMinutes = getMaxMinutes();
    const mode = viewModeEl?.value || "time";

    const candidates = [];
    for (const n of neighborhoods) {
      const c = n?.centroid;
      const name = n?.name;
      if (!c || !name) continue;
      const [lat, lon] = c;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const [x, y] = projectLonLat([lon, lat]);
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

    // Choose labels: teleports by default when an origin is selected.
    let chosen = [];
    if (hasOrigin) {
      const originNb = nbById().get(String(originId));
      const oc = originNb?.centroid;
      const originCandidate = candidates.find((c) => c.id === String(originId));

      const reachable = candidates.filter(
        (c) => c.id !== String(originId) && c.mins != null && c.mins <= maxMinutes && oc && c.centroid,
      );

      const byTime = reachable.slice().sort((a, b) => a.mins - b.mins);
      const timeRank = new Map(byTime.map((c, i) => [c.id, i + 1]));

      const withDist = reachable
        .map((c) => ({ ...c, distKm: haversineKm(oc, c.centroid) }))
        .sort((a, b) => b.distKm - a.distKm);
      const distRank = new Map(withDist.map((c, i) => [c.id, i + 1]));

      const teleports = withDist
        .map((c) => ({
          ...c,
          teleport: (distRank.get(c.id) || 0) - (timeRank.get(c.id) || 0),
        }))
        .sort((a, b) => b.teleport - a.teleport);

      if (originCandidate) chosen.push(originCandidate);
      chosen.push(...teleports.slice(0, 23));

      // Backfill with closest-by-time if we don't have enough.
      if (chosen.length < 24) {
        const have = new Set(chosen.map((c) => c.id));
        for (const c of byTime) {
          if (chosen.length >= 24) break;
          if (have.has(c.id)) continue;
          chosen.push(c);
          have.add(c.id);
        }
      }
    } else {
      const key = mode === "living" ? "living" : "centrality";
      chosen = candidates
        .slice()
        .sort((a, b) => (b[key] || 0) - (a[key] || 0))
        .slice(0, 24);
    }

    const left = [];
    const right = [];
    for (const c of chosen) (c.sx < rect.width * 0.5 ? left : right).push(c);

    const railWidth = 220;
    const padTop = 10;
    const padBottom = 10;
    const usableH = Math.max(0, rect.height - padTop - padBottom);
    const minGap = 16;
    const maxPerSide = 12;

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
    const activeId = hoveredRailId || hoveredDestId || null;

    const mkLabel = (c, yPx) => {
      const d = document.createElement("div");
      d.className = "rail-label";
      d.style.top = `${Math.round(yPx - 8)}px`;
      d.textContent = displayName(c.name);
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
    const mode = viewModeEl?.value || "time";
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

    const fmtNum = (v) => (v == null || !Number.isFinite(v) ? "—" : String(v));

    if (livingMetricKey === "teleportness") {
      if (hintEl) {
        hintEl.textContent = `“Minutes saved” vs a baseline speed to ${livingHubLabel || "the hub"}. Higher = more “teleport-y”.`;
      }
      if (topTitleEl) topTitleEl.textContent = `Most teleport-y to ${livingHubLabel || "hub"}`;
      if (botTitleEl) botTitleEl.textContent = `Least teleport-y to ${livingHubLabel || "hub"}`;
      if (legendLeftEl) legendLeftEl.textContent = formatSignedMinutes(livingRawStats.min);
      if (legendRightEl) legendRightEl.textContent = formatSignedMinutes(livingRawStats.max);
    } else if (livingMetricKey === "walk") {
      if (hintEl) hintEl.textContent = "Minutes to walk from the neighborhood centroid to its nearest subway stop. Shorter is better.";
      if (topTitleEl) topTitleEl.textContent = "Shortest walk to subway";
      if (botTitleEl) botTitleEl.textContent = "Longest walk to subway";
      // More color = shorter walk (inverted raw).
      if (legendLeftEl) legendLeftEl.textContent = `${fmtNum(livingRawStats.max)} min`;
      if (legendRightEl) legendRightEl.textContent = `${fmtNum(livingRawStats.min)} min`;
    } else if (livingMetricKey === "lines") {
      if (hintEl) hintEl.textContent = `Unique subway lines within ~${LINE_DIVERSITY_RADIUS_M}m walk. More lines = more options.`;
      if (topTitleEl) topTitleEl.textContent = "Most line diversity";
      if (botTitleEl) botTitleEl.textContent = "Least line diversity";
      if (legendLeftEl) legendLeftEl.textContent = `${fmtNum(livingRawStats.min)} lines`;
      if (legendRightEl) legendRightEl.textContent = `${fmtNum(livingRawStats.max)} lines`;
    }

    const rows = neighborhoods
      .map((n) => {
        const id = String(n.id);
        return {
          id,
          name: displayName(n.name || n.id),
          sort: livingById.get(id),
          raw: livingRawById.get(id),
        };
      })
      .filter((r) => Number.isFinite(r.sort) && Number.isFinite(r.raw));
    rows.sort((a, b) => b.sort - a.sort);

    const fmtRow = (r) => {
      const d = livingDetailsById.get(String(r.id)) || {};
      if (livingMetricKey === "teleportness") {
        const line = d.first_line ? ` · ${d.first_line}` : "";
        return `${r.name} — ${formatSignedMinutes(Number(r.raw))} saved · ${d.minutes ?? "—"} min${line}`;
      }
      if (livingMetricKey === "walk") {
        const stop = d.stop_name ? ` · ${d.stop_name}` : "";
        return `${r.name} — ${Number(r.raw).toFixed(1)} min${stop}`;
      }
      if (livingMetricKey === "lines") {
        return `${r.name} — ${Math.round(Number(r.raw))} lines`;
      }
      return `${r.name} — ${r.raw}`;
    };

    setList(topEl, rows.slice(0, 10).map(fmtRow));
    setList(botEl, rows.slice(-10).reverse().map(fmtRow));

    const activeId = pinnedDestId != null ? pinnedDestId : hoveredDestId;
    if (!activeId) {
      hoverNameEl.replaceChildren(document.createTextNode("Hover a neighborhood"));
      hoverMetaEl.textContent = "";
      hoverExtraEl.textContent = "";
      return;
    }

    const nb = nbById().get(String(activeId));
    renderNameWithBorough(hoverNameEl, displayName(nb?.name || activeId), nb?.borough);

    const d = livingDetailsById.get(String(activeId)) || null;
    if (!d) {
      hoverMetaEl.textContent = "—";
      hoverExtraEl.textContent = "";
      return;
    }

    if (d.metric === "teleportness") {
      const line = d.first_line ? ` · ${d.first_line}` : "";
      hoverMetaEl.textContent = `${d.minutes} min · ${d.distance_km} km · ${formatSignedMinutes(d.minutes_saved)} saved${line}`;
      hoverExtraEl.textContent = `expected ${d.expected_minutes} min`;
      return;
    }

    if (d.metric === "walk") {
      const meters = d.walk_meters != null ? ` · ${d.walk_meters} m` : "";
      hoverMetaEl.textContent = `${Number(d.walk_minutes).toFixed(1)} min walk${meters}`;
      hoverExtraEl.textContent = d.stop_name ? `to ${d.stop_name}` : "";
      return;
    }

    if (d.metric === "lines") {
      hoverMetaEl.textContent = `${Math.round(Number(d.line_count))} lines within ${LINE_DIVERSITY_RADIUS_M} m`;
      hoverExtraEl.textContent = (Array.isArray(d.lines) ? d.lines : []).join(" ");
    }
  };

  const renderCentralityPanel = () => {
    const panel = document.getElementById("centralityPanel");
    const topEl = document.getElementById("centralTop");
    const botEl = document.getElementById("centralBottom");
    if (!panel || !topEl || !botEl) return;

    const mode = viewModeEl?.value || "time";
    panel.hidden = mode !== "centrality";
    if (mode !== "centrality") return;

    const rows = neighborhoods
      .map((n) => ({
        id: String(n.id),
        name: displayName(n.name || n.id),
        sort: centralityById.get(String(n.id)),
        raw: centralityRawById.get(String(n.id)),
      }))
      .filter((r) => Number.isFinite(r.sort) && Number.isFinite(r.raw));
    rows.sort((a, b) => b.sort - a.sort);

    const fmt = (r) => `${r.name} — ${formatCentralityValue(r.id)}`;
    setList(topEl, rows.slice(0, 10).map(fmt));
    setList(botEl, rows.slice(-10).reverse().map(fmt));
  };

  const updateListsAndDirections = () => {
    const mode = viewModeEl?.value || "time";
    if (mode === "centrality") {
      renderCentralityPanel();
      return;
    }
    if (mode === "living") {
      renderLivingPanel();
      return;
    }
    if (!originId || !lastRun) {
      updatePanel({ originIndex: null, neighborhoods: [], minutesRow: [], routeRow: [], routes: [], nameFn: displayName });
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
      return;
    }

    const destNb = nbById().get(String(activeDestId));
    renderNameWithBorough(destNameEl, displayName(destNb?.name || activeDestId), destNb?.borough);

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
  };

  const init = async () => {
    await loadMatrix(getProfile());
    render();
    setupCentralityUi();
    setupLivingUi();
  };

  for (const r of profileRadios) {
    r.addEventListener("change", async () => {
      savePrefs();
      await loadMatrix(getProfile());
      render();
      setupCentralityUi();
      setupLivingUi();
    });
  }

  maxMinutesEl.addEventListener("input", () => {
    syncMaxLabel();
    if ((viewModeEl?.value || "time") === "living") applyLivingMetric();
    restyle();
    if ((viewModeEl?.value || "time") === "living") renderLabels();
    updateListsAndDirections();
  });

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
