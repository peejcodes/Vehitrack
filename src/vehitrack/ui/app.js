const THEMES = {
  light: {
    bg: "#eef4fa",
    accent: "#2962ff",
    accentSoft: "rgba(41,98,255,0.14)",
    panel: "rgba(255,255,255,0.92)",
    text: "#152131",
    muted: "#5f6f85",
    route: "#2f6dff",
    trip: "#00a27a",
    raw: "#0ea5e9",
    snapped: "#8b5cf6",
    water: "#a9d5ff",
    land: "#e9f0dc",
    park: "#d8efd0",
    roadsMinor: "#ffffff",
    roadsMajor: "#ffd6ae",
    roadsHighway: "#ffb067",
    labels: "#223046",
    boundaries: "rgba(80,98,124,0.35)",
  },
  dark: {
    bg: "#0b1220",
    accent: "#8cb0ff",
    accentSoft: "rgba(140,176,255,0.16)",
    panel: "rgba(10,17,31,0.94)",
    text: "#e8eff9",
    muted: "#9eb1ca",
    route: "#8cb0ff",
    trip: "#47d5aa",
    raw: "#4cc8ff",
    snapped: "#bca4ff",
    water: "#132a4d",
    land: "#17222f",
    park: "#163328",
    roadsMinor: "#374356",
    roadsMajor: "#6f84a7",
    roadsHighway: "#9db8ff",
    labels: "#dbe8ff",
    boundaries: "rgba(195,215,255,0.24)",
  },
  amethyst: {
    bg: "#120f1d",
    accent: "#d0a2ff",
    accentSoft: "rgba(208,162,255,0.16)",
    panel: "rgba(35,26,57,0.94)",
    text: "#f6efff",
    muted: "#cfbfec",
    route: "#d0a2ff",
    trip: "#50ddb1",
    raw: "#63d7ff",
    snapped: "#d2a7ff",
    water: "#211d3a",
    land: "#231b33",
    park: "#2b3144",
    roadsMinor: "#4c4564",
    roadsMajor: "#8a74a8",
    roadsHighway: "#d0a2ff",
    labels: "#f2e8ff",
    boundaries: "rgba(214,182,255,0.26)",
  },
};

const DEFAULT_VIEW = { center: [-77.436, 37.5407], zoom: 11 };
const STATE_POLL_MS = 1000;
const TRIPS_POLL_MS = 10000;
const SNAP_THRESHOLD_GOOD_M = 32;
const SNAP_THRESHOLD_WEAK_M = 18;
const SNAP_OFFROUTE_M = 48;
const LOOKAHEAD_BASE_M = 65;
const ARRIVAL_THRESHOLD_M = 35;
const MOVING_SPEED_THRESHOLD_MPS = 1.0;

const state = {
  map: null,
  config: null,
  theme: "light",
  satelliteVisible: false,
  styleReady: false,
  latestSnapshot: null,
  latestTrips: [],
  lastLoadedTripId: null,
  currentTripLine: [],

  destination: null,
  destinationMarker: null,

  currentRoutePayload: null,
  currentRouteMetrics: null,
  currentRouteSteps: [],
  currentRouteStepIndex: 0,

  currentRawPosition: null,
  currentSnappedPosition: null,
  currentDisplayPosition: null,

  navigationActive: false,
  followMode: false,
  stepsOpen: false,
  toolsOpen: false,

  navSession: null,
  places: { favorites: [], history: [] },
  searchResults: [],
};

function $(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function samePlace(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && String(a.id) === String(b.id)) return true;
  const aLat = Number(a.lat);
  const aLon = Number(a.lon);
  const bLat = Number(b.lat);
  const bLon = Number(b.lon);
  return Number.isFinite(aLat) && Number.isFinite(aLon) && Number.isFinite(bLat) && Number.isFinite(bLon)
    && Math.abs(aLat - bLat) < 1e-6 && Math.abs(aLon - bLon) < 1e-6;
}

function isFavorite(place) {
  return state.places.favorites.some((item) => samePlace(item, place));
}

function currentThemePalette() {
  return THEMES[state.theme] || THEMES.light;
}

function applyTheme(themeName) {
  state.theme = THEMES[themeName] ? themeName : "light";
  document.documentElement.dataset.theme = state.theme;
  localStorage.setItem("vehitrack.theme", state.theme);
  document.querySelectorAll(".btn-theme").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === state.theme);
  });
  if (state.map && state.config) {
    setMapStyle();
  }
}

function setMapStatus(text) {
  setText("mapStatus", text);
}

function setSearchStatus(text) {
  setText("searchStatus", text);
}

function setRouteStatus(text) {
  setText("routeStatus", text);
}

function setSpeedLimitValue(text) {
  setText("speedLimitValue", text);
}

function speedToMph(mps) {
  if (!Number.isFinite(mps)) return null;
  return mps * 2.2369362920544;
}

