const DATA_DIR = "./data";
let reportError = (msg) => console.error(msg);

function setReportError(fn) {
  if (typeof fn === "function") reportError = fn;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function readViewBox(svg) {
  const raw = svg?.getAttribute?.("viewBox");
  if (!raw) return null;
  const parts = raw.split(/\s+/).map((v) => Number(v));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = parts;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function mercatorY(latDeg) {
  const lat = (Math.max(-85, Math.min(85, latDeg)) * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + lat / 2));
}

function projectLonLat([lon, lat]) {
  const x = (lon * Math.PI) / 180;
  const y = -mercatorY(lat);
  return [x, y];
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

  if (t === "Polygon") return c.map(ringToD).join("");
  if (t === "MultiPolygon") return c.map((poly) => poly.map(ringToD).join("")).join("");
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
  return { minX, minY, maxX, maxY };
}

function centroidLatLon(geometry) {
  if (!geometry) return null;
  const pts = [];
  for (const ll of iterLonLatCoords(geometry)) {
    pts.push([ll[1], ll[0]]); // lat, lon
  }
  if (!pts.length) return null;
  let lat = 0;
  let lon = 0;
  for (const p of pts) {
    lat += p[0];
    lon += p[1];
  }
  return [lat / pts.length, lon / pts.length];
}

function getBorough(props) {
  if (!props) return "";
  const v =
    props.boroname ||
    props.BoroName ||
    props.boro_name ||
    props.borough ||
    props.Borough ||
    "";
  return String(v || "").trim();
}

function boroughKeyFromName(name) {
  const b = String(name || "").trim().toLowerCase();
  if (b === "manhattan") return "manhattan";
  if (b === "brooklyn") return "brooklyn";
  if (b === "queens") return "queens";
  return null;
}

function getProfile() {
  const radios = Array.from(document.querySelectorAll('input[name="profile"]'));
  return radios.find((r) => r.checked)?.value || "weekday_am";
}

function getBaseUnit() {
  const radios = Array.from(document.querySelectorAll('input[name="baseUnit"]'));
  return radios.find((r) => r.checked)?.value || "tract";
}

function getHub() {
  const radios = Array.from(document.querySelectorAll('input[name="hub"]'));
  return radios.find((r) => r.checked)?.value || "midtown";
}

function getSpokeMode() {
  const radios = Array.from(document.querySelectorAll('input[name="spokeMode"]'));
  return radios.find((r) => r.checked)?.value || "top";
}

function loadNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function kmToProjectedDeltaLon(km, latDeg) {
  return km / (111.32 * Math.cos((latDeg * Math.PI) / 180));
}

function kMeans2D(points, k, iterations = 18) {
  if (!points.length) return { assignments: [], centers: [] };
  const kk = Math.max(1, Math.min(k, points.length));
  // Deterministic-ish init: take evenly spaced points by x.
  const sorted = points.slice().sort((a, b) => a.x - b.x);
  const centers = [];
  for (let i = 0; i < kk; i++) {
    centers.push({ x: sorted[Math.floor((i * (sorted.length - 1)) / Math.max(1, kk - 1))].x, y: sorted[Math.floor((i * (sorted.length - 1)) / Math.max(1, kk - 1))].y });
  }
  let assignments = new Array(points.length).fill(0);
  for (let it = 0; it < iterations; it++) {
    let changed = false;
    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const dx = points[i].x - centers[c].x;
        const dy = points[i].y - centers[c].y;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    }
    const sums = centers.map(() => ({ x: 0, y: 0, n: 0 }));
    for (let i = 0; i < points.length; i++) {
      const a = assignments[i];
      sums[a].x += points[i].x;
      sums[a].y += points[i].y;
      sums[a].n += 1;
    }
    for (let c = 0; c < centers.length; c++) {
      if (!sums[c].n) continue;
      centers[c] = { x: sums[c].x / sums[c].n, y: sums[c].y / sums[c].n };
    }
    if (!changed) break;
  }
  return { assignments, centers };
}

