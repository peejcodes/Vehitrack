let activeTripId = null;
let lastTripForExport = null;
let lastKnownTripId = null;
let lastLoggedFixKey = null;
let hasCenteredOnFix = false;

let map = null;
let mapReady = false;
let mapConfig = null;
let basemapTileJson = null;
let satelliteAvailable = false;
let satelliteVisible = false;
let currentThemeName = "light";

let currentPosition = null;
let tripCoordinates = [];

const DEFAULT_VIEW = {
  center: [-98.5795, 39.8283],
  zoom: 4,
};

const THEMES = {
  light: {
    label: "Light",
    panelBg: "#0f0f10",
    panelBorder: "#222222",
    panelText: "#f1f1f1",
    tileBg: "#141417",
    tileBorder: "#2a2a2c",
    subText: "#b9bcc4",
    buttonBg: "#1a1a1d",
    buttonBorder: "#2a2a2c",
    buttonText: "#ffffff",
    buttonActiveBg: "#2d6df6",
    buttonActiveBorder: "#5b8cff",
    buttonActiveText: "#ffffff",
    fallbackBg: "#111214",
    fallbackBorder: "#2a2a2c",
    mapBackground: "#f2efe9",
    earth: "#e6e0d6",
    landuse: "#d7e7c2",
    water: "#9ec9ff",
    boundaries: "#8f949c",
    roads: "#ffffff",
    placeText: "#1f2328",
    roadText: "#3a4048",
    textHalo: "#ffffff",
    routeLine: "#2d6df6",
    routeHalo: "#ffffff",
    positionFill: "#2d6df6",
    positionStroke: "#ffffff",
  },
  dark: {
    label: "Dark",
    panelBg: "#0c0e11",
    panelBorder: "#1d2127",
    panelText: "#edf1f7",
    tileBg: "#11151a",
    tileBorder: "#222933",
    subText: "#aeb7c4",
    buttonBg: "#151a21",
    buttonBorder: "#27303a",
    buttonText: "#edf1f7",
    buttonActiveBg: "#3a78ff",
    buttonActiveBorder: "#70a0ff",
    buttonActiveText: "#ffffff",
    fallbackBg: "#10141a",
    fallbackBorder: "#27303a",
    mapBackground: "#101418",
    earth: "#182029",
    landuse: "#1d2b23",
    water: "#20384f",
    boundaries: "#718091",
    roads: "#7f8791",
    placeText: "#f1f4f8",
    roadText: "#e0e5ec",
    textHalo: "#101418",
    routeLine: "#59a1ff",
    routeHalo: "#101418",
    positionFill: "#59a1ff",
    positionStroke: "#dfe7f2",
  },
  amethyst: {
    label: "Amethyst",
    panelBg: "#0c0916",
    panelBorder: "#241d38",
    panelText: "#f4efff",
    tileBg: "#151125",
    tileBorder: "#2f2550",
    subText: "#c9bfec",
    buttonBg: "#171128",
    buttonBorder: "#372a61",
    buttonText: "#f4efff",
    buttonActiveBg: "#7734eb",
    buttonActiveBorder: "#a27cff",
    buttonActiveText: "#ffffff",
    fallbackBg: "#130f22",
    fallbackBorder: "#372a61",
    mapBackground: "#0d0a16",
    earth: "#161127",
    landuse: "#1d1533",
    water: "#211b3d",
    boundaries: "#8e7bc7",
    roads: "#b296ff",
    placeText: "#f4efff",
    roadText: "#dccfff",
    textHalo: "#0d0a16",
    routeLine: "#7734eb",
    routeHalo: "#0d0a16",
    positionFill: "#7734eb",
    positionStroke: "#efe7ff",
  },
};

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setMapStatus(message) {
  setText("mapStatus", message);
}

function fmtSpeed(mps) {
  if (mps == null) return "—";
  const mph = mps * 2.2369362920544;
  return `${mph.toFixed(1)} mph`;
}

function getTheme() {
  return THEMES[currentThemeName] || THEMES.light;
}

async function apiGet(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return await response.json();
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return await response.json();
}

function download(url) {
  window.location.href = url;
}