function fmtSpeed(mps) {
  const mph = speedToMph(mps);
  return Number.isFinite(mph) ? `${mph.toFixed(1)} mph` : "—";
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "—";
  if (meters < 1000) return `${Math.round(meters)} m`;
  const miles = meters / 1609.344;
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function formatEtaFromNow(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const dt = new Date(Date.now() + (seconds * 1000));
  return dt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

async function apiGet(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ detail: `${res.status} ${res.statusText}` }));
    throw new Error(payload.detail || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function apiPost(url, payload = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: `${res.status} ${res.statusText}` }));
    throw new Error(body.detail || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function apiDelete(url) {
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: `${res.status} ${res.statusText}` }));
    throw new Error(body.detail || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

function download(url) {
  window.location.href = url;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toMetersXY(lon, lat, refLat) {
  const rad = Math.PI / 180;
  const x = lon * rad * 6371000 * Math.cos(refLat * rad);
  const y = lat * rad * 6371000;
  return [x, y];
}

function bearingBetween(from, to) {
  if (!from || !to) return null;
  const lat1 = from[1] * Math.PI / 180;
  const lat2 = to[1] * Math.PI / 180;
  const dLon = (to[0] - from[0]) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function buildRouteMetrics(lineCoords) {
  if (!Array.isArray(lineCoords) || lineCoords.length < 2) return null;
  const cumulative = [0];
  let totalDistanceM = 0;
  for (let i = 1; i < lineCoords.length; i += 1) {
    const a = lineCoords[i - 1];
    const b = lineCoords[i];
    const dist = haversineMeters(a[1], a[0], b[1], b[0]);
    totalDistanceM += dist;
    cumulative.push(totalDistanceM);
  }
  return { lineCoords, cumulative, totalDistanceM };
}

function snapPointToLineProgress(rawLonLat, metrics) {
  if (!rawLonLat || !metrics || !metrics.lineCoords || metrics.lineCoords.length < 2) return null;
  const [rawLon, rawLat] = rawLonLat;
  const refLat = rawLat;
  const rawXY = toMetersXY(rawLon, rawLat, refLat);

  let best = null;
  for (let i = 1; i < metrics.lineCoords.length; i += 1) {
    const a = metrics.lineCoords[i - 1];
    const b = metrics.lineCoords[i];
    const aXY = toMetersXY(a[0], a[1], refLat);
    const bXY = toMetersXY(b[0], b[1], refLat);

    const vx = bXY[0] - aXY[0];
    const vy = bXY[1] - aXY[1];
    const wx = rawXY[0] - aXY[0];
    const wy = rawXY[1] - aXY[1];
    const segLenSq = (vx * vx) + (vy * vy);
    let t = 0;
    if (segLenSq > 0) t = Math.max(0, Math.min(1, ((wx * vx) + (wy * vy)) / segLenSq));

    const projX = aXY[0] + (vx * t);
    const projY = aXY[1] + (vy * t);
    const dx = rawXY[0] - projX;
    const dy = rawXY[1] - projY;
    const distM = Math.sqrt((dx * dx) + (dy * dy));

    const lon = a[0] + ((b[0] - a[0]) * t);
    const lat = a[1] + ((b[1] - a[1]) * t);
    const segmentDistance = metrics.cumulative[i - 1] + ((metrics.cumulative[i] - metrics.cumulative[i - 1]) * t);

    if (!best || distM < best.distanceM) {
      best = {
        lon,
        lat,
        distanceM: distM,
        progressM: segmentDistance,
        segmentIndex: i - 1,
      };
    }
  }
  return best;
}

function pointAlongRoute(metrics, progressM) {
  if (!metrics || !metrics.lineCoords || metrics.lineCoords.length === 0) return null;
  const goal = Math.max(0, Math.min(progressM, metrics.totalDistanceM));
  if (goal <= 0) return metrics.lineCoords[0];
  if (goal >= metrics.totalDistanceM) return metrics.lineCoords[metrics.lineCoords.length - 1];

  for (let i = 1; i < metrics.cumulative.length; i += 1) {
    if (goal <= metrics.cumulative[i]) {
      const prev = metrics.cumulative[i - 1];
      const next = metrics.cumulative[i];
      const span = Math.max(1e-6, next - prev);
      const t = (goal - prev) / span;
      const a = metrics.lineCoords[i - 1];
      const b = metrics.lineCoords[i];
      return [
        a[0] + ((b[0] - a[0]) * t),
        a[1] + ((b[1] - a[1]) * t),
      ];
    }
  }
  return metrics.lineCoords[metrics.lineCoords.length - 1];
}

function snapThresholdForState(snapshot) {
  const hdop = Number(snapshot?.hdop);
  if (Number.isFinite(hdop) && hdop > 3.5) return SNAP_THRESHOLD_WEAK_M;
  return SNAP_THRESHOLD_GOOD_M;
}

function buildInstructionFromStep(step) {
  if (!step) return "Continue";
  if (step.instruction) return step.instruction;
  const maneuver = step.maneuver || {};
  const type = String(maneuver.type || "continue");
  const modifier = String(maneuver.modifier || "").replaceAll("_", " ").trim();
  const name = step.name ? ` onto ${step.name}` : "";

  if (type === "depart") return "Head out";
  if (type === "arrive") return "Arrive at destination";
  if (type === "roundabout") {
    const exit = maneuver.exit ? ` and take exit ${maneuver.exit}` : "";
    return `At the roundabout, continue${exit}`;
  }
  if (type === "turn") return `Turn${modifier ? ` ${modifier}` : ""}${name}`.trim();
  if (type === "merge") return `Merge${name}`.trim();
  if (type === "fork") return `Keep${modifier ? ` ${modifier}` : ""}${name}`.trim();
  return `Continue${modifier ? ` ${modifier}` : ""}${name}`.trim();
}

function normaliseRouteSteps(routePayload) {
  return Array.isArray(routePayload?.steps) ? routePayload.steps.map((step, idx) => ({
    ...step,
    _index: idx,
    instruction: buildInstructionFromStep(step),
    distance_m: Number(step.distance_m ?? step.distance ?? 0),
    duration_s: Number(step.duration_s ?? step.duration ?? 0),
  })) : [];
}

function currentTripFeature() {
  const trip = state.currentTripLine || [];
  if (trip.length < 2) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "LineString", coordinates: trip },
      properties: {},
    }],
  };
}

function routeFeatureCollection() {
  const coords = state.currentRoutePayload?.geometry?.coordinates || [];
  if (coords.length < 2) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: {},
    }],
  };
}

function rawPositionFeature() {
  if (!state.currentRawPosition) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [state.currentRawPosition.lon, state.currentRawPosition.lat] },
      properties: {},
    }],
  };
}

function snappedPositionFeature() {
  if (!state.currentSnappedPosition) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [state.currentSnappedPosition.lon, state.currentSnappedPosition.lat] },
      properties: {
        distance_from_raw_m: state.currentSnappedPosition.distanceFromRawM,
      },
    }],
  };
}

function applyDestinationMarker() {
  if (!state.map) return;
  if (state.destinationMarker) {
    state.destinationMarker.remove();
    state.destinationMarker = null;
  }
  if (!state.destination) return;
  const el = document.createElement("div");
  el.className = "destination-marker";
  state.destinationMarker = new maplibregl.Marker({ element: el, anchor: "bottom-left" })
    .setLngLat([state.destination.lon, state.destination.lat])
    .addTo(state.map);
}