function loadPrefs() {
  const p = localStorage.getItem("atlas.profile");
  if (p) {
    const radios = Array.from(document.querySelectorAll('input[name="profile"]'));
    const match = radios.find((r) => r.value === p);
    if (match) match.checked = true;
  }

  const u = localStorage.getItem("atlas.baseUnit") || "derived";
  if (u) {
    const baseRadios = Array.from(document.querySelectorAll('input[name="baseUnit"]'));
    const um = baseRadios.find((r) => r.value === u);
    if (um) um.checked = true;
  }

  const h = localStorage.getItem("atlas.hub");
  if (h) {
    const hubs = Array.from(document.querySelectorAll('input[name="hub"]'));
    const mh = hubs.find((r) => r.value === h);
    if (mh) mh.checked = true;
  }

  const inner = localStorage.getItem("atlas.includeInner");
  const el = document.getElementById("includeInner");
  if (el) el.checked = inner === "1";

  const sm = localStorage.getItem("atlas.spokeMode");
  if (sm) {
    const radios = Array.from(document.querySelectorAll('input[name="spokeMode"]'));
    const m = radios.find((r) => r.value === sm);
    if (m) m.checked = true;
  }
}

function savePrefs() {
  localStorage.setItem("atlas.profile", getProfile());
  localStorage.setItem("atlas.baseUnit", getBaseUnit());
  localStorage.setItem("atlas.hub", getHub());
  const el = document.getElementById("includeInner");
  if (el) localStorage.setItem("atlas.includeInner", el.checked ? "1" : "0");
  localStorage.setItem("atlas.spokeMode", getSpokeMode());
}

function getMaxMinutes() {
  const el = document.getElementById("maxMinutes");
  const v = Number(el?.value || "90");
  return Number.isFinite(v) ? v : 90;
}

function setStatus(text) {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
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

function getMiniMapEls() {
  return {
    container: document.getElementById("miniTriptych"),
    overlay: document.getElementById("miniOverlay"),
    manhattan: document.getElementById("miniManhattan"),
    brooklyn: document.getElementById("miniBrooklyn"),
    queens: document.getElementById("miniQueens"),
    title: document.getElementById("previewTitle"),
    meta: document.getElementById("previewMeta"),
    line: document.getElementById("previewLine"),
  };
}

function boroughKeyFromBoroughName(name) {
  const b = String(name || "").trim().toLowerCase();
  if (b === "manhattan") return "manhattan";
  if (b === "brooklyn") return "brooklyn";
  if (b === "queens") return "queens";
  return null;
}

function boroughAbbrevFromBoroughName(name) {
  const k = boroughKeyFromBoroughName(name);
  if (k === "manhattan") return "M";
  if (k === "brooklyn") return "Bk";
  if (k === "queens") return "Q";
  return "";
}

function mkBoroPill(abbrev, key) {
  const s = document.createElement("span");
  s.className = `boro-pill boro-${key}`;
  s.textContent = abbrev;
  return s;
}

function mkLineChip(text) {
  const s = document.createElement("span");
  s.className = "line-chip mono";
  s.textContent = String(text || "");
  return s;
}

function corridorRow(e) {
  const line = e.first_line ? ` · ${e.first_line}` : "";
  const kmMin = e.km_per_min != null ? `${e.km_per_min.toFixed?.(3) ?? e.km_per_min} km/min` : "—";
  const saved = e.minutes_saved != null ? `${e.minutes_saved} min saved` : "";
  const dist = e.distance_km != null ? `${e.distance_km} km` : "—";
  const mins = e.minutes != null ? `${e.minutes} min` : "—";

  const top = document.createElement("div");
  top.className = "corridor-top";
  // Dest is the currently-selected hub; avoid showing "undefined" if the payload doesn't include hub name.
  top.textContent = `${e.origin_name}${line}`;

  const meta = document.createElement("div");
  meta.className = "corridor-meta mono";
  const parts = [mins, dist, kmMin, saved].filter(Boolean);
  meta.appendChild(document.createTextNode(parts.join(" · ")));

  const ok = boroughKeyFromBoroughName(e.origin_borough);
  const hk = boroughKeyFromBoroughName(e.hub_borough);
  const oa = boroughAbbrevFromBoroughName(e.origin_borough);
  const ha = boroughAbbrevFromBoroughName(e.hub_borough);
  if (ok && hk && oa && ha) {
    meta.appendChild(document.createTextNode(" · "));
    const pair = document.createElement("span");
    pair.className = "boro-pair";
    pair.appendChild(mkBoroPill(oa, ok));
    if (e.first_line) {
      pair.appendChild(mkLineChip(e.first_line));
    }
    pair.appendChild(document.createTextNode("→"));
    pair.appendChild(mkBoroPill(ha, hk));
    meta.appendChild(pair);
  }

  const row = document.createElement("div");
  row.className = "corridor-row";
  row.dataset.originId = e.origin_id || "";
  row.dataset.destId = e.hub_id || e.dest_id || "";
  row.dataset.line = e.first_line || "";
  row.dataset.minutes = String(e.minutes ?? "");
  row.dataset.distanceKm = String(e.distance_km ?? "");
  row.dataset.teleport = String(e.minutes_saved ?? "");
  row.dataset.originName = e.origin_name || "";
  row.dataset.destName = e.hub_name || e.dest_name || "";
  row.appendChild(top);
  row.appendChild(meta);
  return row;
}

function renderList(el, entries, maxMinutes, includeInner) {
  el.replaceChildren();
  const filtered = entries.filter((e) => {
    if (e.minutes == null || e.minutes > maxMinutes) return false;
    if (includeInner) return true;
    return e.distance_km == null ? true : e.distance_km >= 6;
  });
  const shown = filtered.slice(0, 60);
  for (const e of shown) el.appendChild(corridorRow(e));

  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "corridor-empty";
    empty.textContent = "No corridors within this cutoff.";
    el.appendChild(empty);
  }
}

