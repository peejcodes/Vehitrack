const THEMES = {
  light: {
    chrome: { bg: "#edf1f5", panel: "#ffffff", panel2: "#eef2f7", border: "#d7dee8", text: "#122033", muted: "#5f6d7d", accent: "#356fe6", accent2: "#4f86f7" },
    map: { background: "#f6f3ed", earth: "#ebe5d8", landuse: "#d7e8cb", water: "#9fcbff", boundaries: "#8d99a8", roads: "#ffffff", roadCasing: "#c6ccd4", placeText: "#1a2230", roadText: "#273142", halo: "#ffffff", trip: "#356fe6", route: "#356fe6", routeCasing: "#ffffff", position: "#ff6a3d" }
  },
  dark: {
    chrome: { bg: "#111418", panel: "#1a1f25", panel2: "#232a33", border: "#2f3742", text: "#eceff4", muted: "#a5afba", accent: "#6b7280", accent2: "#8b94a3" },
    map: { background: "#0f1419", earth: "#182129", landuse: "#1c2d22", water: "#173245", boundaries: "#6a7380", roads: "#7d8591", roadCasing: "#404954", placeText: "#f1f3f7", roadText: "#d9dee6", halo: "#0f1419", trip: "#56a5ff", route: "#56a5ff", routeCasing: "#cfe8ff", position: "#ff7e47" }
  },
  amethyst: {
    chrome: { bg: "#120f1d", panel: "#1b1528", panel2: "#251d37", border: "#3c2c62", text: "#eee9fb", muted: "#b3a7d0", accent: "#7734eb", accent2: "#9a6cff" },
    map: { background: "#120f1d", earth: "#1c1629", landuse: "#1f2134", water: "#271e4f", boundaries: "#7f76a2", roads: "#d7d1ea", roadCasing: "#5d4f82", placeText: "#f2eefe", roadText: "#e7ddff", halo: "#120f1d", trip: "#a883ff", route: "#7734eb", routeCasing: "#e9deff", position: "#c38cff" }
  }
};

let config = null;
let map = null;
let mapReady = false;
let tilejson = null;
let currentThemeName = "dark";
let satelliteVisible = false;
let satelliteAvailable = false;
let destinationMarker = null;
let destination = null;
let hasAutoCentered = false;
let lastTripForExport = null;
let activeTripId = null;
let currentActiveLine = [];
let currentRouteFeature = null;
let latestSnapshot = { state: null };
const GEO_SOURCE_ID = "vehitrack-overlays";

function $(id) { return document.getElementById(id); }
function setText(id, value) { const el = $(id); if (el) el.textContent = value; }
function getTheme() { return THEMES[currentThemeName] || THEMES.dark; }
function setMapStatus(message) { setText("mapStatus", message); }
function setSearchStatus(message) { setText("searchStatus", message); }
function setRouteStatus(message) { setText("routeStatus", message); }
function speedToMph(speedMps) { return speedMps * 2.2369362920544; }
function formatLatLon(lat, lon) { return lat == null || lon == null ? "Position: —" : `Position: ${lat.toFixed(6)}, ${lon.toFixed(6)}`; }
function escapeHtml(text) { return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }

function formatDistance(meters) {
  if (meters == null || Number.isNaN(Number(meters))) return "—";
  const miles = Number(meters) / 1609.344;
  if (miles >= 10) return `${miles.toFixed(1)} mi`;
  return `${miles.toFixed(2)} mi`;
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "—";
  const total = Math.round(Number(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function applyChromeTheme(theme) {
  const root = document.documentElement;
  root.style.setProperty("--bg", theme.chrome.bg);
  root.style.setProperty("--panel", theme.chrome.panel);
  root.style.setProperty("--panel-2", theme.chrome.panel2);
  root.style.setProperty("--border", theme.chrome.border);
  root.style.setProperty("--text", theme.chrome.text);
  root.style.setProperty("--muted", theme.chrome.muted);
  root.style.setProperty("--accent", theme.chrome.accent);
  root.style.setProperty("--accent-2", theme.chrome.accent2);
  document.body.className = `theme-${currentThemeName}`;
}

function updateThemeButtons() {
  document.querySelectorAll("[data-theme]").forEach((button) => button.classList.toggle("active", button.dataset.theme === currentThemeName));
  const satelliteBtn = $("satelliteBtn");
  if (!satelliteBtn) return;
  if (!satelliteAvailable) {
    satelliteBtn.textContent = "Satellite N/A";
    satelliteBtn.disabled = true;
    satelliteBtn.classList.remove("active");
    return;
  }
  satelliteBtn.disabled = false;
  satelliteBtn.textContent = satelliteVisible ? "Satellite On" : "Satellite Off";
  satelliteBtn.classList.toggle("active", satelliteVisible);
}

function updateRouteButtons() {
  const routeBtn = $("routeBtn");
  const clearBtn = $("clearRouteBtn");
  if (routeBtn) routeBtn.disabled = !destination;
  if (clearBtn) clearBtn.disabled = !currentRouteFeature;
}

async function apiGet(url) {
  const response = await fetch(url);
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      if (payload && payload.detail) detail = String(payload.detail);
    } catch (_) {}
    throw new Error(detail);
  }
  return response.json();
}

async function apiPost(url, payload = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body && body.detail) detail = String(body.detail);
    } catch (_) {}
    throw new Error(detail);
  }
  return response.json();
}

function buildOverlayData(snapshot) {
  const features = [];
  if (currentRouteFeature) features.push(currentRouteFeature);
  if (Array.isArray(currentActiveLine) && currentActiveLine.length >= 2) {
    features.push({ type: "Feature", geometry: { type: "LineString", coordinates: currentActiveLine }, properties: { kind: "trip" } });
  }
  const st = snapshot?.state;
  if (st?.fix_valid && st.lat_deg != null && st.lon_deg != null) {
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [st.lon_deg, st.lat_deg] }, properties: { kind: "position" } });
  }
  return { type: "FeatureCollection", features };
}