function ensureOverlayLayers() {
  if (!state.map) return;
  const palette = currentThemePalette();

  const sourceDefs = [
    ["vehitrack-trip", currentTripFeature()],
    ["vehitrack-route", routeFeatureCollection()],
    ["vehitrack-raw", rawPositionFeature()],
    ["vehitrack-snapped", snappedPositionFeature()],
  ];
  for (const [id, data] of sourceDefs) {
    const existing = state.map.getSource(id);
    if (existing) existing.setData(data);
    else state.map.addSource(id, { type: "geojson", data });
  }

  const addLayerIfMissing = (layer) => {
    if (!state.map.getLayer(layer.id)) state.map.addLayer(layer);
  };

  addLayerIfMissing({
    id: "vehitrack-trip-line",
    type: "line",
    source: "vehitrack-trip",
    paint: {
      "line-color": palette.trip,
      "line-width": 3,
      "line-opacity": 0.88,
    },
  });

  addLayerIfMissing({
    id: "vehitrack-route-halo",
    type: "line",
    source: "vehitrack-route",
    paint: {
      "line-color": "rgba(0,0,0,0.24)",
      "line-width": 11,
      "line-opacity": 0.22,
      "line-blur": 0.5,
    },
  });

  addLayerIfMissing({
    id: "vehitrack-route-line",
    type: "line",
    source: "vehitrack-route",
    paint: {
      "line-color": palette.route,
      "line-width": 6,
      "line-opacity": 0.95,
    },
  });

  addLayerIfMissing({
    id: "vehitrack-raw-dot",
    type: "circle",
    source: "vehitrack-raw",
    paint: {
      "circle-radius": 6,
      "circle-color": palette.raw,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2.5,
      "circle-opacity": 0.95,
    },
  });

  addLayerIfMissing({
    id: "vehitrack-snapped-dot",
    type: "circle",
    source: "vehitrack-snapped",
    paint: {
      "circle-radius": 8,
      "circle-color": palette.snapped,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2.5,
      "circle-opacity": 0.98,
    },
  });
}

function refreshOverlayStyle() {
  if (!state.map) return;
  const palette = currentThemePalette();
  if (state.map.getLayer("vehitrack-trip-line")) {
    state.map.setPaintProperty("vehitrack-trip-line", "line-color", palette.trip);
  }
  if (state.map.getLayer("vehitrack-route-line")) {
    state.map.setPaintProperty("vehitrack-route-line", "line-color", palette.route);
  }
  if (state.map.getLayer("vehitrack-raw-dot")) {
    state.map.setPaintProperty("vehitrack-raw-dot", "circle-color", palette.raw);
  }
  if (state.map.getLayer("vehitrack-snapped-dot")) {
    state.map.setPaintProperty("vehitrack-snapped-dot", "circle-color", palette.snapped);
  }
}

function syncOverlayData() {
  if (!state.map) return;
  const sourceUpdates = [
    ["vehitrack-trip", currentTripFeature()],
    ["vehitrack-route", routeFeatureCollection()],
    ["vehitrack-raw", rawPositionFeature()],
    ["vehitrack-snapped", snappedPositionFeature()],
  ];
  for (const [id, data] of sourceUpdates) {
    const src = state.map.getSource(id);
    if (src) src.setData(data);
  }
}

function fitGeometry(geojson, options = {}) {
  if (!state.map || !geojson || !geojson.features || !geojson.features.length) return;
  const bounds = new maplibregl.LngLatBounds();
  geojson.features.forEach((feature) => {
    const coords = feature.geometry?.coordinates || [];
    if (feature.geometry?.type === "LineString") {
      coords.forEach((coord) => bounds.extend(coord));
    } else if (feature.geometry?.type === "Point") {
      bounds.extend(coords);
    }
  });
  if (!bounds.isEmpty()) {
    state.map.fitBounds(bounds, {
      padding: options.padding || { top: 170, right: 80, bottom: 110, left: 80 },
      maxZoom: options.maxZoom || 16,
      duration: options.duration || 800,
    });
  }
}

function roadImportanceExpression(theme, level) {
  const matchExpr = ["coalesce", ["get", "kind_detail"], ["get", "kind"], ["get", "class"], ""];
  if (level === "highway") {
    return [
      "match", matchExpr,
      ["motorway", "trunk", "motorway_link", "trunk_link", "freeway", "highway"], theme.roadsHighway,
      "rgba(0,0,0,0)",
    ];
  }
  if (level === "major") {
    return [
      "match", matchExpr,
      ["primary", "secondary", "tertiary", "primary_link", "secondary_link", "major_road"], theme.roadsMajor,
      "rgba(0,0,0,0)",
    ];
  }
  return theme.roadsMinor;
}

function buildStyle(theme, tilejsonUrl, satelliteTilesUrl, satelliteVisible) {
  const satEnabled = satelliteVisible && satelliteTilesUrl;
  const style = {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      protomaps: {
        type: "vector",
        url: tilejsonUrl,
      },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": theme.bg } },
      {
        id: "land",
        type: "fill",
        source: "protomaps",
        "source-layer": "earth",
        paint: { "fill-color": theme.land },
      },
      {
        id: "landuse",
        type: "fill",
        source: "protomaps",
        "source-layer": "landuse",
        paint: { "fill-color": theme.park, "fill-opacity": 0.82 },
      },
      {
        id: "water",
        type: "fill",
        source: "protomaps",
        "source-layer": "water",
        paint: { "fill-color": theme.water },
      },
      {
        id: "boundaries",
        type: "line",
        source: "protomaps",
        "source-layer": "boundaries",
        paint: { "line-color": theme.boundaries, "line-width": 1 },
      },
      {
        id: "roads-minor",
        type: "line",
        source: "protomaps",
        "source-layer": "roads",
        paint: {
          "line-color": roadImportanceExpression(theme, "minor"),
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.3, 12, 0.9, 16, 3.2],
          "line-opacity": 0.95,
        },
      },
      {
        id: "roads-major",
        type: "line",
        source: "protomaps",
        "source-layer": "roads",
        paint: {
          "line-color": roadImportanceExpression(theme, "major"),
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 12, 1.8, 16, 5.5],
          "line-opacity": 0.95,
        },
      },
      {
        id: "roads-highway",
        type: "line",
        source: "protomaps",
        "source-layer": "roads",
        paint: {
          "line-color": roadImportanceExpression(theme, "highway"),
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.0, 12, 2.8, 16, 7.5],
          "line-opacity": 0.98,
        },
      },
      {
        id: "building",
        type: "fill",
        source: "protomaps",
        "source-layer": "buildings",
        paint: { "fill-color": ["case", satEnabled, "rgba(0,0,0,0.18)", "rgba(0,0,0,0.05)"] },
      },
      {
        id: "place-labels",
        type: "symbol",
        source: "protomaps",
        "source-layer": "places",
        layout: {
          "text-field": ["coalesce", ["get", "name"], ["get", "name_en"], ""],
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 5, 11, 12, 14, 15, 16],
        },
        paint: {
          "text-color": theme.labels,
          "text-halo-color": theme.bg,
          "text-halo-width": 1.2,
        },
      },
      {
        id: "poi-labels",
        type: "symbol",
        source: "protomaps",
        "source-layer": "pois",
        minzoom: 13,
        layout: {
          "text-field": ["coalesce", ["get", "name"], ""],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
        },
        paint: {
          "text-color": theme.labels,
          "text-halo-color": theme.bg,
          "text-halo-width": 1,
        },
      },
    ],
  };

  if (satelliteTilesUrl) {
    style.sources.satellite = {
      type: "raster",
      tiles: [satelliteTilesUrl],
      tileSize: 256,
    };
    if (satelliteVisible) {
      style.layers.splice(1, 0, {
        id: "satellite",
        type: "raster",
        source: "satellite",
        paint: { "raster-opacity": 1.0 },
      });
    }
  }
  return style;
}