async function main() {
  setStatus("Loading…");
  const status = document.getElementById("status");
  const errorBannerEl = document.getElementById("errorBanner");
  const maxEl = document.getElementById("maxMinutes");
  const maxLabel = document.getElementById("maxMinutesLabel");
  const underratedEl = document.getElementById("underrated");
  const speedEl = document.getElementById("speed");
  const mini = getMiniMapEls();
  const hubLabelA = document.getElementById("hubLabelA");
  const hubLabelB = document.getElementById("hubLabelB");

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

  const checkDerivedAvailable = async () => {
    try {
      const res = await fetch(`${DATA_DIR}/derived_regions.geojson`, { method: "HEAD" });
      return res.ok;
    } catch (err) {
      return false;
    }
  };

  loadPrefs();
  const derivedRadio = document.querySelector('input[name="baseUnit"][value="derived"]');
  if (derivedRadio) {
    const ok = await checkDerivedAvailable();
    derivedRadio.disabled = !ok;
    if (!ok && derivedRadio.checked) {
      const fallback = document.querySelector('input[name="baseUnit"][value="tract"]');
      if (fallback) fallback.checked = true;
      localStorage.setItem("atlas.baseUnit", "tract");
      showError("Derived data missing. Run ./buildonly.sh to generate derived files.");
    }
  }
  let unit = getBaseUnit();
  let suffix = unit === "derived" ? "_derived" : "";
  let data;
  let neighborhoodsGeo;
  try {
    [data, neighborhoodsGeo] = await Promise.all([
      fetchJson(`${DATA_DIR}/teleport_corridors${suffix}.json`),
      fetchJson(`${DATA_DIR}/${unit === "derived" ? "derived_regions.geojson" : "neighborhoods.geojson"}`),
    ]);
  } catch (err) {
    if (suffix) {
      // Fallback to tract data if derived artifacts are missing.
      [data, neighborhoodsGeo] = await Promise.all([
        fetchJson(`${DATA_DIR}/teleport_corridors.json`),
        fetchJson(`${DATA_DIR}/neighborhoods.geojson`),
      ]);
      const fallback = document.querySelector('input[name="baseUnit"][value="tract"]');
      if (fallback) fallback.checked = true;
      localStorage.setItem("atlas.baseUnit", "tract");
      unit = "tract";
      suffix = "";
      showError("Derived data missing. Falling back to Tracts. Run ./buildonly.sh to rebuild derived data.");
    } else {
      throw err;
    }
  }
  clearError();
  setStatus("Ready");

  // Triptych mini-map: render MBQ once, then update overlay on hover.
  const pathById = new Map();
  const centroidById = new Map();
  const boroughById = new Map();
  const panelByKey = {
    manhattan: { svg: mini.manhattan, vb: null },
    brooklyn: { svg: mini.brooklyn, vb: null },
    queens: { svg: mini.queens, vb: null },
  };

  const ensureOverlaySized = () => {
    if (!mini.overlay || !mini.container) return;
    const rect = mini.container.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    mini.overlay.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    mini.overlay.setAttribute("preserveAspectRatio", "none");
    mini.overlay.setAttribute("viewBox", `0 0 ${w} ${h}`);
  };

  const projectedToOverlayPx = (projX, projY, boroughKey) => {
    const panel = panelByKey[boroughKey];
    if (!mini.container || !panel?.svg || !panel?.vb) return null;
    const panelRect = panel.svg.getBoundingClientRect();
    const containerRect = mini.container.getBoundingClientRect();
    const vb = panel.vb;
    const rx = vb.w ? (projX - vb.x) / vb.w : 0.5;
    const ry = vb.h ? (projY - vb.y) / vb.h : 0.5;
    const x = (panelRect.left - containerRect.left) + rx * panelRect.width;
    const y = (panelRect.top - containerRect.top) + ry * panelRect.height;
    return { x, y };
  };

  const atlasIdToOverlayPx = (atlasId) => {
    const c = centroidById.get(String(atlasId));
    const bk = boroughById.get(String(atlasId));
    if (!c || !bk) return null;
    const [px, py] = projectLonLat([c[1], c[0]]);
    return projectedToOverlayPx(px, py, bk);
  };

  if (
    neighborhoodsGeo?.features?.length &&
    mini.container &&
    mini.overlay &&
    mini.manhattan &&
    mini.brooklyn &&
    mini.queens
  ) {
    ensureOverlaySized();
    for (const k of Object.keys(panelByKey)) {
      const svg = panelByKey[k].svg;
      svg.replaceChildren();
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      // We intentionally allow distortion so we can map projected coordinates
      // to panel pixels with a simple linear transform (no letterboxing offsets).
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("role", "img");
    }
    mini.overlay.replaceChildren();

    const featsByPanel = { manhattan: [], brooklyn: [], queens: [] };
    for (const feat of neighborhoodsGeo.features || []) {
      const props = feat?.properties || {};
      const bk = boroughKeyFromName(getBorough(props));
      if (!bk) continue;
      featsByPanel[bk].push(feat);
    }

    for (const [bk, feats] of Object.entries(featsByPanel)) {
      const svg = panelByKey[bk].svg;
      if (!svg || !feats.length) continue;
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      svg.appendChild(g);

      const b = computeProjectedBounds({ type: "FeatureCollection", features: feats });
      const padX = (b.maxX - b.minX) * 0.03;
      const padY = (b.maxY - b.minY) * 0.03;
      const vb = {
        x: b.minX - padX,
        y: b.minY - padY,
        w: (b.maxX - b.minX) + 2 * padX,
        h: (b.maxY - b.minY) + 2 * padY,
      };
      svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
      panelByKey[bk].vb = vb;

      for (const feat of feats) {
        const props = feat.properties || {};
        const id = String(props.atlas_id || props.id || "");
        const d = geometryToPathD(feat.geometry);
        if (!id || !d) continue;
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", d);
        p.setAttribute("class", "mini-outline");
        g.appendChild(p);
        pathById.set(id, p);
        boroughById.set(id, bk);

        const c = centroidLatLon(feat.geometry);
        if (c) centroidById.set(id, c);
      }
    }

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => ensureOverlaySized());
      ro.observe(mini.container);
    } else {
      window.addEventListener("resize", ensureOverlaySized);
    }
  }

  let overlayLink = null;
  let overlayDots = null;
  let overlaySpokes = null;

  const clearHoverPreview = () => {
    if (mini.title) mini.title.textContent = "Hover a corridor card";
    if (mini.meta) mini.meta.textContent = "";
    if (mini.line) {
      mini.line.hidden = true;
      mini.line.textContent = "";
      mini.line.style.borderColor = "rgba(2,6,23,0.12)";
      mini.line.style.background = "rgba(255,255,255,0.8)";
    }
    for (const p of pathById.values()) p.setAttribute("class", "mini-outline");
    if (overlaySpokes) {
      for (const p of Array.from(overlaySpokes.querySelectorAll("path"))) {
        p.setAttribute("stroke", "rgba(15,23,42,0.22)");
        p.setAttribute("stroke-width", "2");
        p.setAttribute("opacity", "0.55");
      }
    }
    overlayLink?.remove();
    overlayDots?.remove();
    overlayLink = null;
    overlayDots = null;
  };

  const routeColorByShort = async () => {
    const profile = getProfile();
    const graph = await fetchJson(`${DATA_DIR}/graph_${profile}${suffix}.json`);
    const m = new Map();
    for (const r of graph?.routes || []) {
      if (r?.short_name && r?.color) m.set(String(r.short_name), String(r.color));
      if (r?.id && r?.color) m.set(String(r.id), String(r.color));
    }
    return m;
  };

  let cachedRouteColors = null;
  let cachedRouteColorsProfile = null;

  const getRouteColors = async () => {
    const profile = getProfile();
    if (cachedRouteColors && cachedRouteColorsProfile === profile) return cachedRouteColors;
    cachedRouteColors = await routeColorByShort();
    cachedRouteColorsProfile = profile;
    return cachedRouteColors;
  };

  const showPreview = async (rowEl) => {
    if (!rowEl) return;
    const originId = rowEl.dataset.originId;
    const destId = rowEl.dataset.destId;
    if (!originId || !destId) return;

    const originName = rowEl.dataset.originName || originId;
    const destName = rowEl.dataset.destName || destId;
    if (mini.title) mini.title.textContent = `${originName} → ${destName}`;

    const mins = rowEl.dataset.minutes ? `${rowEl.dataset.minutes} min` : "—";
    const dist = rowEl.dataset.distanceKm ? `${rowEl.dataset.distanceKm} km` : "—";
    const saved = rowEl.dataset.teleport ? `${rowEl.dataset.teleport} min saved` : "";
    if (mini.meta) mini.meta.textContent = [mins, dist, saved].filter(Boolean).join(" · ");

    const lineName = rowEl.dataset.line || "";
    if (mini.line) {
      if (lineName) {
        mini.line.hidden = false;
        mini.line.textContent = lineName;
        const colors = await getRouteColors();
        const c = colors.get(lineName);
        if (c) {
          mini.line.style.borderColor = `${c}55`;
          mini.line.style.background = `${c}1a`;
        }
      } else {
        mini.line.hidden = true;
      }
    }

    for (const p of pathById.values()) p.setAttribute("class", "mini-outline");
    pathById.get(originId)?.setAttribute("class", "mini-origin");
    pathById.get(destId)?.setAttribute("class", "mini-dest");

    if (overlaySpokes) {
      for (const p of Array.from(overlaySpokes.querySelectorAll("path"))) {
        const hit = String(p.dataset.originId || "") === String(originId);
        p.setAttribute("stroke", hit ? "rgba(15,23,42,0.42)" : "rgba(15,23,42,0.22)");
        p.setAttribute("stroke-width", hit ? "3" : "2");
        p.setAttribute("opacity", hit ? "1" : "0.55");
      }
    }

    // Overlay a simple link + dots between centroids (approx); route segments live on the main map.
    const oPx = atlasIdToOverlayPx(originId);
    const dPx = atlasIdToOverlayPx(destId);
    if (!mini.overlay || !oPx || !dPx) return;

    overlayLink?.remove();
    overlayDots?.remove();

    const link = document.createElementNS("http://www.w3.org/2000/svg", "path");
    link.setAttribute("d", `M ${oPx.x} ${oPx.y} L ${dPx.x} ${dPx.y}`);
    link.setAttribute("class", "mini-link");
    if (lineName) {
      const colors = await getRouteColors();
      const c = colors.get(lineName);
      if (c) link.setAttribute("stroke", c);
    }
    mini.overlay.appendChild(link);
    overlayLink = link;

    const dots = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const mkDot = (x, y) => {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", String(x));
      c.setAttribute("cy", String(y));
      c.setAttribute("r", "4");
      c.setAttribute("class", "mini-dot");
      return c;
    };
    dots.appendChild(mkDot(oPx.x, oPx.y));
    dots.appendChild(mkDot(dPx.x, dPx.y));
    mini.overlay.appendChild(dots);
    overlayDots = dots;
  };

  const rerender = () => {
    const profile = getProfile();
    const maxMinutes = clamp(getMaxMinutes(), 15, 180);
    const hub = getHub();
    const includeInner = !!document.getElementById("includeInner")?.checked;
    const spokeMode = getSpokeMode();
    if (maxLabel) maxLabel.textContent = String(maxMinutes);
    const win = data?.windows?.[profile];
    const hubs = win?.hubs || {};
    const hubMeta = hubs?.[hub];
    const hubLabel = hubMeta?.label || hub;
    if (hubLabelA) hubLabelA.textContent = hubLabel;
    if (hubLabelB) hubLabelB.textContent = hubLabel;
    const corr = win?.corridors?.[hub] || {};
    const underrated = corr?.top_underrated || [];
    const speed = corr?.top_speed || [];
    // Attach hub metadata so rows can preview correctly and never show "undefined".
    const withHub = (arr) =>
      arr.map((e) => ({
        ...e,
        hub_id: e.hub_id || hubMeta?.id || "",
        hub_name: e.hub_name || hubMeta?.name || hubLabel,
      }));
    const underratedRows = withHub(underrated);
    const speedRows = withHub(speed);
    const passes = (e) => {
      if (e.minutes == null || e.minutes > maxMinutes) return false;
      if (includeInner) return true;
      return e.distance_km == null ? true : e.distance_km >= 6;
    };
    const filteredUnderrated = underratedRows.filter(passes);
    const filteredSpeed = speedRows.filter(passes);

    const renderClustered = (el, rows) => {
      el.replaceChildren();
      const pts = [];
      for (const r of rows) {
        const oc = centroidById.get(String(r.origin_id || r.originId || r.origin_id || ""));
        if (!oc) continue;
        const [x, y] = projectLonLat([oc[1], oc[0]]);
        pts.push({ x, y, row: r });
      }
      const k = clamp(Math.round(Math.sqrt(pts.length / 3)), 4, 10);
      const km = kMeans2D(pts, k);
      const clusters = new Array(km.centers.length).fill(0).map(() => []);
      for (let i = 0; i < km.assignments.length; i++) clusters[km.assignments[i]].push(pts[i]);
      // Representative per cluster: highest minutes_saved (underrated) or highest km_per_min (speed).
      for (const cl of clusters) {
        if (!cl.length) continue;
        cl.sort((a, b) => {
          const as = loadNumber(a.row.minutes_saved, 0);
          const bs = loadNumber(b.row.minutes_saved, 0);
          const ak = loadNumber(a.row.km_per_min, 0);
          const bk = loadNumber(b.row.km_per_min, 0);
          // Use primary metric based on which list we are rendering (detect by presence of minutes_saved prominence).
          // Heuristic: if minutes_saved exists, treat as underrated.
          const aHas = a.row.minutes_saved != null;
          const bHas = b.row.minutes_saved != null;
          if (aHas || bHas) return bs - as || bk - ak;
          return bk - ak || bs - as;
        });
        const rep = cl[0].row;
        const node = corridorRow(rep);
        const hint = document.createElement("div");
        hint.className = "corridor-meta mono";
        hint.textContent = `cluster +${Math.max(0, cl.length - 1)} more nearby`;
        node.appendChild(hint);
        el.appendChild(node);
      }
      if (!el.childNodes.length) {
        const empty = document.createElement("div");
        empty.className = "corridor-empty";
        empty.textContent = "No corridors within this cutoff.";
        el.appendChild(empty);
      }
    };

    if (spokeMode === "clustered") {
      renderClustered(underratedEl, filteredUnderrated);
      renderClustered(speedEl, filteredSpeed);
    } else {
      renderList(underratedEl, filteredUnderrated, maxMinutes, true);
      renderList(speedEl, filteredSpeed, maxMinutes, true);
    }
    if (status) status.textContent = `ready · ${hubLabel}`;

    clearHoverPreview();
    cachedRouteColorsProfile = null;

    const hookHover = (container) => {
      for (const row of Array.from(container.querySelectorAll(".corridor-row"))) {
        row.addEventListener("mouseenter", () => void showPreview(row));
        row.addEventListener("mouseleave", () => clearHoverPreview());
      }
    };
    hookHover(underratedEl);
    hookHover(speedEl);

    const hid = String(hubMeta?.id || underratedRows?.[0]?.hub_id || speedRows?.[0]?.hub_id || "");

    // Spoke fan: draw top origins as faint lines from hub; hover card brightens one line.
    if (mini.overlay && hid) {
      const hubPx = atlasIdToOverlayPx(hid);
      if (hubPx) {
        overlaySpokes?.remove();
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.setAttribute("opacity", "0.55");
        const rowsForFan =
          spokeMode === "clustered"
            ? Array.from(underratedEl.querySelectorAll(".corridor-row"))
                .slice(0, 12)
                .map((el) => ({ origin_id: el.dataset.originId }))
            : filteredUnderrated.slice(0, 12);
        for (const r0 of rowsForFan) {
          const oid = String(r0.origin_id || "");
          const op = atlasIdToOverlayPx(oid);
          if (!op) continue;
          const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
          p.setAttribute("d", `M ${hubPx.x} ${hubPx.y} L ${op.x} ${op.y}`);
          p.setAttribute("fill", "none");
          p.setAttribute("stroke", "rgba(15,23,42,0.22)");
          p.setAttribute("stroke-width", "2");
          p.setAttribute("stroke-linecap", "round");
          p.dataset.originId = oid;
          g.appendChild(p);
        }
        mini.overlay.appendChild(g);
        overlaySpokes = g;
      }
    }
  };

  for (const r of Array.from(document.querySelectorAll('input[name="profile"]'))) {
    r.addEventListener("change", () => {
      savePrefs();
      rerender();
    });
  }
  for (const r of Array.from(document.querySelectorAll('input[name="hub"]'))) {
    r.addEventListener("change", () => {
      savePrefs();
      rerender();
    });
  }
  for (const r of Array.from(document.querySelectorAll('input[name="spokeMode"]'))) {
    r.addEventListener("change", () => {
      savePrefs();
      rerender();
    });
  }
  for (const r of Array.from(document.querySelectorAll('input[name="baseUnit"]'))) {
    r.addEventListener("change", () => {
      savePrefs();
      window.location.reload();
    });
  }
  document.getElementById("includeInner")?.addEventListener("change", () => {
    savePrefs();
    rerender();
  });
  maxEl?.addEventListener("input", rerender);

  rerender();
}

main().catch((err) => {
  console.error(err);
  alert(err?.message || String(err));
});
