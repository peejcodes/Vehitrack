from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from typing import Optional, Any, Dict, List, Tuple
from urllib.parse import urlencode
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

import uvicorn
from fastapi import FastAPI, Response, HTTPException, Query
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from vehitrack.core.models import FixState, now_utc
from vehitrack.core.filters import JumpRejector, FilterConfig
from vehitrack.gps.gpsd import GpsdClient, GpsdConfig
from vehitrack.store.sqlite_store import SqliteStore, LoggingConfig
from vehitrack.store.exporters import export_csv, export_gpx, export_kml
from vehitrack.store.tiles import Mbtiles


@dataclass
class Settings:
    host: str = "0.0.0.0"
    port: int = 8080
    gpsd_host: str = "127.0.0.1"
    gpsd_port: int = 2947
    db_path: str = "/var/lib/vehitrack/vehitrack.sqlite"
    raw_fixes: bool = False
    min_time_s: float = 1.0
    min_distance_m: float = 7.0
    max_speed_mps: float = 90.0
    mbtiles_path: Optional[str] = None
    vector_tilejson_url: Optional[str] = None
    satellite_tiles_url: Optional[str] = None
    satellite_attribution: str = ""
    satellite_minzoom: int = 0
    satellite_maxzoom: int = 19
    satellite_tile_size: int = 256
    nominatim_url: str = "http://127.0.0.1:7070"
    nominatim_timeout_s: float = 8.0
    osrm_url: str = "http://127.0.0.1:5001"
    osrm_timeout_s: float = 8.0

    @staticmethod
    def from_env() -> "Settings":
        s = Settings()
        s.host = os.getenv("VEHITRACK_HOST", s.host)
        s.port = int(os.getenv("VEHITRACK_PORT", str(s.port)))
        s.gpsd_host = os.getenv("VEHITRACK_GPSD_HOST", s.gpsd_host)
        s.gpsd_port = int(os.getenv("VEHITRACK_GPSD_PORT", str(s.gpsd_port)))
        s.db_path = os.getenv("VEHITRACK_DB_PATH", s.db_path)
        s.raw_fixes = os.getenv("VEHITRACK_RAW_FIXES", str(s.raw_fixes)).lower() in ("1", "true", "yes")
        s.min_time_s = float(os.getenv("VEHITRACK_MIN_TIME_S", str(s.min_time_s)))
        s.min_distance_m = float(os.getenv("VEHITRACK_MIN_DISTANCE_M", str(s.min_distance_m)))
        s.max_speed_mps = float(os.getenv("VEHITRACK_MAX_SPEED_MPS", str(s.max_speed_mps)))
        s.mbtiles_path = os.getenv("VEHITRACK_MBTILES", s.mbtiles_path)
        s.vector_tilejson_url = os.getenv("VEHITRACK_VECTOR_TILEJSON_URL", s.vector_tilejson_url)
        s.satellite_tiles_url = os.getenv("VEHITRACK_SATELLITE_TILES_URL", s.satellite_tiles_url)
        s.satellite_attribution = os.getenv("VEHITRACK_SATELLITE_ATTRIBUTION", s.satellite_attribution)
        s.satellite_minzoom = int(os.getenv("VEHITRACK_SATELLITE_MINZOOM", str(s.satellite_minzoom)))
        s.satellite_maxzoom = int(os.getenv("VEHITRACK_SATELLITE_MAXZOOM", str(s.satellite_maxzoom)))
        s.satellite_tile_size = int(os.getenv("VEHITRACK_SATELLITE_TILE_SIZE", str(s.satellite_tile_size)))
        s.nominatim_url = os.getenv("VEHITRACK_NOMINATIM_URL", s.nominatim_url).rstrip("/")
        s.nominatim_timeout_s = float(os.getenv("VEHITRACK_NOMINATIM_TIMEOUT_S", str(s.nominatim_timeout_s)))
        s.osrm_url = os.getenv("VEHITRACK_OSRM_URL", s.osrm_url).rstrip("/")
        s.osrm_timeout_s = float(os.getenv("VEHITRACK_OSRM_TIMEOUT_S", str(s.osrm_timeout_s)))
        return s