function afterStyleReady() {
  state.styleReady = true;
  ensureOverlayLayers();
  refreshOverlayStyle();
  syncOverlayData();
  applyDestinationMarker();
  setMapStatus("Map ready");
}

function setMapStyle() {
  if (!state.map || !state.config) return;
  const theme = currentThemePalette();
  state.styleReady = false;
  state.map.once("styledata", afterStyleReady);
  state.map.setStyle(
    buildStyle(
      theme,
      state.config.vector_tilejson_url,
      state.config.satellite_tiles_url,
      state.satelliteVisible,
    )
  );
  const satBtn = $("satelliteBtn");
  if (satBtn) {
    satBtn.textContent = state.config.satellite_tiles_url
      ? (state.satelliteVisible ? "Satellite On" : "Satellite Off")
      : "Satellite N/A";
  }
}

function initMap() {
  state.map = new maplibregl.Map({
    container: "map",
    style: buildStyle(
      currentThemePalette(),
      state.config.vector_tilejson_url,
      state.config.satellite_tiles_url,
      false,
    ),
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
    attributionControl: false,
  });
  state.map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
  state.map.on("load", afterStyleReady);
  state.map.on("error", (evt) => {
    console.error(evt.error || evt);
    setMapStatus(`Map error: ${evt.error?.message || "unknown"}`);
  });
}

function updateFavoriteSelectedButton() {
  const btn = $("favoriteSelectedBtn");
  if (!btn) return;
  const active = !!state.destination && isFavorite(state.destination);
  btn.classList.toggle("active", active);
  btn.title = active ? "Remove selected destination from favorites" : "Save selected destination";
}

async function loadPlaces() {
  try {
    const data = await apiGet("/api/places");
    state.places = { favorites: data.favorites || [], history: data.history || [] };
    renderSavedPlaces();
    updateFavoriteSelectedButton();
  } catch (err) {
    console.error(err);
  }
}

function renderPlaceButton(place, kind) {
  const subtitle = escapeHtml(place.display_name || "");
  const isFav = isFavorite(place);
  const removeText = kind === "favorite" ? "Remove" : "Save";
  const removeAction = kind === "favorite"
    ? `data-remove-favorite="${escapeHtml(place.id)}"`
    : `data-save-favorite="${escapeHtml(place.id)}"`;
  return `
    <div class="saved-place">
      <div class="saved-place-main">
        <div class="saved-place-title">${escapeHtml(place.name || place.display_name || "Saved place")}</div>
        <div class="saved-place-subtitle">${subtitle}</div>
      </div>
      <div class="saved-place-actions">
        <button class="btn btn-small btn-primary" data-pick-place="${escapeHtml(place.id)}">Use</button>
        <button class="btn btn-small btn-subtle" ${removeAction}>${kind === "favorite" ? "Remove" : (isFav ? "Saved" : removeText)}</button>
      </div>
    </div>
  `;
}

function renderSavedPlaces() {
  const favs = $("favoritesList");
  const history = $("historyList");

  if (favs) {
    if (!state.places.favorites.length) {
      favs.className = "saved-list empty";
      favs.innerHTML = "No favorites saved yet.";
    } else {
      favs.className = "saved-list";
      favs.innerHTML = state.places.favorites.map((place) => renderPlaceButton(place, "favorite")).join("");
    }
  }

  if (history) {
    if (!state.places.history.length) {
      history.className = "saved-list empty";
      history.innerHTML = "No recent destinations yet.";
    } else {
      history.className = "saved-list";
      history.innerHTML = state.places.history.map((place) => renderPlaceButton(place, "history")).join("");
    }
  }
}

function renderSearchResults(results = [], query = "") {
  state.searchResults = results;
  const wrap = $("searchResults");
  if (!wrap) return;
  if (!query && !results.length) {
    wrap.innerHTML = "";
    return;
  }
  if (!results.length) {
    wrap.innerHTML = `<div class="search-empty">No results for “${escapeHtml(query)}”.</div>`;
    return;
  }

  wrap.innerHTML = results.map((result, idx) => {
    const dist = Number.isFinite(Number(result.distance_m))
      ? `<span>${formatDistance(Number(result.distance_m))} away</span>`
      : "";
    const cls = escapeHtml(result.class || "");
    const type = escapeHtml(result.type || "");
    const favoriteLabel = isFavorite(result) ? "★ Saved" : "☆ Save";
    return `
      <div class="search-card">
        <div class="search-card-main">
          <div class="search-card-title">${escapeHtml(result.name || result.display_name || "Result")}</div>
          <div class="search-card-subtitle">${escapeHtml(result.display_name || "")}</div>
          <div class="search-card-metrics">
            ${dist}
            ${cls ? `<span>${cls}</span>` : ""}
            ${type ? `<span>${type}</span>` : ""}
          </div>
        </div>
        <div class="search-card-actions">
          <button class="btn btn-small btn-primary" data-search-pick="${idx}">Select</button>
          <button class="btn btn-small btn-subtle" data-search-favorite="${idx}">${favoriteLabel}</button>
        </div>
      </div>
    `;
  }).join("");
}

function setSelectedDestination(place, options = {}) {
  if (!place) return;
  state.destination = {
    ...place,
    lat: Number(place.lat),
    lon: Number(place.lon),
  };
  setText("selectedDestination", `Destination: ${place.display_name || place.name || `${place.lat}, ${place.lon}`}`);
  setText("routeDestinationLabel", place.name || place.display_name || "Destination");
  applyDestinationMarker();
  updateFavoriteSelectedButton();
  if (!options.skipHistory) {
    apiPost("/api/places/history", place)
      .then((res) => {
        state.places = { favorites: res.places.favorites || [], history: res.places.history || [] };
        renderSavedPlaces();
      })
      .catch((err) => console.error(err));
  }
}