function buildStyle(theme, tilejson, config, satVisible) {
  const style = {
    version: 8,
    glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sources: {
      basemap: {
        type: "vector",
        tiles: tilejson.tiles,
        minzoom: tilejson.minzoom,
        maxzoom: tilejson.maxzoom,
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": theme.mapBackground },
      },
      {
        id: "earth",
        type: "fill",
        source: "basemap",
        "source-layer": "earth",
        paint: { "fill-color": theme.earth },
      },
      {
        id: "landuse",
        type: "fill",
        source: "basemap",
        "source-layer": "landuse",
        paint: { "fill-color": theme.landuse },
      },
      {
        id: "water",
        type: "fill",
        source: "basemap",
        "source-layer": "water",
        paint: { "fill-color": theme.water },
      },
      {
        id: "boundaries",
        type: "line",
        source: "basemap",
        "source-layer": "boundaries",
        paint: {
          "line-color": theme.boundaries,
          "line-width": 1,
        },
      },
      {
        id: "roads",
        type: "line",
        source: "basemap",
        "source-layer": "roads",
        paint: {
          "line-color": theme.roads,
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            5, 0.5,
            10, 1.2,
            14, 2.4,
            15, 3.2,
          ],
        },
      },
      {
        id: "place-labels",
        type: "symbol",
        source: "basemap",
        "source-layer": "places",
        minzoom: 3,
        layout: {
          "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
          "text-font": ["Noto Sans Regular"],
          "text-size": [
            "interpolate", ["linear"], ["zoom"],
            3, 10,
            6, 12,
            10, 14,
          ],
        },
        paint: {
          "text-color": theme.placeText,
          "text-halo-color": theme.textHalo,
          "text-halo-width": 1.5,
        },
      },
      {
        id: "road-labels",
        type: "symbol",
        source: "basemap",
        "source-layer": "roads",
        minzoom: 12,
        layout: {
          "symbol-placement": "line",
          "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
        },
        paint: {
          "text-color": theme.roadText,
          "text-halo-color": theme.textHalo,
          "text-halo-width": 1.25,
        },
      },
    ],
  };

  if (config.satellite_tiles_url) {
    style.sources.satellite = {
      type: "raster",
      tiles: [config.satellite_tiles_url],
      tileSize: Number(config.satellite_tile_size || 256),
      minzoom: Number(config.satellite_minzoom || 0),
      maxzoom: Number(config.satellite_maxzoom || 19),
      attribution: config.satellite_attribution || "",
    };

    style.layers.splice(1, 0, {
      id: "satellite",
      type: "raster",
      source: "satellite",
      layout: {
        visibility: satVisible ? "visible" : "none",
      },
      paint: {
        "raster-opacity": satVisible ? 1 : 0,
      },
    });
  }

  return style;
}

function applyChromeTheme(theme) {
  const root = document.documentElement;
  root.style.setProperty("--panel-bg", theme.panelBg);
  root.style.setProperty("--panel-border", theme.panelBorder);
  root.style.setProperty("--panel-text", theme.panelText);
  root.style.setProperty("--tile-bg", theme.tileBg);
  root.style.setProperty("--tile-border", theme.tileBorder);
  root.style.setProperty("--sub-text", theme.subText);
  root.style.setProperty("--button-bg", theme.buttonBg);
  root.style.setProperty("--button-border", theme.buttonBorder);
  root.style.setProperty("--button-text", theme.buttonText);
  root.style.setProperty("--button-active-bg", theme.buttonActiveBg);
  root.style.setProperty("--button-active-border", theme.buttonActiveBorder);
  root.style.setProperty("--button-active-text", theme.buttonActiveText);
  root.style.setProperty("--fallback-bg", theme.fallbackBg);
  root.style.setProperty("--fallback-border", theme.fallbackBorder);
}

function updateThemeButtons() {
  const themeButtons = document.querySelectorAll("[data-theme]");
  for (const button of themeButtons) {
    const isActive = button.dataset.theme === currentThemeName;
    button.dataset.active = isActive ? "true" : "false";
  }

  const satelliteBtn = document.getElementById("satelliteBtn");
  if (satelliteBtn) {
    satelliteBtn.textContent = satelliteAvailable
      ? (satelliteVisible ? "Satellite On" : "Satellite Off")
      : "Satellite N/A";
    satelliteBtn.disabled = !satelliteAvailable;
    satelliteBtn.dataset.active = satelliteVisible ? "true" : "false";
  }
}

function currentPositionFeature() {
  return {
    type: "FeatureCollection",
    features: currentPosition
      ? [{
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: currentPosition,
          },
          properties: {},
        }]
      : [],
  };
}