class StateHub:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._state: FixState = FixState(ts_utc=now_utc(), fix_valid=False, source="boot")
        self._last_update_reason: str = "boot"
        self._rejected_count: int = 0
        self._accepted_count: int = 0
        self._last_log_written: bool = False

    async def set(self, st: FixState, reason: str, logged: bool, rejected_count: int, accepted_count: int) -> None:
        async with self._lock:
            self._state = st
            self._last_update_reason = reason
            self._last_log_written = logged
            self._rejected_count = rejected_count
            self._accepted_count = accepted_count

    async def get_snapshot(self) -> Dict[str, Any]:
        async with self._lock:
            age_s = max(0.0, now_utc().timestamp() - self._state.ts_utc.timestamp())
            return {
                "state": self._state.to_jsonable(),
                "age_s": age_s,
                "update_reason": self._last_update_reason,
                "accepted": self._accepted_count,
                "rejected": self._rejected_count,
                "logged_last": self._last_log_written,
            }


settings = Settings.from_env()
app = FastAPI(title="vehitrack", version="0.1.0")
hub = StateHub()
rejector = JumpRejector(FilterConfig(max_speed_mps=settings.max_speed_mps))
store = SqliteStore(
    LoggingConfig(
        db_path=settings.db_path,
        raw_fixes=settings.raw_fixes,
        min_time_s=settings.min_time_s,
        min_distance_m=settings.min_distance_m,
    )
)
mb: Optional[Mbtiles] = Mbtiles(settings.mbtiles_path) if settings.mbtiles_path else None


def _read_json_url(url: str, timeout_s: float) -> Any:
    req = Request(url, headers={"Accept": "application/json", "User-Agent": "vehitrack/0.1"})
    with urlopen(req, timeout=timeout_s) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _nominatim_search(q: str, limit: int) -> List[Dict[str, Any]]:
    params = urlencode({"q": q, "format": "jsonv2", "addressdetails": 1, "limit": max(1, min(limit, 10))})
    url = f"{settings.nominatim_url}/search?{params}"
    payload = _read_json_url(url, settings.nominatim_timeout_s)

    results: List[Dict[str, Any]] = []
    for item in payload if isinstance(payload, list) else []:
        try:
            lat_f = float(item.get("lat"))
            lon_f = float(item.get("lon"))
        except (TypeError, ValueError):
            continue
        results.append(
            {
                "label": item.get("display_name") or item.get("name") or "Unnamed result",
                "name": item.get("name") or item.get("display_name") or "Unnamed result",
                "lat": lat_f,
                "lon": lon_f,
                "osm_type": item.get("osm_type"),
                "osm_id": item.get("osm_id"),
                "class": item.get("class") or item.get("category"),
                "type": item.get("type"),
                "address": item.get("address") or {},
                "raw": item,
            }
        )
    return results


def _osrm_json(path_and_query: str) -> Any:
    url = f"{settings.osrm_url}{path_and_query}"
    return _read_json_url(url, settings.osrm_timeout_s)


def _osrm_nearest(lon: float, lat: float) -> Dict[str, Any]:
    payload = _osrm_json(f"/nearest/v1/driving/{lon},{lat}?number=1")
    if not isinstance(payload, dict) or payload.get("code") != "Ok":
        raise RuntimeError(f"OSRM nearest failed: {payload}")
    waypoints = payload.get("waypoints") or []
    if not waypoints:
        raise RuntimeError("OSRM nearest returned no waypoints")
    return waypoints[0]