function buildSearchQueryString() {
  const q = $("searchInput")?.value?.trim() || "";
  const params = new URLSearchParams();
  params.set("q", q);
  params.set("limit", "10");
  const fix = state.latestSnapshot;
  if (fix?.fix_valid && Number.isFinite(Number(fix.lat_deg)) && Number.isFinite(Number(fix.lon_deg))) {
    params.set("lat", String(fix.lat_deg));
    params.set("lon", String(fix.lon_deg));
  }
  return { q, params: params.toString() };
}

async function performSearch() {
  const { q, params } = buildSearchQueryString();
  if (!q) {
    renderSearchResults([], "");
    setSearchStatus("Enter a destination to search.");
    return;
  }
  try {
    setSearchStatus("Searching local Nominatim…");
    const payload = await apiGet(`/api/search?${params}`);
    const results = payload.results || [];
    renderSearchResults(results, q);
    if (payload.bias) {
      setSearchStatus(`Showing ${results.length} results, biased toward current GPS position.`);
    } else {
      setSearchStatus(`Showing ${results.length} results.`);
    }
  } catch (err) {
    console.error(err);
    setSearchStatus(`Search failed: ${err.message}`);
  }
}

async function toggleSelectedFavorite() {
  if (!state.destination) return;
  try {
    if (isFavorite(state.destination)) {
      await apiDelete(`/api/places/favorites/${encodeURIComponent(state.destination.id)}`);
    } else {
      await apiPost("/api/places/favorites", state.destination);
    }
    await loadPlaces();
  } catch (err) {
    console.error(err);
    setSearchStatus(`Favorite update failed: ${err.message}`);
  }
}

async function clearHistory() {
  try {
    const res = await apiDelete("/api/places/history");
    state.places = { favorites: res.places.favorites || [], history: res.places.history || [] };
    renderSavedPlaces();
  } catch (err) {
    console.error(err);
  }
}

function renderStepList() {
  const wrap = $("stepList");
  if (!wrap) return;
  if (!state.currentRouteSteps.length) {
    wrap.textContent = "No route loaded.";
    return;
  }
  wrap.innerHTML = state.currentRouteSteps.map((step, idx) => {
    const road = step.name ? ` • ${escapeHtml(step.name)}` : "";
    return `
      <div class="step-item ${idx === state.currentRouteStepIndex ? "active" : ""}">
        <div class="step-number">${idx + 1}</div>
        <div>
          <div><strong>${escapeHtml(step.instruction || buildInstructionFromStep(step))}</strong></div>
          <div class="saved-place-subtitle">${formatDistance(step.distance_m)}${road}</div>
        </div>
      </div>
    `;
  }).join("");
}

function updateUiLayout() {
  $("navBanner")?.classList.toggle("hidden", !state.navigationActive);
  $("stepsPanel")?.classList.toggle("hidden", !state.stepsOpen);
  $("toolsDrawer")?.classList.toggle("hidden", !state.toolsOpen);

  const routePreview = $("routePreview");
  if (routePreview) {
    routePreview.classList.toggle("hidden", !state.destination && !state.currentRoutePayload);
    routePreview.classList.toggle("minimized", state.navigationActive);
  }

  $("followBtn")?.classList.toggle("active", state.followMode);
  updateFavoriteSelectedButton();
  renderStepList();
}

function clearRoute(options = {}) {
  state.currentRoutePayload = null;
  state.currentRouteMetrics = null;
  state.currentRouteSteps = [];
  state.currentRouteStepIndex = 0;
  state.currentSnappedPosition = null;
  state.currentDisplayPosition = state.currentRawPosition;
  state.navigationActive = false;
  state.followMode = false;
  if (!options.keepDestination) {
    state.destination = null;
    setText("selectedDestination", "Destination: —");
    setText("routeDestinationLabel", "—");
    if (state.destinationMarker) {
      state.destinationMarker.remove();
      state.destinationMarker = null;
    }
  }
  if (!options.keepCompletion) closeCompletionPanel();
  setText("routeDistance", "—");
  setText("routeDuration", "—");
  setText("routeMeta", "Current GPS position → selected destination.");
  setRouteStatus("Select a destination to build a route.");
  setText("nextInstruction", "—");
  setText("navStatus", "Route guidance idle.");
  setText("nextDistance", "—");
  setText("remainingDistance", "—");
  setText("remainingEta", "—");
  setSpeedLimitValue("—");
  syncOverlayData();
  updateUiLayout();
}

async function requestRoutePreview() {
  if (!state.destination) {
    setRouteStatus("Pick a destination first.");
    return;
  }
  const fix = state.latestSnapshot;
  const body = { destination: state.destination };
  if (fix?.fix_valid && Number.isFinite(Number(fix.lat_deg)) && Number.isFinite(Number(fix.lon_deg))) {
    body.start = { lat: Number(fix.lat_deg), lon: Number(fix.lon_deg) };
  }
  try {
    setRouteStatus("Requesting route from local OSRM…");
    const route = await apiPost("/api/route", body);
    state.currentRoutePayload = route;
    state.currentRouteMetrics = buildRouteMetrics(route.geometry?.coordinates || []);
    state.currentRouteSteps = normaliseRouteSteps(route);
    state.currentRouteStepIndex = 0;
    setText("routeDistance", formatDistance(Number(route.distance_m)));
    setText("routeDuration", formatDuration(Number(route.duration_s)));
    setText("routeMeta", "Preview loaded from current position to selected destination.");
    setRouteStatus("Preview ready. Confirm to start navigation.");
    renderStepList();
    syncOverlayData();
    fitGeometry(routeFeatureCollection(), { padding: { top: 180, right: 100, bottom: 110, left: 90 } });
    updateNavigationFromSnapshot(state.latestSnapshot, true);
    updateUiLayout();
  } catch (err) {
    console.error(err);
    setRouteStatus(`Route failed: ${err.message}`);
  }
}

function startNavSession() {
  state.navSession = {
    startTs: Date.now(),
    lastTs: null,
    lastRaw: null,
    sampleCount: 0,
    totalDistanceM: 0,
    maxSpeedMps: 0,
    speedSamples: [],
    movingSpeedSamples: [],
    plannedDistanceM: Number(state.currentRoutePayload?.distance_m || 0),
    destinationName: state.destination?.name || state.destination?.display_name || "Destination",
  };
}