function currentTripFeature() {
  return {
    type: "FeatureCollection",
    features: tripCoordinates.length >= 2
      ? [{
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: tripCoordinates,
          },
          properties: {},
        }]
      : [],
  };
}

function ensureOverlayLayers() {
  if (!map || !map.getStyle()) return;

  const theme = getTheme();

  if (!map.getSource("vehitrack-trip")) {
    map.addSource("vehitrack-trip", {
      type: "geojson",
      data: currentTripFeature(),
    });
  }

  if (!map.getLayer("vehitrack-trip-line")) {
    map.addLayer({
      id: "vehitrack-trip-line",
      type: "line",
      source: "vehitrack-trip",
      paint: {
        "line-color": theme.routeLine,
        "line-width": [
          "interpolate", ["linear"], ["zoom"],
          5, 2,
          10, 3,
          15, 5,
        ],
        "line-opacity": 0.95,
      },
    });
  }

  if (!map.getSource("vehitrack-position")) {
    map.addSource("vehitrack-position", {
      type: "geojson",
      data: currentPositionFeature(),
    });
  }

  if (!map.getLayer("vehitrack-position-dot")) {
    map.addLayer({
      id: "vehitrack-position-dot",
      type: "circle",
      source: "vehitrack-position",
      paint: {
        "circle-radius": 7,
        "circle-color": theme.positionFill,
        "circle-stroke-width": 2,
        "circle-stroke-color": theme.positionStroke,
      },
    });
  }
}

function refreshOverlayStyle() {
  if (!map || !mapReady) return;
  const theme = getTheme();

  if (map.getLayer("vehitrack-trip-line")) {
    map.setPaintProperty("vehitrack-trip-line", "line-color", theme.routeLine);
  }

  if (map.getLayer("vehitrack-position-dot")) {
    map.setPaintProperty("vehitrack-position-dot", "circle-color", theme.positionFill);
    map.setPaintProperty("vehitrack-position-dot", "circle-stroke-color", theme.positionStroke);
  }
}

function syncOverlayData() {
  if (!map || !mapReady) return;

  const tripSource = map.getSource("vehitrack-trip");
  if (tripSource) {
    tripSource.setData(currentTripFeature());
  }

  const positionSource = map.getSource("vehitrack-position");
  if (positionSource) {
    positionSource.setData(currentPositionFeature());
  }
}

function setMapStyle() {
  if (!map || !basemapTileJson || !mapConfig) return;
  map.setStyle(buildStyle(getTheme(), basemapTileJson, mapConfig, satelliteVisible));
}

async function loadTripPoints(tripId) {
  if (!tripId) {
    tripCoordinates = [];
    syncOverlayData();
    return;
  }

  try {
    const payload = await apiGet(`/api/trips/${tripId}/points`);
    const points = payload.points || [];
    tripCoordinates = points
      .filter((p) => p.lat_deg != null && p.lon_deg != null)
      .map((p) => [p.lon_deg, p.lat_deg]);
    if (tripCoordinates.length) {
      const last = tripCoordinates[tripCoordinates.length - 1];
      currentPosition = last;
    }
    syncOverlayData();
  } catch (error) {
    console.error("Failed to load trip points", error);
  }
}

async function refreshTrips() {
  const tripPayload = await apiGet("/api/trips");
  const previousTripId = activeTripId;
  activeTripId = tripPayload.active_trip_id;
  lastTripForExport = activeTripId || (tripPayload.trips && tripPayload.trips.length ? tripPayload.trips[0].id : null);
  setText("tripv", activeTripId ? `#${activeTripId}` : "no");

  if (activeTripId !== previousTripId) {
    lastKnownTripId = activeTripId;
    lastLoggedFixKey = null;
    await loadTripPoints(activeTripId);
  }
}

function pushFixToTrip(lon, lat) {
  const key = `${lon.toFixed(6)},${lat.toFixed(6)}`;
  if (key === lastLoggedFixKey) return;
  lastLoggedFixKey = key;
  tripCoordinates.push([lon, lat]);
  syncOverlayData();
}