function createBaseLayers(theme) {
  const layers = [];
  if (satelliteAvailable && satelliteVisible) {
    layers.push({ id: "satellite", type: "raster", source: "satellite" });
  } else {
    layers.push(
      { id: "background", type: "background", paint: { "background-color": theme.map.background } },
      { id: "earth", type: "fill", source: "protomaps", "source-layer": "earth", paint: { "fill-color": theme.map.earth } },
      { id: "landuse", type: "fill", source: "protomaps", "source-layer": "landuse", paint: { "fill-color": theme.map.landuse } },
      { id: "water", type: "fill", source: "protomaps", "source-layer": "water", paint: { "fill-color": theme.map.water } }
    );
  }
  layers.push(
    { id: "boundaries", type: "line", source: "protomaps", "source-layer": "boundaries", paint: { "line-color": theme.map.boundaries, "line-width": 0.8 } },
    { id: "roads-casing", type: "line", source: "protomaps", "source-layer": "roads", paint: { "line-color": theme.map.roadCasing, "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1, 10, 2, 14, 4, 15, 6] } },
    { id: "roads", type: "line", source: "protomaps", "source-layer": "roads", paint: { "line-color": theme.map.roads, "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.5, 10, 1, 14, 2, 15, 3] } },
    { id: "place-labels", type: "symbol", source: "protomaps", "source-layer": "places", minzoom: 3, layout: { "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-font": ["Noto Sans Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 3, 10, 6, 12, 10, 14] }, paint: { "text-color": theme.map.placeText, "text-halo-color": theme.map.halo, "text-halo-width": 1.5 } },
    { id: "road-labels", type: "symbol", source: "protomaps", "source-layer": "roads", minzoom: 12, layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-font": ["Noto Sans Regular"], "text-size": 11 }, paint: { "text-color": theme.map.roadText, "text-halo-color": theme.map.halo, "text-halo-width": 1.5 } }
  );
  return layers;
}

function buildStyle(theme) {
  const sources = {
    protomaps: {
      type: "vector",
      tiles: tilejson.tiles,
      minzoom: tilejson.minzoom,
      maxzoom: tilejson.maxzoom
    }
  };
  if (satelliteAvailable) {
    sources.satellite = {
      type: "raster",
      tiles: [config.satellite_tiles_url],
      tileSize: Number(config.satellite_tile_size || 256),
      minzoom: Number(config.satellite_minzoom || 0),
      maxzoom: Number(config.satellite_maxzoom || 19),
      attribution: config.satellite_attribution || ""
    };
  }
  return {
    version: 8,
    glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sources,
    layers: createBaseLayers(theme)
  };
}

function ensureOverlays(snapshot = null) {
  if (!map || !map.getStyle()) return;
  const theme = getTheme();
  const data = buildOverlayData(snapshot || latestSnapshot);
  if (!map.getSource(GEO_SOURCE_ID)) {
    map.addSource(GEO_SOURCE_ID, { type: "geojson", data });
  } else {
    map.getSource(GEO_SOURCE_ID).setData(data);
  }
  if (!map.getLayer("route-casing")) {
    map.addLayer({
      id: "route-casing",
      type: "line",
      source: GEO_SOURCE_ID,
      filter: ["==", ["get", "kind"], "route"],
      paint: { "line-color": theme.map.routeCasing, "line-width": 7, "line-opacity": 0.95 }
    });
  } else {
    map.setPaintProperty("route-casing", "line-color", theme.map.routeCasing);
  }
  if (!map.getLayer("route-line")) {
    map.addLayer({
      id: "route-line",
      type: "line",
      source: GEO_SOURCE_ID,
      filter: ["==", ["get", "kind"], "route"],
      paint: { "line-color": theme.map.route, "line-width": 4, "line-opacity": 0.98 }
    });
  } else {
    map.setPaintProperty("route-line", "line-color", theme.map.route);
  }
  if (!map.getLayer("trip-line")) {
    map.addLayer({
      id: "trip-line",
      type: "line",
      source: GEO_SOURCE_ID,
      filter: ["==", ["get", "kind"], "trip"],
      paint: { "line-color": theme.map.trip, "line-width": 3, "line-opacity": 0.65 }
    });
  } else {
    map.setPaintProperty("trip-line", "line-color", theme.map.trip);
  }
  if (!map.getLayer("position-dot")) {
    map.addLayer({
      id: "position-dot",
      type: "circle",
      source: GEO_SOURCE_ID,
      filter: ["==", ["get", "kind"], "position"],
      paint: { "circle-radius": 6, "circle-color": theme.map.position, "circle-stroke-color": theme.map.halo, "circle-stroke-width": 2 }
    });
  } else {
    map.setPaintProperty("position-dot", "circle-color", theme.map.position);
    map.setPaintProperty("position-dot", "circle-stroke-color", theme.map.halo);
  }
}

function applyDestinationMarker() {
  if (!map || !destination) return;
  if (destinationMarker) {
    destinationMarker.remove();
    destinationMarker = null;
  }
  const el = document.createElement("div");
  el.className = "destination-marker";
  el.style.background = getTheme().chrome.accent;
  destinationMarker = new maplibregl.Marker({ element: el }).setLngLat([destination.lon, destination.lat]).addTo(map);
}

function resetRouteUi(message = "Select a destination to build a route.") {
  setRouteStatus(message);
  setText("routeDistance", "—");
  setText("routeDuration", "—");
  setText("routeMeta", "Current GPS position → selected destination.");
  updateRouteButtons();
}

function clearRoute() {
  currentRouteFeature = null;
  if (map && mapReady) ensureOverlays();
  resetRouteUi(destination ? "Route cleared. Destination still selected." : "Select a destination to build a route.");
}

function setSelectedDestination(result) {
  destination = result;
  setText("selectedDestination", `Destination: ${result.label}`);
  updateRouteButtons();
  if (map) {
    applyDestinationMarker();
    map.flyTo({ center: [result.lon, result.lat], zoom: Math.max(map.getZoom(), 14) });
  }
}

function renderSearchResults(results) {
  const wrap = $("searchResults");
  wrap.innerHTML = "";
  if (!results.length) {
    const empty = document.createElement("div");
    empty.className = "muted small";
    empty.textContent = "No results.";
    wrap.appendChild(empty);
    return;
  }
  for (const result of results) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "result-item";
    button.innerHTML = `<div class="result-name">${escapeHtml(result.name || result.label)}</div><div class="result-address">${escapeHtml(result.label)}</div>`;
    button.addEventListener("click", async () => {
      setSelectedDestination(result);
      setSearchStatus("Destination selected.");
      await requestRoute();
    });
    wrap.appendChild(button);
  }
}

async function performSearch() {
  const query = $("searchInput").value.trim();
  if (query.length < 2) { setSearchStatus("Enter at least 2 characters."); return; }
  setSearchStatus("Searching local Nominatim…");
  $("searchBtn").disabled = true;
  try {
    const payload = await apiGet(`/api/search?q=${encodeURIComponent(query)}&limit=8`);
    renderSearchResults(payload.results || []);
    setSearchStatus(`${payload.count || 0} result(s).`);
  } catch (error) {
    console.error(error);
    setSearchStatus(`Search failed: ${error.message || error}`);
  } finally {
    $("searchBtn").disabled = false;
  }
}

function fitGeometry(geometry) {
  if (!map || !geometry || geometry.type !== "LineString" || !Array.isArray(geometry.coordinates) || !geometry.coordinates.length) return;
  const bounds = new maplibregl.LngLatBounds(geometry.coordinates[0], geometry.coordinates[0]);
  for (const coord of geometry.coordinates) bounds.extend(coord);
  map.fitBounds(bounds, { padding: 48, duration: 700, maxZoom: 15 });
}

async function requestRoute() {
  if (!destination) {
    setRouteStatus("Select a destination first.");
    updateRouteButtons();
    return;
  }
  const routeBtn = $("routeBtn");
  if (routeBtn) routeBtn.disabled = true;
  setRouteStatus("Requesting local OSRM route…");
  try {
    const payload = await apiPost("/api/route", {
      destination: {
        lat: destination.lat,
        lon: destination.lon,
        label: destination.label,
        name: destination.name
      }
    });
    currentRouteFeature = {
      type: "Feature",
      geometry: payload.geometry,
      properties: { kind: "route" }
    };
    setText("routeDistance", formatDistance(payload.distance_m));
    setText("routeDuration", formatDuration(payload.duration_s));
    const originName = payload.origin?.name || "road";
    const destName = payload.destination?.name || "destination road";
    setText("routeMeta", `Snapped from ${originName} to ${destName}.`);
    setRouteStatus(`Route ready${payload.steps?.length ? ` • ${payload.steps.length} step(s)` : ""}.`);
    if (map && mapReady) {
      ensureOverlays();
      fitGeometry(payload.geometry);
    }
  } catch (error) {
    console.error(error);
    currentRouteFeature = null;
    if (map && mapReady) ensureOverlays();
    resetRouteUi(`Routing failed: ${error.message || error}`);
  } finally {
    updateRouteButtons();
  }
}

async function setMapStyle() {
  mapReady = false;
  setMapStatus("Applying map style…");
  map.setStyle(buildStyle(getTheme()));
}

async function initMap() {
  config = await apiGet("/api/ui-config");
  satelliteAvailable = Boolean(config.satellite_tiles_url);
  updateThemeButtons();
  updateRouteButtons();
  if (!config.vector_tilejson_url) throw new Error("vector_tilejson_url is not configured");
  tilejson = await apiGet(config.vector_tilejson_url);
  map = new maplibregl.Map({
    container: "map",
    style: buildStyle(getTheme()),
    center: [-78.18618, 39.08809],
    zoom: 13
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.on("load", () => {
    mapReady = true;
    ensureOverlays();
    if (destination) applyDestinationMarker();
    setMapStatus(satelliteAvailable ? "Vector map ready. Satellite toggle available." : "Vector map ready. Satellite tiles not configured.");
  });
  map.on("styledata", () => {
    if (!map || !map.isStyleLoaded()) return;
    mapReady = true;
    ensureOverlays();
    if (destination) applyDestinationMarker();
    setMapStatus(satelliteAvailable ? "Theme applied. Satellite toggle available." : "Theme applied. Satellite tiles not configured.");
  });
  map.on("error", (event) => {
    const error = event && event.error ? event.error : event;
    console.error("Map error", error);
    setMapStatus(`Map error: ${error?.message || error}`);
  });
}

async function refreshTrips() {
  const data = await apiGet("/api/trips");
  activeTripId = data.active_trip_id;
  const trips = Array.isArray(data.trips) ? data.trips : [];
  lastTripForExport = activeTripId ?? (trips.length ? trips[0].id : null);
  setText("tripv", activeTripId ? `#${activeTripId}` : "—");
  if (activeTripId) {
    const ptsPayload = await apiGet(`/api/trips/${activeTripId}/points`);
    const pts = Array.isArray(ptsPayload.points) ? ptsPayload.points : [];
    currentActiveLine = pts.filter((p) => p.lon_deg != null && p.lat_deg != null).map((p) => [p.lon_deg, p.lat_deg]);
  } else {
    currentActiveLine = [];
  }
  if (map && mapReady) ensureOverlays();
}

async function tick() {
  const snap = await apiGet("/api/state");
  latestSnapshot = snap;
  const st = snap.state || {};
  setText("fixv", st.fix_valid ? `3D (${st.fix_type || 0})` : "No fix");
  setText("speedv", st.speed_mps == null ? "—" : `${speedToMph(st.speed_mps).toFixed(1)} mph`);
  setText("satsv", st.sats_used == null ? "—" : String(st.sats_used));
  setText("hdopv", st.hdop == null ? "—" : Number(st.hdop).toFixed(2));
  setText("agev", snap.age_s == null ? "—" : `${Number(snap.age_s).toFixed(1)} s`);
  setText("reasonv", `Reason: ${snap.update_reason || "—"}`);
  setText("posv", formatLatLon(st.lat_deg, st.lon_deg));
  if (map && mapReady) {
    ensureOverlays(snap);
    if (!hasAutoCentered && st.fix_valid && st.lat_deg != null && st.lon_deg != null) {
      map.jumpTo({ center: [st.lon_deg, st.lat_deg], zoom: Math.max(map.getZoom(), 14) });
      hasAutoCentered = true;
    }
  }
}

function download(url) { window.location.href = url; }

function bindUi() {
  $("searchForm").addEventListener("submit", async (event) => { event.preventDefault(); await performSearch(); });
  $("routeBtn").addEventListener("click", async () => { await requestRoute(); });
  $("clearRouteBtn").addEventListener("click", () => { clearRoute(); });
  $("startBtn").addEventListener("click", async () => { await apiPost("/api/trips/start", { name: "Trip" }); await refreshTrips(); });
  $("stopBtn").addEventListener("click", async () => { await apiPost("/api/trips/stop"); await refreshTrips(); });
  $("csvBtn").addEventListener("click", () => { if (lastTripForExport) download(`/api/trips/${lastTripForExport}/export.csv`); });
  $("gpxBtn").addEventListener("click", () => { if (lastTripForExport) download(`/api/trips/${lastTripForExport}/export.gpx`); });
  $("kmlBtn").addEventListener("click", () => { if (lastTripForExport) download(`/api/trips/${lastTripForExport}/export.kml`); });
  document.querySelectorAll("[data-theme]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextTheme = button.dataset.theme;
      if (!nextTheme || nextTheme === currentThemeName) return;
      currentThemeName = nextTheme;
      applyChromeTheme(getTheme());
      updateThemeButtons();
      if (map) setMapStyle();
      if (destinationMarker) {
        destinationMarker.remove();
        destinationMarker = null;
      }
    });
  });
  $("satelliteBtn").addEventListener("click", () => {
    if (!satelliteAvailable || !map) return;
    satelliteVisible = !satelliteVisible;
    updateThemeButtons();
    setMapStyle();
  });
}

(async function main() {
  applyChromeTheme(getTheme());
  updateThemeButtons();
  updateRouteButtons();
  bindUi();
  try {
    await initMap();
  } catch (error) {
    console.error(error);
    setMapStatus(String(error));
  }
  try {
    await refreshTrips();
    await tick();
  } catch (error) {
    console.error(error);
  }
  setInterval(async () => { try { await tick(); } catch (error) { console.error(error); } }, 750);
  setInterval(async () => { try { await refreshTrips(); } catch (error) { console.error(error); } }, 3000);
})();