function updateNavSessionSample(snapshot) {
  if (!state.navSession || !snapshot?.fix_valid || !Number.isFinite(Number(snapshot.lat_deg)) || !Number.isFinite(Number(snapshot.lon_deg))) {
    return;
  }
  const nowTs = Date.now();
  const raw = [Number(snapshot.lon_deg), Number(snapshot.lat_deg)];
  const speedMps = Number(snapshot.speed_mps);
  if (Number.isFinite(speedMps)) {
    state.navSession.maxSpeedMps = Math.max(state.navSession.maxSpeedMps, speedMps);
    state.navSession.speedSamples.push(speedMps);
    if (speedMps >= MOVING_SPEED_THRESHOLD_MPS) state.navSession.movingSpeedSamples.push(speedMps);
  }

  if (state.navSession.lastRaw && state.navSession.lastTs) {
    const dt = (nowTs - state.navSession.lastTs) / 1000;
    if (dt > 0.3) {
      const dist = haversineMeters(state.navSession.lastRaw[1], state.navSession.lastRaw[0], raw[1], raw[0]);
      if (Number.isFinite(dist) && dist < 300) state.navSession.totalDistanceM += dist;
    }
  }
  state.navSession.lastRaw = raw;
  state.navSession.lastTs = nowTs;
  state.navSession.sampleCount += 1;
}

function showCompletion(summary) {
  setText("completionTitle", summary.reason === "arrived" ? "Route complete" : "Route ended");
  setText("completionSubtitle", summary.destinationName || "Trip summary");
  setText("completionDriveTime", formatDuration(summary.driveTimeS));
  setText("completionAvgSpeed", fmtSpeed(summary.avgSpeedMps));
  setText("completionMovingAvgSpeed", fmtSpeed(summary.movingAvgSpeedMps));
  setText("completionMaxSpeed", fmtSpeed(summary.maxSpeedMps));
  setText("completionDistance", formatDistance(summary.distanceM));
  setText("completionPlannedDistance", formatDistance(summary.plannedDistanceM));
  setText("completionMeta", summary.metaText);
  $("completionPanel")?.classList.remove("hidden");
}

function finalizeNavSession(reason) {
  if (!state.navSession) return;
  const endTs = Date.now();
  const driveTimeS = Math.max(0, Math.round((endTs - state.navSession.startTs) / 1000));
  const distanceM = Number(state.navSession.totalDistanceM || 0);
  const avgSpeedMps = driveTimeS > 0 ? distanceM / driveTimeS : null;
  const moving = state.navSession.movingSpeedSamples;
  const movingAvgSpeedMps = moving.length
    ? moving.reduce((sum, val) => sum + val, 0) / moving.length
    : null;
  const metaText = `${reason === "arrived" ? "Arrived" : "Ended"} ${formatDuration(driveTimeS)} after guidance started.`;
  showCompletion({
    reason,
    destinationName: state.navSession.destinationName,
    driveTimeS,
    avgSpeedMps,
    movingAvgSpeedMps,
    maxSpeedMps: state.navSession.maxSpeedMps || null,
    distanceM,
    plannedDistanceM: state.navSession.plannedDistanceM || 0,
    metaText,
  });
  state.navSession = null;
}

function confirmRoute() {
  if (!state.currentRoutePayload) {
    setRouteStatus("Load a route preview first.");
    return;
  }
  state.navigationActive = true;
  state.followMode = true;
  startNavSession();
  setText("navStatus", "Guidance active.");
  updateNavigationFromSnapshot(state.latestSnapshot, true);
  updateUiLayout();
}

function showOverview() {
  if (state.currentRoutePayload) {
    fitGeometry(routeFeatureCollection(), { padding: { top: 180, right: 100, bottom: 110, left: 90 } });
  } else if (state.currentTripLine?.length) {
    fitGeometry(currentTripFeature(), { padding: { top: 180, right: 100, bottom: 110, left: 90 } });
  }
}

function computeFollowBearing(snapshot) {
  if (state.currentSnappedPosition && state.currentRouteMetrics) {
    const speedMps = Number(snapshot?.speed_mps);
    const lookaheadM = LOOKAHEAD_BASE_M + (Number.isFinite(speedMps) ? Math.min(speedMps * 7, 70) : 0);
    const pointA = [state.currentSnappedPosition.lon, state.currentSnappedPosition.lat];
    const pointB = pointAlongRoute(state.currentRouteMetrics, state.currentSnappedPosition.progressM + lookaheadM);
    const bearing = bearingBetween(pointA, pointB);
    if (Number.isFinite(bearing)) return bearing;
  }
  const course = Number(snapshot?.course_deg);
  return Number.isFinite(course) ? course : null;
}

function updateFollowCamera(snapshot, immediate = false) {
  if (!state.map || !state.followMode || !state.currentDisplayPosition) return;
  const center = [state.currentDisplayPosition.lon, state.currentDisplayPosition.lat];
  const bearing = computeFollowBearing(snapshot);
  const zoom = state.navigationActive ? 16.5 : 15.2;
  const payload = {
    center,
    zoom,
    pitch: state.navigationActive ? 48 : 26,
    duration: immediate ? 0 : 700,
  };
  if (Number.isFinite(bearing)) payload.bearing = bearing;
  state.map.easeTo(payload);
}

function updatePositionsFromSnapshot(snapshot) {
  if (snapshot?.fix_valid && Number.isFinite(Number(snapshot.lat_deg)) && Number.isFinite(Number(snapshot.lon_deg))) {
    state.currentRawPosition = {
      lat: Number(snapshot.lat_deg),
      lon: Number(snapshot.lon_deg),
      courseDeg: Number(snapshot.course_deg),
      speedMps: Number(snapshot.speed_mps),
    };
  } else {
    state.currentRawPosition = null;
  }

  state.currentSnappedPosition = null;
  state.currentDisplayPosition = state.currentRawPosition;

  if (state.currentRawPosition && state.currentRouteMetrics) {
    const snapped = snapPointToLineProgress([state.currentRawPosition.lon, state.currentRawPosition.lat], state.currentRouteMetrics);
    const threshold = snapThresholdForState(snapshot);
    if (snapped && snapped.distanceM <= threshold) {
      state.currentSnappedPosition = {
        lon: snapped.lon,
        lat: snapped.lat,
        progressM: snapped.progressM,
        distanceFromRawM: snapped.distanceM,
      };
      state.currentDisplayPosition = state.currentSnappedPosition;
      setText("diagReason", `snapped_on_route (${Math.round(snapped.distanceM)}m)`);
    } else if (snapped) {
      setText("diagReason", `raw_off_route (${Math.round(snapped.distanceM)}m)`);
    }
  }

  syncOverlayData();
}