async function tick() {
  const snapshot = await apiGet("/api/state");
  const state = snapshot.state;

  setText("fixv", state.fix_valid ? `OK (mode ${state.fix_type})` : `NO (mode ${state.fix_type})`);
  setText("speedv", fmtSpeed(state.speed_mps));
  setText("satsv", state.sats_used == null ? "—" : String(state.sats_used));
  setText("hdopv", state.hdop == null ? "—" : state.hdop.toFixed(1));
  setText("agev", `${snapshot.age_s.toFixed(1)}s`);
  setText("posv", (state.lat_deg != null && state.lon_deg != null) ? `${state.lat_deg.toFixed(6)}, ${state.lon_deg.toFixed(6)}` : "—");
  setText("reasonv", snapshot.update_reason || "—");

  if (map && state.lat_deg != null && state.lon_deg != null) {
    currentPosition = [state.lon_deg, state.lat_deg];
    syncOverlayData();

    if (!hasCenteredOnFix) {
      map.jumpTo({ center: currentPosition, zoom: 15 });
      hasCenteredOnFix = true;
    }

    if (activeTripId && state.fix_valid) {
      pushFixToTrip(state.lon_deg, state.lat_deg);
    }
  }
}

async function initMap() {
  if (typeof window.maplibregl === "undefined") {
    setMapStatus("MapLibre failed to load.");
    return;
  }

  mapConfig = await apiGet("/api/ui-config");
  satelliteAvailable = Boolean(mapConfig.satellite_tiles_url);
  updateThemeButtons();

  if (!mapConfig.vector_tilejson_url) {
    setMapStatus("Vector tiles are not configured.");
    return;
  }

  const tileResponse = await fetch(mapConfig.vector_tilejson_url);
  if (!tileResponse.ok) {
    throw new Error(`TileJSON ${tileResponse.status}`);
  }
  basemapTileJson = await tileResponse.json();

  map = new maplibregl.Map({
    container: "map",
    style: buildStyle(getTheme(), basemapTileJson, mapConfig, satelliteVisible),
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
  });

  map.addControl(new maplibregl.NavigationControl(), "top-right");

  map.on("style.load", () => {
    mapReady = true;
    ensureOverlayLayers();
    syncOverlayData();
    refreshOverlayStyle();
    setMapStatus(
      satelliteAvailable
        ? "Vector map ready. Satellite toggle available."
        : "Vector map ready. Satellite tiles not configured."
    );
  });

  map.on("error", (event) => {
    console.error("Map error", event && event.error ? event.error : event);
  });
}

function bindUi() {
  document.getElementById("startBtn").addEventListener("click", async () => {
    await apiPost("/api/trips/start", { name: "Trip" });
    await refreshTrips();
  });

  document.getElementById("stopBtn").addEventListener("click", async () => {
    await apiPost("/api/trips/stop");
    await refreshTrips();
  });

  document.getElementById("csvBtn").addEventListener("click", () => {
    if (!lastTripForExport) return;
    download(`/api/trips/${lastTripForExport}/export.csv`);
  });

  document.getElementById("gpxBtn").addEventListener("click", () => {
    if (!lastTripForExport) return;
    download(`/api/trips/${lastTripForExport}/export.gpx`);
  });

  document.getElementById("kmlBtn").addEventListener("click", () => {
    if (!lastTripForExport) return;
    download(`/api/trips/${lastTripForExport}/export.kml`);
  });

  document.querySelectorAll("[data-theme]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextTheme = button.dataset.theme;
      if (!nextTheme || nextTheme === currentThemeName) return;
      currentThemeName = nextTheme;
      applyChromeTheme(getTheme());
      updateThemeButtons();
      if (map) {
        mapReady = false;
        setMapStyle();
      }
    });
  });

  document.getElementById("satelliteBtn").addEventListener("click", () => {
    if (!satelliteAvailable || !map || !map.getLayer("satellite")) return;
    satelliteVisible = !satelliteVisible;
    map.setLayoutProperty("satellite", "visibility", satelliteVisible ? "visible" : "none");
    map.setPaintProperty("satellite", "raster-opacity", satelliteVisible ? 1 : 0);
    updateThemeButtons();
  });
}

(async function main() {
  applyChromeTheme(getTheme());
  updateThemeButtons();
  bindUi();

  try {
    await initMap();
  } catch (error) {
    console.error(error);
    setMapStatus(String(error));
  }

  await refreshTrips();
  await tick();

  setInterval(async () => {
    try {
      await tick();
    } catch (error) {
      console.error(error);
    }
  }, 500);

  setInterval(async () => {
    try {
      await refreshTrips();
    } catch (error) {
      console.error(error);
    }
  }, 3000);
})();
