let activeTripId = null;
let lastTripForExport = null;

// Optional Leaflet wiring (if you vendor it offline later)
let map = null, marker = null, polyline = null;
function leafletAvailable() { return typeof window.L !== "undefined"; }

function initMapIfPossible() {
  if (!leafletAvailable()) return;

  map = L.map("map", { zoomControl: false });
  L.tileLayer("/tiles/{z}/{x}/{y}.png", { maxZoom: 18, minZoom: 1 }).addTo(map);

  marker = L.circleMarker([0, 0], { radius: 8 });
  marker.addTo(map);

  polyline = L.polyline([], {});
  polyline.addTo(map);

  map.setView([37.0, -122.0], 12); // placeholder start
}

async function apiGet(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return await r.json();
}

async function apiPost(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}"
  });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return await r.json();
}

function fmtSpeed(mps) {
  if (mps == null) return "—";
  const mph = mps * 2.2369362920544;
  return `${mph.toFixed(1)} mph`;
}

function setText(id, v) { document.getElementById(id).textContent = v; }

async function refreshTrips() {
  const t = await apiGet("/api/trips");
  activeTripId = t.active_trip_id;
  lastTripForExport = activeTripId || (t.trips && t.trips.length ? t.trips[0].id : null);
  setText("tripv", activeTripId ? `#${activeTripId}` : "no");
}

async function tick() {
  const snap = await apiGet("/api/state");
  const st = snap.state;

  setText("fixv", st.fix_valid ? `OK (mode ${st.fix_type})` : `NO (mode ${st.fix_type})`);
  setText("speedv", fmtSpeed(st.speed_mps));
  setText("satsv", st.sats_used == null ? "—" : String(st.sats_used));
  setText("hdopv", st.hdop == null ? "—" : st.hdop.toFixed(1));
  setText("agev", `${snap.age_s.toFixed(1)}s`);
  setText("posv", (st.lat_deg && st.lon_deg) ? `${st.lat_deg.toFixed(6)}, ${st.lon_deg.toFixed(6)}` : "—");
  setText("reasonv", snap.update_reason || "—");

  if (leafletAvailable() && map && st.lat_deg != null && st.lon_deg != null) {
    const ll = [st.lat_deg, st.lon_deg];
    marker.setLatLng(ll);
    if (!map._movedOnce) map.setView(ll, 15);
    if (activeTripId && st.fix_valid) {
      polyline.addLatLng(ll);
    }
  }
}

document.getElementById("startBtn").addEventListener("click", async () => {
  await apiPost("/api/trips/start", { name: "Trip" });
  await refreshTrips();
});

document.getElementById("stopBtn").addEventListener("click", async () => {
  await apiPost("/api/trips/stop");
  await refreshTrips();
});

function download(url) { window.location.href = url; }

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

(async function main() {
  initMapIfPossible();
  await refreshTrips();
  await tick();
  setInterval(async () => {
    try { await tick(); } catch (e) { /* ignore */ }
  }, 500);
  setInterval(async () => {
    try { await refreshTrips(); } catch (e) { /* ignore */ }
  }, 3000);
})();