function updateNavigationFromSnapshot(snapshot, immediateCamera = false) {
  updatePositionsFromSnapshot(snapshot);
  updateNavSessionSample(snapshot);

  if (!state.currentRoutePayload || !state.currentRouteMetrics) {
    updateUiLayout();
    return;
  }

  if (state.currentSnappedPosition) {
    const remainingM = Math.max(0, state.currentRouteMetrics.totalDistanceM - state.currentSnappedPosition.progressM);
    const totalDurationS = Number(state.currentRoutePayload.duration_s || 0);
    const remainingDurationS = state.currentRouteMetrics.totalDistanceM > 0
      ? totalDurationS * (remainingM / state.currentRouteMetrics.totalDistanceM)
      : 0;

    setText("remainingDistance", formatDistance(remainingM));
    setText("remainingEta", formatEtaFromNow(remainingDurationS));

    let consumed = 0;
    let activeIdx = state.currentRouteSteps.length ? state.currentRouteSteps.length - 1 : 0;
    for (let i = 0; i < state.currentRouteSteps.length; i += 1) {
      consumed += Number(state.currentRouteSteps[i].distance_m || 0);
      if (consumed >= state.currentSnappedPosition.progressM) {
        activeIdx = i;
        break;
      }
    }
    state.currentRouteStepIndex = activeIdx;
    renderStepList();

    const step = state.currentRouteSteps[activeIdx];
    const beforeStep = consumed - Number(step?.distance_m || 0);
    const distanceToStep = Math.max(0, (beforeStep + Number(step?.distance_m || 0)) - state.currentSnappedPosition.progressM);

    setText("nextInstruction", step ? (step.instruction || buildInstructionFromStep(step)) : "Continue");
    setText("nextDistance", step ? formatDistance(distanceToStep) : "—");
    setText("navStatus", state.navigationActive
      ? (state.currentSnappedPosition.distanceFromRawM > SNAP_OFFROUTE_M
        ? "Off route; using raw GPS."
        : "Following snapped route position.")
      : "Preview ready. Confirm to start guidance.");
    const limitText = step?.speed_limit && Array.isArray(step.speed_limit) && step.speed_limit.length
      ? step.speed_limit.join(", ")
      : "—";
    setSpeedLimitValue(limitText);

    if (state.navigationActive && remainingM <= ARRIVAL_THRESHOLD_M) {
      finalizeNavSession("arrived");
      clearRoute({ keepCompletion: true });
      return;
    }
  } else {
    setText("nextInstruction", state.navigationActive ? "Follow the route" : "Preview ready");
    setText("nextDistance", "—");
    setText("remainingDistance", formatDistance(Number(state.currentRoutePayload.distance_m)));
    setText("remainingEta", formatEtaFromNow(Number(state.currentRoutePayload.duration_s)));
    setText("navStatus", state.navigationActive
      ? "No route snap yet; using raw GPS position."
      : "Preview ready. Confirm to start guidance.");
    setSpeedLimitValue("—");
  }

  if (state.followMode && state.currentDisplayPosition) {
    updateFollowCamera(snapshot, immediateCamera);
  }
  updateUiLayout();
}

async function loadTripPoints(tripId) {
  if (!Number.isFinite(Number(tripId))) return;
  try {
    const payload = await apiGet(`/api/trips/${tripId}/points`);
    const points = payload.points || [];
    state.currentTripLine = points
      .filter((point) => Number.isFinite(Number(point.lon)) && Number.isFinite(Number(point.lat)))
      .map((point) => [Number(point.lon), Number(point.lat)]);
    state.lastLoadedTripId = tripId;
    syncOverlayData();
  } catch (err) {
    console.error(err);
  }
}

async function refreshTrips() {
  try {
    const payload = await apiGet("/api/trips");
    state.latestTrips = payload.trips || [];
    const activeTripId = payload.active_trip_id;
    if (activeTripId && activeTripId !== state.lastLoadedTripId) {
      await loadTripPoints(activeTripId);
    } else if (!activeTripId && state.latestTrips[0] && state.latestTrips[0].id !== state.lastLoadedTripId) {
      await loadTripPoints(state.latestTrips[0].id);
    }
  } catch (err) {
    console.error(err);
  }
}

function pushFixToTrip(lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  state.currentTripLine = state.currentTripLine || [];
  const last = state.currentTripLine[state.currentTripLine.length - 1];
  if (!last || haversineMeters(last[1], last[0], lat, lon) > 3) {
    state.currentTripLine.push([lon, lat]);
    syncOverlayData();
  }
}

async function tick() {
  try {
    const snapshot = await apiGet("/api/state");
    state.latestSnapshot = snapshot;

    setText("fixValue", snapshot.fix_valid ? (snapshot.fix_type_label || "Fix") : "No fix");
    setText("speedValue", fmtSpeed(Number(snapshot.speed_mps)));
    setText("satsValue", snapshot.sats_used ?? "—");
    setText("hdopValue", Number.isFinite(Number(snapshot.hdop)) ? Number(snapshot.hdop).toFixed(1) : "—");
    setText("ageValue", Number.isFinite(Number(snapshot.age_s)) ? `${Number(snapshot.age_s).toFixed(1)}s` : "—");
    setText("tripValue", snapshot.active_trip_id ? `#${snapshot.active_trip_id}` : "Idle");

    setText("diagFix", snapshot.fix_valid ? (snapshot.fix_type_label || "Fix") : "No fix");
    setText("diagSpeed", fmtSpeed(Number(snapshot.speed_mps)));
    setText("diagSats", snapshot.sats_used ?? "—");
    setText("diagHdop", Number.isFinite(Number(snapshot.hdop)) ? Number(snapshot.hdop).toFixed(1) : "—");
    setText("diagAge", Number.isFinite(Number(snapshot.age_s)) ? `${Number(snapshot.age_s).toFixed(1)}s` : "—");
    setText("diagTrip", snapshot.active_trip_id ? `#${snapshot.active_trip_id}` : "Idle");
    setText(
      "diagPosition",
      snapshot.fix_valid && Number.isFinite(Number(snapshot.lat_deg)) && Number.isFinite(Number(snapshot.lon_deg))
        ? `${Number(snapshot.lat_deg).toFixed(6)}, ${Number(snapshot.lon_deg).toFixed(6)}`
        : "—"
    );

    updateNavigationFromSnapshot(snapshot);
    if (snapshot.active_trip_id && snapshot.fix_valid && Number.isFinite(Number(snapshot.lat_deg)) && Number.isFinite(Number(snapshot.lon_deg))) {
      pushFixToTrip(Number(snapshot.lon_deg), Number(snapshot.lat_deg));
    }
  } catch (err) {
    console.error(err);
    setText("fixValue", "Error");
    setText("diagReason", err.message);
  }
}