def _simplify_steps(route_payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    simplified: List[Dict[str, Any]] = []
    for leg in route_payload.get("legs") or []:
        for step in leg.get("steps") or []:
            maneuver = step.get("maneuver") or {}
            simplified.append(
                {
                    "name": step.get("name") or "",
                    "distance_m": step.get("distance"),
                    "duration_s": step.get("duration"),
                    "mode": step.get("mode"),
                    "driving_side": step.get("driving_side"),
                    "maneuver": {
                        "type": maneuver.get("type"),
                        "modifier": maneuver.get("modifier"),
                        "instruction": maneuver.get("instruction"),
                        "bearing_before": maneuver.get("bearing_before"),
                        "bearing_after": maneuver.get("bearing_after"),
                        "location": maneuver.get("location"),
                    },
                }
            )
    return simplified


def _route_between(origin: Tuple[float, float], destination: Tuple[float, float], destination_label: str | None = None) -> Dict[str, Any]:
    origin_lon, origin_lat = origin
    dest_lon, dest_lat = destination

    snapped_origin = _osrm_nearest(origin_lon, origin_lat)
    snapped_destination = _osrm_nearest(dest_lon, dest_lat)

    so_lon, so_lat = snapped_origin["location"]
    sd_lon, sd_lat = snapped_destination["location"]

    payload = _osrm_json(
        f"/route/v1/driving/{so_lon},{so_lat};{sd_lon},{sd_lat}?steps=true&geometries=geojson&overview=full"
    )
    if not isinstance(payload, dict):
        raise RuntimeError("OSRM route returned invalid payload")
    if payload.get("code") != "Ok":
        raise RuntimeError(f"OSRM route failed: {payload.get('code')}")
    routes = payload.get("routes") or []
    if not routes:
        raise RuntimeError("OSRM returned no routes")

    route = routes[0]
    geometry = route.get("geometry")
    if not geometry:
        raise RuntimeError("OSRM route returned no geometry")

    return {
        "origin_input": {"lon": origin_lon, "lat": origin_lat},
        "destination_input": {"lon": dest_lon, "lat": dest_lat, "label": destination_label or ""},
        "origin": {
            "lon": so_lon,
            "lat": so_lat,
            "name": snapped_origin.get("name") or "",
            "distance_from_input_m": snapped_origin.get("distance"),
        },
        "destination": {
            "lon": sd_lon,
            "lat": sd_lat,
            "name": snapped_destination.get("name") or "",
            "distance_from_input_m": snapped_destination.get("distance"),
            "label": destination_label or "",
        },
        "distance_m": route.get("distance"),
        "duration_s": route.get("duration"),
        "weight": route.get("weight"),
        "geometry": geometry,
        "steps": _simplify_steps(route),
        "raw_waypoints": payload.get("waypoints") or [],
    }


@app.on_event("startup")
async def _startup() -> None:
    async def on_fix(fix: FixState) -> None:
        ok, reason = rejector.consider(fix)
        if not ok:
            snap = await hub.get_snapshot()
            last = snap["state"]
            await hub.set(
                st=FixState(
                    ts_utc=now_utc(),
                    lat_deg=last.get("lat_deg"),
                    lon_deg=last.get("lon_deg"),
                    alt_m=last.get("alt_m"),
                    speed_mps=last.get("speed_mps"),
                    course_deg=last.get("course_deg"),
                    fix_valid=bool(last.get("fix_valid")),
                    fix_type=int(last.get("fix_type") or 0),
                    sats_used=last.get("sats_used"),
                    hdop=last.get("hdop"),
                    source="gpsd(reject-kept-last)",
                ),
                reason=reason,
                logged=False,
                rejected_count=rejector.rejected_count,
                accepted_count=snap.get("accepted", 0),
            )
            return

        logged = await asyncio.to_thread(store.maybe_log_fix, fix)
        snap = await hub.get_snapshot()
        await hub.set(
            st=fix,
            reason=reason,
            logged=logged,
            rejected_count=rejector.rejected_count,
            accepted_count=snap.get("accepted", 0) + 1,
        )

    cfg = GpsdConfig(host=settings.gpsd_host, port=settings.gpsd_port)
    app.state.gps_task = asyncio.create_task(GpsdClient(cfg, on_fix).run_forever())


@app.on_event("shutdown")
async def _shutdown() -> None:
    try:
        app.state.gps_task.cancel()
    except Exception:
        pass
    try:
        store.close()
    except Exception:
        pass
    try:
        if mb:
            mb.close()
    except Exception:
        pass


ui_dir = os.path.join(os.path.dirname(__file__), "..", "ui")
ui_dir = os.path.abspath(ui_dir)
app.mount("/static", StaticFiles(directory=ui_dir), name="static")


@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    with open(os.path.join(ui_dir, "index.html"), "r", encoding="utf-8") as f:
        return f.read()


@app.get("/api/state")
async def api_state() -> Dict[str, Any]:
    return await hub.get_snapshot()


@app.get("/api/ui-config")
async def api_ui_config() -> Dict[str, Any]:
    return {
        "vector_tilejson_url": settings.vector_tilejson_url,
        "satellite_tiles_url": settings.satellite_tiles_url,
        "satellite_attribution": settings.satellite_attribution,
        "satellite_minzoom": settings.satellite_minzoom,
        "satellite_maxzoom": settings.satellite_maxzoom,
        "satellite_tile_size": settings.satellite_tile_size,
        "nominatim_url": settings.nominatim_url,
    }


@app.get("/api/search")
async def api_search(q: str = Query(..., min_length=2), limit: int = Query(8, ge=1, le=10)) -> Dict[str, Any]:
    q = q.strip()
    if len(q) < 2:
        raise HTTPException(status_code=400, detail="Query too short")
    try:
        results = await asyncio.to_thread(_nominatim_search, q, limit)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Nominatim search failed: {exc}")
    return {"query": q, "count": len(results), "results": results}


@app.post("/api/route")
async def api_route(payload: Dict[str, Any]) -> Dict[str, Any]:
    destination = payload.get("destination") or {}
    try:
        dest_lat = float(destination.get("lat"))
        dest_lon = float(destination.get("lon"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Destination lat/lon are required")

    snap = await hub.get_snapshot()
    st = snap.get("state") or {}
    if not st.get("fix_valid") or st.get("lat_deg") is None or st.get("lon_deg") is None:
        raise HTTPException(status_code=409, detail="No valid current GPS fix available for routing")

    try:
        origin = (float(st["lon_deg"]), float(st["lat_deg"]))
        result = await asyncio.to_thread(
            _route_between,
            origin,
            (dest_lon, dest_lat),
            str(destination.get("label") or destination.get("name") or ""),
        )
    except HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"OSRM HTTP error: {exc.code}")
    except URLError as exc:
        raise HTTPException(status_code=502, detail=f"OSRM connection failed: {exc.reason}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OSRM route failed: {exc}")

    return result


@app.get("/api/trips")
async def trips_list() -> Dict[str, Any]:
    return {"active_trip_id": store.active_trip_id(), "trips": store.list_trips()}


@app.post("/api/trips/start")
async def trips_start(payload: Dict[str, Any] | None = None) -> Dict[str, Any]:
    payload = payload or {}
    tid = await asyncio.to_thread(store.start_trip, payload.get("name"), payload.get("notes"))
    return {"active_trip_id": tid}


@app.post("/api/trips/stop")
async def trips_stop() -> Dict[str, Any]:
    tid = await asyncio.to_thread(store.stop_trip)
    return {"stopped_trip_id": tid, "active_trip_id": store.active_trip_id()}


@app.get("/api/trips/{trip_id}/points")
async def trips_points(trip_id: int, limit: Optional[int] = None) -> Dict[str, Any]:
    pts = await asyncio.to_thread(store.trip_points, trip_id, limit)
    return {"trip_id": trip_id, "points": pts}


@app.get("/api/trips/{trip_id}/export.csv")
async def trips_export_csv(trip_id: int) -> Response:
    pts = await asyncio.to_thread(store.trip_points, trip_id, None)
    if not pts:
        raise HTTPException(status_code=404, detail="No points")
    data = export_csv(pts)
    return Response(
        content=data,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="trip_{trip_id}.csv"'},
    )


@app.get("/api/trips/{trip_id}/export.gpx")
async def trips_export_gpx(trip_id: int) -> Response:
    pts = await asyncio.to_thread(store.trip_points, trip_id, None)
    if not pts:
        raise HTTPException(status_code=404, detail="No points")
    data = export_gpx(pts, name=f"Trip {trip_id}")
    return Response(
        content=data,
        media_type="application/gpx+xml",
        headers={"Content-Disposition": f'attachment; filename="trip_{trip_id}.gpx"'},
    )


@app.get("/api/trips/{trip_id}/export.kml")
async def trips_export_kml(trip_id: int) -> Response:
    pts = await asyncio.to_thread(store.trip_points, trip_id, None)
    if not pts:
        raise HTTPException(status_code=404, detail="No points")
    data = export_kml(pts, name=f"Trip {trip_id}")
    return Response(
        content=data,
        media_type="application/vnd.google-earth.kml+xml",
        headers={"Content-Disposition": f'attachment; filename="trip_{trip_id}.kml"'},
    )


@app.get("/tiles/{z}/{x}/{y}.png")
async def tiles_png(z: int, x: int, y: int) -> Response:
    if not mb:
        raise HTTPException(status_code=404, detail="Tiles not configured")
    blob = await asyncio.to_thread(mb.tile, z, x, y)
    if blob is None:
        raise HTTPException(status_code=404, detail="Tile not found")
    return Response(content=blob, media_type="image/png")


@app.get("/health", response_class=HTMLResponse)
async def health() -> str:
    snap = await hub.get_snapshot()
    st = snap["state"]
    age = snap["age_s"]
    mph = None if st.get("speed_mps") is None else float(st["speed_mps"]) * 2.2369362920544
    active = store.active_trip_id()
    return f"""
    <html><body>
    <h2>vehitrack</h2>
    <pre>
fix_valid      {st.get("fix_valid")}
fix_type       {st.get("fix_type")}
lat, lon       {st.get("lat_deg")}, {st.get("lon_deg")}
speed          {st.get("speed_mps")} m/s {f"({mph:.1f} mph)" if mph is not None else ""}
course         {st.get("course_deg")}°
sats_used      {st.get("sats_used")}
hdop           {st.get("hdop")}
age            {age:.2f}s
update_reason  {snap.get("update_reason")}
trip_active    {active if active else "no"}
logged_last    {snap.get("logged_last")}
    </pre>
    <p><a href="/">Open UI</a></p>
    </body></html>
    """


def main() -> None:
    uvicorn.run("vehitrack.api.app:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    main()