function closeCompletionPanel() {
  $("completionPanel")?.classList.add("hidden");
}

function manualEndRoute() {
  if (state.navigationActive) finalizeNavSession("manual_end");
  clearRoute({ keepDestination: true, keepCompletion: true });
}

function bindUi() {
  $("searchBtn")?.addEventListener("click", performSearch);
  $("clearSearchBtn")?.addEventListener("click", () => {
    $("searchInput").value = "";
    renderSearchResults([], "");
    setSearchStatus("Search cleared.");
  });
  $("searchInput")?.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter") performSearch();
  });
  $("favoriteSelectedBtn")?.addEventListener("click", toggleSelectedFavorite);

  $("searchResults")?.addEventListener("click", async (evt) => {
    const pickBtn = evt.target.closest("[data-search-pick]");
    const favBtn = evt.target.closest("[data-search-favorite]");
    if (pickBtn) {
      const result = state.searchResults[Number(pickBtn.dataset.searchPick)];
      if (result) {
        setSelectedDestination(result);
        await requestRoutePreview();
      }
      return;
    }
    if (favBtn) {
      const result = state.searchResults[Number(favBtn.dataset.searchFavorite)];
      if (result) {
        try {
          if (isFavorite(result)) await apiDelete(`/api/places/favorites/${encodeURIComponent(result.id)}`);
          else await apiPost("/api/places/favorites", result);
          await loadPlaces();
          renderSearchResults(state.searchResults, $("searchInput")?.value?.trim() || "");
        } catch (err) {
          console.error(err);
        }
      }
    }
  });

  const savedListHandler = async (evt) => {
    const pickId = evt.target.closest("[data-pick-place]")?.dataset.pickPlace;
    const saveId = evt.target.closest("[data-save-favorite]")?.dataset.saveFavorite;
    const removeFavoriteId = evt.target.closest("[data-remove-favorite]")?.dataset.removeFavorite;
    if (pickId) {
      const place = [...state.places.favorites, ...state.places.history].find((item) => String(item.id) === String(pickId));
      if (place) {
        setSelectedDestination(place);
        await requestRoutePreview();
      }
    } else if (saveId) {
      const place = state.places.history.find((item) => String(item.id) === String(saveId));
      if (place) {
        await apiPost("/api/places/favorites", place);
        await loadPlaces();
      }
    } else if (removeFavoriteId) {
      await apiDelete(`/api/places/favorites/${encodeURIComponent(removeFavoriteId)}`);
      await loadPlaces();
    }
  };

  $("favoritesList")?.addEventListener("click", savedListHandler);
  $("historyList")?.addEventListener("click", savedListHandler);
  $("clearHistoryBtn")?.addEventListener("click", clearHistory);

  $("previewRouteBtn")?.addEventListener("click", requestRoutePreview);
  $("confirmRouteBtn")?.addEventListener("click", confirmRoute);
  $("clearRouteBtn")?.addEventListener("click", () => clearRoute());
  $("endRouteBtn")?.addEventListener("click", manualEndRoute);

  $("followBtn")?.addEventListener("click", () => {
    state.followMode = !state.followMode;
    if (state.followMode) updateFollowCamera(state.latestSnapshot, true);
    updateUiLayout();
  });
  $("overviewBtn")?.addEventListener("click", showOverview);
  $("stepsBtn")?.addEventListener("click", () => {
    state.stepsOpen = !state.stepsOpen;
    updateUiLayout();
  });
  $("closeStepsBtn")?.addEventListener("click", () => {
    state.stepsOpen = false;
    updateUiLayout();
  });

  $("toolsToggleBtn")?.addEventListener("click", () => {
    state.toolsOpen = !state.toolsOpen;
    updateUiLayout();
  });
  $("closeToolsBtn")?.addEventListener("click", () => {
    state.toolsOpen = false;
    updateUiLayout();
  });

  document.querySelectorAll(".btn-theme").forEach((btn) => {
    btn.addEventListener("click", () => applyTheme(btn.dataset.theme));
  });

  $("satelliteBtn")?.addEventListener("click", () => {
    if (!state.config?.satellite_tiles_url) return;
    state.satelliteVisible = !state.satelliteVisible;
    setMapStyle();
  });

  $("startBtn")?.addEventListener("click", async () => {
    try {
      const res = await apiPost("/api/trips/start", {});
      setSearchStatus(`Trip ${res.trip_id} started.`);
      await refreshTrips();
    } catch (err) {
      console.error(err);
    }
  });

  $("stopBtn")?.addEventListener("click", async () => {
    try {
      const res = await apiPost("/api/trips/stop", {});
      setSearchStatus(res.trip_id ? `Trip ${res.trip_id} stopped.` : "No active trip.");
      await refreshTrips();
    } catch (err) {
      console.error(err);
    }
  });

  $("csvBtn")?.addEventListener("click", () => {
    const tripId = state.latestTrips[0]?.id || state.latestSnapshot?.active_trip_id;
    if (tripId) download(`/api/trips/${tripId}/export.csv`);
  });
  $("gpxBtn")?.addEventListener("click", () => {
    const tripId = state.latestTrips[0]?.id || state.latestSnapshot?.active_trip_id;
    if (tripId) download(`/api/trips/${tripId}/export.gpx`);
  });
  $("kmlBtn")?.addEventListener("click", () => {
    const tripId = state.latestTrips[0]?.id || state.latestSnapshot?.active_trip_id;
    if (tripId) download(`/api/trips/${tripId}/export.kml`);
  });

  $("closeCompletionBtn")?.addEventListener("click", closeCompletionPanel);
}

(async function main() {
  state.theme = localStorage.getItem("vehitrack.theme") || "light";
  applyTheme(state.theme);
  bindUi();
  updateUiLayout();

  try {
    state.config = await apiGet("/api/ui-config");
    initMap();
    await Promise.all([loadPlaces(), refreshTrips()]);
    await tick();
    setInterval(tick, STATE_POLL_MS);
    setInterval(refreshTrips, TRIPS_POLL_MS);
  } catch (err) {
    console.error(err);
    setMapStatus(`Startup error: ${err.message}`);
    setSearchStatus(`Startup error: ${err.message}`);
  }
})();
