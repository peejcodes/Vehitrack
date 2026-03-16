from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field
from datetime import timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import requests
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from vehitrack.core.filters import FilterConfig, JumpRejector
from vehitrack.core.geo import haversine_m
from vehitrack.core.models import FixState, now_utc
from vehitrack.gps.gpsd import GpsdClient
from vehitrack.store.sqlite_store import LoggingConfig, SqliteStore

APP_DIR = Path(__file__).resolve().parent
PKG_DIR = APP_DIR.parent
UI_DIR = PKG_DIR / "ui"


@dataclass
class Settings:
    db_path: str = os.getenv("VEHITRACK_DB_PATH", "./vehitrack.sqlite")
    vector_tilejson_url: str = os.getenv(
        "VEHITRACK_VECTOR_TILEJSON_URL",
        "http://127.0.0.1:8090/usa_z15.json",
    )
    nominatim_url: str = os.getenv("VEHITRACK_NOMINATIM_URL", "http://127.0.0.1:7070")
    osrm_url: str = os.getenv("VEHITRACK_OSRM_URL", "http://127.0.0.1:5001")
    satellite_tiles_url: str = os.getenv("VEHITRACK_SATELLITE_TILES_URL", "")
    places_store_path: str = os.getenv("VEHITRACK_PLACES_STORE_PATH", "")
    osrm_timeout_s: float = float(os.getenv("VEHITRACK_OSRM_TIMEOUT_S", "12"))
    nominatim_timeout_s: float = float(os.getenv("VEHITRACK_NOMINATIM_TIMEOUT_S", "8"))
    log_raw_fixes: bool = os.getenv("VEHITRACK_LOG_RAW_FIXES", "").lower() in {"1", "true", "yes"}
    log_min_time_s: float = float(os.getenv("VEHITRACK_LOG_MIN_TIME_S", "1.0"))
    log_min_distance_m: float = float(os.getenv("VEHITRACK_LOG_MIN_DISTANCE_M", "7.0"))
    max_jump_speed_mps: float = float(os.getenv("VEHITRACK_MAX_JUMP_SPEED_MPS", "90.0"))

    def resolved_places_store_path(self) -> Path:
        if self.places_store_path:
            return Path(self.places_store_path).expanduser().resolve()
        db_path = Path(self.db_path).expanduser().resolve()
        return db_path.with_name("vehitrack_places.json")


SETTINGS = Settings()


@dataclass
class StateHub:
    current_fix: FixState = field(default_factory=lambda: FixState(ts_utc=now_utc()))
    last_good_fix: Optional[FixState] = None
    update_reason: str = "startup"
    rejected_count: int = 0

    def update(self, fix: FixState, reason: str, accepted: bool) -> None:
        self.current_fix = fix
        self.update_reason = reason
        if fix.fix_valid and fix.lat_deg is not None and fix.lon_deg is not None and accepted:
            self.last_good_fix = fix

    def as_jsonable(self, active_trip_id: Optional[int]) -> Dict[str, Any]:
        fix = self.current_fix
        age_s = max(0.0, (now_utc() - fix.ts_utc).total_seconds())
        payload = fix.to_jsonable()
        payload.update(
            {
                "age_s": round(age_s, 3),
                "update_reason": self.update_reason,
                "rejected_count": self.rejected_count,
                "active_trip_id": active_trip_id,
            }
        )
        return payload


class PlacesStore:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._state = {"favorites": [], "history": []}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            self._flush()
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                self._state["favorites"] = list(data.get("favorites") or [])
                self._state["history"] = list(data.get("history") or [])
        except Exception:
            self._state = {"favorites": [], "history": []}
            self._flush()

    def _flush(self) -> None:
        self.path.write_text(json.dumps(self._state, indent=2), encoding="utf-8")

    @staticmethod
    def _normalise_place(place: Dict[str, Any]) -> Dict[str, Any]:
        lat = place.get("lat")
        lon = place.get("lon")
        try:
            lat = float(lat) if lat is not None else None
            lon = float(lon) if lon is not None else None
        except Exception:
            lat = None
            lon = None

        display_name = (
            place.get("display_name")
            or place.get("name")
            or place.get("label")
            or "Saved place"
        )
        source = place.get("source") or "local"
        place_id = (
            str(place.get("id"))
            if place.get("id") is not None
            else str(place.get("place_id") or "")
        )
        if not place_id:
            place_id = f"{display_name}|{lat}|{lon}"

        return {
            "id": place_id,
            "place_id": place.get("place_id"),
            "name": place.get("name") or display_name.split(",")[0].strip(),
            "display_name": display_name,
            "lat": lat,
            "lon": lon,
            "type": place.get("type"),
            "class": place.get("class"),
            "source": source,
            "address": place.get("address") or {},
        }

    def list(self) -> Dict[str, Any]:
        return {
            "favorites": list(self._state["favorites"]),
            "history": list(self._state["history"]),
            "path": str(self.path),
        }

    def add_history(self, place: Dict[str, Any], max_items: int = 25) -> Dict[str, Any]:
        record = self._normalise_place(place)
        items = [p for p in self._state["history"] if p.get("id") != record["id"]]
        items.insert(0, record)
        self._state["history"] = items[:max_items]
        self._flush()
        return record

    def clear_history(self) -> None:
        self._state["history"] = []
        self._flush()

    def add_favorite(self, place: Dict[str, Any]) -> Dict[str, Any]:
        record = self._normalise_place(place)
        items = [p for p in self._state["favorites"] if p.get("id") != record["id"]]
        items.insert(0, record)
        self._state["favorites"] = items
        self._flush()
        return record

    def delete_favorite(self, place_id: str) -> bool:
        before = len(self._state["favorites"])
        self._state["favorites"] = [p for p in self._state["favorites"] if str(p.get("id")) != str(place_id)]
        changed = len(self._state["favorites"]) != before
        if changed:
            self._flush()
        return changed


app = FastAPI(title="vehitrack", version="0.1.0")
app.mount("/static", StaticFiles(directory=str(UI_DIR)), name="static")

store: Optional[SqliteStore] = None
gps_client: Optional[GpsdClient] = None
jump_rejector = JumpRejector(FilterConfig(max_speed_mps=SETTINGS.max_jump_speed_mps))
state_hub = StateHub()
places_store = PlacesStore(SETTINGS.resolved_places_store_path())


def _to_iso_z(dt) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _coerce_fix_state(candidate: Any) -> Optional[FixState]:
    if candidate is None:
        return None
    if isinstance(candidate, FixState):
        return candidate

    if isinstance(candidate, dict):
        ts = candidate.get("ts_utc") or candidate.get("timestamp")
        if isinstance(ts, str):
            ts = ts.replace("Z", "+00:00")
            try:
                from datetime import datetime

                ts_dt = datetime.fromisoformat(ts)
            except Exception:
                ts_dt = now_utc()
        else:
            ts_dt = now_utc()

        def _f(name: str) -> Optional[float]:
            value = candidate.get(name)
            try:
                return float(value) if value is not None else None
            except Exception:
                return None

        def _i(name: str) -> Optional[int]:
            value = candidate.get(name)
            try:
                return int(value) if value is not None else None
            except Exception:
                return None

        return FixState(
            ts_utc=ts_dt,
            lat_deg=_f("lat_deg") if "lat_deg" in candidate else _f("lat"),
            lon_deg=_f("lon_deg") if "lon_deg" in candidate else _f("lon"),
            alt_m=_f("alt_m") if "alt_m" in candidate else _f("alt"),
            speed_mps=_f("speed_mps") if "speed_mps" in candidate else _f("speed"),
            course_deg=_f("course_deg") if "course_deg" in candidate else _f("course"),
            fix_valid=bool(candidate.get("fix_valid", False)),
            fix_type=int(candidate.get("fix_type") or candidate.get("mode") or 0),
            sats_used=_i("sats_used"),
            hdop=_f("hdop"),
            source=str(candidate.get("source") or "gps"),
        )

    attrs = {
        "ts_utc": getattr(candidate, "ts_utc", now_utc()),
        "lat_deg": getattr(candidate, "lat_deg", getattr(candidate, "lat", None)),
        "lon_deg": getattr(candidate, "lon_deg", getattr(candidate, "lon", None)),
        "alt_m": getattr(candidate, "alt_m", getattr(candidate, "alt", None)),
        "speed_mps": getattr(candidate, "speed_mps", getattr(candidate, "speed", None)),
        "course_deg": getattr(candidate, "course_deg", getattr(candidate, "course", None)),
        "fix_valid": bool(getattr(candidate, "fix_valid", False)),
        "fix_type": int(getattr(candidate, "fix_type", getattr(candidate, "mode", 0)) or 0),
        "sats_used": getattr(candidate, "sats_used", None),
        "hdop": getattr(candidate, "hdop", None),
        "source": str(getattr(candidate, "source", "gps")),
    }
    try:
        return FixState(**attrs)
    except Exception:
        return None


def _try_call(obj: Any, name: str) -> Any:
    member = getattr(obj, name, None)
    if member is None:
        return None
    if callable(member):
        return member()
    return member


def _poll_fix() -> FixState:
    if gps_client is None:
        return state_hub.current_fix

    candidate = None
    for name in ("snapshot", "latest_fix", "get_fix", "read_fix", "read", "last_fix"):
        try:
            candidate = _try_call(gps_client, name)
        except Exception:
            candidate = None
        fix = _coerce_fix_state(candidate)
        if fix is not None:
            candidate = fix
            break
        candidate = None

    fix = _coerce_fix_state(candidate)
    if fix is None:
        return state_hub.current_fix

    accepted, reason = jump_rejector.consider(fix)
    if accepted and store is not None:
        try:
            store.maybe_log_fix(fix)
        except Exception:
            pass
    state_hub.rejected_count = jump_rejector.rejected_count
    state_hub.update(fix=fix, reason=reason, accepted=accepted)
    return fix


def _search_rank(record: Dict[str, Any], query: str) -> tuple:
    label = str(record.get("display_name") or "").lower()
    query_lower = query.strip().lower()
    prefix_bonus = 0 if label.startswith(query_lower) else 1
    contains_bonus = 0 if query_lower and query_lower in label else 1
    distance = float(record.get("distance_m") or 1e12)
    importance = -float(record.get("importance") or 0.0)
    return (prefix_bonus, contains_bonus, distance, importance, label)


def _nominatim_search(
    query: str,
    limit: int = 8,
    near_lat: Optional[float] = None,
    near_lon: Optional[float] = None,
) -> Dict[str, Any]:
    if not query.strip():
        return {"query": query, "results": []}

    raw_limit = max(limit * 3, 18)
    params: Dict[str, Any] = {
        "q": query,
        "format": "jsonv2",
        "addressdetails": 1,
        "namedetails": 0,
        "limit": raw_limit,
    }
    bias = None
    if near_lat is not None and near_lon is not None:
        delta_lon = 0.30
        delta_lat = 0.22
        params["viewbox"] = f"{near_lon-delta_lon},{near_lat+delta_lat},{near_lon+delta_lon},{near_lat-delta_lat}"
        params["bounded"] = 0
        params["dedupe"] = 1
        bias = {
            "lat": near_lat,
            "lon": near_lon,
            "viewbox": params["viewbox"],
        }

    url = SETTINGS.nominatim_url.rstrip("/") + "/search"
    try:
        response = requests.get(
            url,
            params=params,
            headers={"Accept": "application/json"},
            timeout=SETTINGS.nominatim_timeout_s,
        )
        response.raise_for_status()
        rows = response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Nominatim search failed: {exc}") from exc

    results: List[Dict[str, Any]] = []
    for row in rows:
        try:
            lat = float(row.get("lat"))
            lon = float(row.get("lon"))
        except Exception:
            continue
        rec: Dict[str, Any] = {
            "id": str(row.get("place_id") or f"{lat},{lon}"),
            "place_id": row.get("place_id"),
            "osm_id": row.get("osm_id"),
            "osm_type": row.get("osm_type"),
            "lat": lat,
            "lon": lon,
            "display_name": row.get("display_name") or "",
            "name": (
                row.get("name")
                or (row.get("address") or {}).get("road")
                or (row.get("display_name") or "").split(",")[0].strip()
            ),
            "class": row.get("class"),
            "type": row.get("type"),
            "importance": row.get("importance"),
            "address": row.get("address") or {},
            "source": "nominatim",
        }
        if near_lat is not None and near_lon is not None:
            rec["distance_m"] = haversine_m(near_lat, near_lon, lat, lon)
        results.append(rec)

    results.sort(key=lambda item: _search_rank(item, query))
    return {
        "query": query,
        "bias": bias,
        "results": results[:limit],
        "total_candidates": len(results),
    }


def _build_instruction(step: Dict[str, Any]) -> str:
    maneuver = (step.get("maneuver") or {})
    kind = str(maneuver.get("type") or "continue")
    modifier = str(maneuver.get("modifier") or "").replace("_", " ").strip()
    road_name = str(step.get("name") or "").strip()

    if kind == "depart":
        base = "Head out"
    elif kind == "arrive":
        base = "Arrive at destination"
    elif kind == "roundabout":
        exit_n = maneuver.get("exit")
        base = f"At the roundabout, take exit {exit_n}" if exit_n else "At the roundabout, continue"
    elif kind == "merge":
        base = "Merge"
    elif kind == "on ramp":
        base = "Take the ramp"
    elif kind == "off ramp":
        base = "Take the exit"
    elif kind == "fork":
        base = "Keep"
    elif kind == "end of road":
        base = "At the end of the road, turn"
    elif kind == "turn":
        base = "Turn"
    else:
        base = "Continue"

    if modifier and kind not in {"roundabout", "arrive", "depart"}:
        base = f"{base} {modifier}".strip()

    if road_name:
        if base.lower().startswith("arrive"):
            return base
        return f"{base} onto {road_name}"
    return base


def _normalise_steps(legs: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    steps: List[Dict[str, Any]] = []
    for leg_idx, leg in enumerate(legs):
        for step_idx, step in enumerate(leg.get("steps") or []):
            maneuver = step.get("maneuver") or {}
            steps.append(
                {
                    "leg_index": leg_idx,
                    "step_index": step_idx,
                    "distance_m": float(step.get("distance") or 0.0),
                    "duration_s": float(step.get("duration") or 0.0),
                    "name": step.get("name") or "",
                    "mode": step.get("mode") or "driving",
                    "geometry": step.get("geometry"),
                    "maneuver": maneuver,
                    "instruction": _build_instruction(step),
                    "speed_limit": (step.get("intersections") or [{}])[0].get("classes"),
                }
            )
    return steps


def _request_osrm_route(
    start_lon: float,
    start_lat: float,
    end_lon: float,
    end_lat: float,
) -> Dict[str, Any]:
    base = SETTINGS.osrm_url.rstrip("/")
    url = (
        f"{base}/route/v1/driving/"
        f"{start_lon:.6f},{start_lat:.6f};{end_lon:.6f},{end_lat:.6f}"
    )
    params = {
        "overview": "full",
        "geometries": "geojson",
        "steps": "true",
        "annotations": "false",
    }
    try:
        response = requests.get(url, params=params, timeout=SETTINGS.osrm_timeout_s)
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OSRM route request failed: {exc}") from exc

    routes = payload.get("routes") or []
    if not routes:
        raise HTTPException(status_code=404, detail="No route found")

    route = routes[0]
    geometry = route.get("geometry") or {}
    coords = geometry.get("coordinates") or []
    if not coords:
        raise HTTPException(status_code=404, detail="Route geometry missing")

    legs = route.get("legs") or []
    steps = _normalise_steps(legs)
    return {
        "distance_m": float(route.get("distance") or 0.0),
        "duration_s": float(route.get("duration") or 0.0),
        "geometry": {
            "type": "LineString",
            "coordinates": coords,
        },
        "steps": steps,
        "waypoints": payload.get("waypoints") or [],
        "start": {"lat": start_lat, "lon": start_lon},
        "destination": {"lat": end_lat, "lon": end_lon},
    }


def _trip_points_geojson(points: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    coords = [[float(p["lon"]), float(p["lat"])] for p in points if p.get("lat") is not None and p.get("lon") is not None]
    return {
        "type": "FeatureCollection",
        "features": ([{"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": {}}] if len(coords) >= 2 else []),
    }


def _csv_export(points: Sequence[Dict[str, Any]]) -> str:
    lines = ["ts,lat,lon,alt,speed,course,hdop,sats_used"]
    for p in points:
        lines.append(
            ",".join(
                [
                    str(p.get("ts") or ""),
                    str(p.get("lat") or ""),
                    str(p.get("lon") or ""),
                    str(p.get("alt") or ""),
                    str(p.get("speed") or ""),
                    str(p.get("course") or ""),
                    str(p.get("hdop") or ""),
                    str(p.get("sats_used") or ""),
                ]
            )
        )
    return "\n".join(lines) + "\n"


def _gpx_export(points: Sequence[Dict[str, Any]], trip_name: str) -> str:
    segments = []
    for p in points:
        if p.get("lat") is None or p.get("lon") is None:
            continue
        ele = f"<ele>{p.get('alt')}</ele>" if p.get("alt") is not None else ""
        speed = f"<speed>{p.get('speed')}</speed>" if p.get("speed") is not None else ""
        time_val = f"<time>{p.get('ts')}</time>" if p.get("ts") else ""
        segments.append(
            f'<trkpt lat="{p["lat"]}" lon="{p["lon"]}">{ele}{speed}{time_val}</trkpt>'
        )
    seg_text = "".join(segments)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<gpx version="1.1" creator="vehitrack" xmlns="http://www.topografix.com/GPX/1/1">'
        f"<trk><name>{trip_name}</name><trkseg>{seg_text}</trkseg></trk>"
        "</gpx>"
    )


def _kml_export(points: Sequence[Dict[str, Any]], trip_name: str) -> str:
    coord_lines = []
    for p in points:
        if p.get("lat") is None or p.get("lon") is None:
            continue
        alt = p.get("alt") if p.get("alt") is not None else 0
        coord_lines.append(f'{p["lon"]},{p["lat"]},{alt}')
    coords = " ".join(coord_lines)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
        f"<name>{trip_name}</name>"
        f"<Placemark><name>{trip_name}</name><LineString><coordinates>{coords}</coordinates></LineString></Placemark>"
        "</Document></kml>"
    )


@app.on_event("startup")
def _startup() -> None:
    global store, gps_client
    db_path = Path(SETTINGS.db_path).expanduser().resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    store = SqliteStore(
        LoggingConfig(
            db_path=str(db_path),
            raw_fixes=SETTINGS.log_raw_fixes,
            min_time_s=SETTINGS.log_min_time_s,
            min_distance_m=SETTINGS.log_min_distance_m,
        )
    )
    try:
        gps_client = GpsdClient()
    except Exception:
        gps_client = None
        return

    for name in ("start", "open", "connect"):
        try:
            member = getattr(gps_client, name, None)
            if callable(member):
                member()
                break
        except Exception:
            continue


@app.on_event("shutdown")
def _shutdown() -> None:
    global store, gps_client
    if gps_client is not None:
        for name in ("stop", "close", "shutdown"):
            try:
                member = getattr(gps_client, name, None)
                if callable(member):
                    member()
                    break
            except Exception:
                continue
    if store is not None:
        try:
            store.close()
        except Exception:
            pass


@app.get("/")
def index() -> FileResponse:
    return FileResponse(UI_DIR / "index.html")


@app.get("/health")
def health() -> Dict[str, Any]:
    fix = _poll_fix()
    return {
        "ok": True,
        "gps_connected": gps_client is not None,
        "db_path": str(Path(SETTINGS.db_path).expanduser().resolve()),
        "places_store_path": str(places_store.path),
        "fix_valid": fix.fix_valid,
    }


@app.get("/api/ui-config")
def ui_config() -> Dict[str, Any]:
    return {
        "vector_tilejson_url": SETTINGS.vector_tilejson_url,
        "satellite_tiles_url": SETTINGS.satellite_tiles_url,
        "nominatim_url": SETTINGS.nominatim_url,
        "osrm_url": SETTINGS.osrm_url,
        "default_theme": "light",
    }


@app.get("/api/state")
def api_state() -> Dict[str, Any]:
    fix = _poll_fix()
    active_trip_id = store.active_trip_id() if store is not None else None
    payload = state_hub.as_jsonable(active_trip_id=active_trip_id)
    payload["fix_type_label"] = {0: "none", 1: "none", 2: "2D", 3: "3D"}.get(fix.fix_type, str(fix.fix_type))
    return payload


@app.get("/api/search")
def api_search(
    q: str = Query("", description="Search query"),
    limit: int = Query(8, ge=1, le=25),
    lat: Optional[float] = Query(None),
    lon: Optional[float] = Query(None),
) -> Dict[str, Any]:
    return _nominatim_search(query=q, limit=limit, near_lat=lat, near_lon=lon)


@app.get("/api/places")
def api_places() -> Dict[str, Any]:
    return places_store.list()


@app.post("/api/places/history")
def api_add_history(place: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    record = places_store.add_history(place)
    return {"ok": True, "place": record, "places": places_store.list()}


@app.delete("/api/places/history")
def api_clear_history() -> Dict[str, Any]:
    places_store.clear_history()
    return {"ok": True, "places": places_store.list()}


@app.post("/api/places/favorites")
def api_add_favorite(place: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    record = places_store.add_favorite(place)
    return {"ok": True, "place": record, "places": places_store.list()}


@app.delete("/api/places/favorites/{place_id}")
def api_delete_favorite(place_id: str) -> Dict[str, Any]:
    deleted = places_store.delete_favorite(place_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Favorite not found")
    return {"ok": True, "places": places_store.list()}


@app.post("/api/route")
def api_route(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    current = _poll_fix()

    start = payload.get("start") or {}
    destination = payload.get("destination") or payload.get("end") or payload

    start_lat = start.get("lat")
    start_lon = start.get("lon")
    if start_lat is None or start_lon is None:
        if current.fix_valid and current.lat_deg is not None and current.lon_deg is not None:
            start_lat = current.lat_deg
            start_lon = current.lon_deg
        else:
            raise HTTPException(status_code=400, detail="No valid current position available for route start")

    end_lat = destination.get("lat")
    end_lon = destination.get("lon")
    if end_lat is None or end_lon is None:
        raise HTTPException(status_code=400, detail="Destination lat/lon required")

    try:
        start_lat = float(start_lat)
        start_lon = float(start_lon)
        end_lat = float(end_lat)
        end_lon = float(end_lon)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid route coordinates: {exc}") from exc

    route = _request_osrm_route(start_lon, start_lat, end_lon, end_lat)
    route["destination_label"] = (
        destination.get("display_name")
        or destination.get("name")
        or f"{end_lat:.5f}, {end_lon:.5f}"
    )
    return route


@app.get("/api/trips")
def api_trips() -> Dict[str, Any]:
    trips = store.list_trips() if store is not None else []
    return {"trips": trips, "active_trip_id": (store.active_trip_id() if store is not None else None)}


@app.post("/api/trips/start")
def api_trips_start(payload: Optional[Dict[str, Any]] = Body(default=None)) -> Dict[str, Any]:
    if store is None:
        raise HTTPException(status_code=500, detail="Store unavailable")
    payload = payload or {}
    trip_id = store.start_trip(name=payload.get("name"), notes=payload.get("notes"))
    return {"ok": True, "trip_id": trip_id}


@app.post("/api/trips/stop")
def api_trips_stop() -> Dict[str, Any]:
    if store is None:
        raise HTTPException(status_code=500, detail="Store unavailable")
    trip_id = store.stop_trip()
    return {"ok": True, "trip_id": trip_id}


@app.get("/api/trips/{trip_id}/points")
def api_trip_points(
    trip_id: int,
    limit: Optional[int] = Query(None, ge=1),
) -> Dict[str, Any]:
    if store is None:
        raise HTTPException(status_code=500, detail="Store unavailable")
    points = store.trip_points(trip_id, limit=limit)
    return {"trip_id": trip_id, "points": points, "geojson": _trip_points_geojson(points)}


@app.get("/api/trips/{trip_id}/export.csv")
def api_trip_export_csv(trip_id: int) -> Response:
    if store is None:
        raise HTTPException(status_code=500, detail="Store unavailable")
    points = store.trip_points(trip_id)
    content = _csv_export(points)
    return Response(
        content=content,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="trip_{trip_id}.csv"'},
    )


@app.get("/api/trips/{trip_id}/export.gpx")
def api_trip_export_gpx(trip_id: int) -> Response:
    if store is None:
        raise HTTPException(status_code=500, detail="Store unavailable")
    points = store.trip_points(trip_id)
    content = _gpx_export(points, f"vehitrack trip {trip_id}")
    return Response(
        content=content,
        media_type="application/gpx+xml",
        headers={"Content-Disposition": f'attachment; filename="trip_{trip_id}.gpx"'},
    )


@app.get("/api/trips/{trip_id}/export.kml")
def api_trip_export_kml(trip_id: int) -> Response:
    if store is None:
        raise HTTPException(status_code=500, detail="Store unavailable")
    points = store.trip_points(trip_id)
    content = _kml_export(points, f"vehitrack trip {trip_id}")
    return Response(
        content=content,
        media_type="application/vnd.google-earth.kml+xml",
        headers={"Content-Disposition": f'attachment; filename="trip_{trip_id}.kml"'},
    )


@app.get("/tiles/{z}/{x}/{y}.png")
def proxy_satellite_tile(z: int, x: int, y: int) -> Response:
    if not SETTINGS.satellite_tiles_url:
        raise HTTPException(status_code=404, detail="Satellite tiles are not configured")
    template = SETTINGS.satellite_tiles_url
    url = template.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
    try:
        response = requests.get(url, timeout=8)
        response.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Satellite tile fetch failed: {exc}") from exc
    return Response(content=response.content, media_type=response.headers.get("content-type", "image/png"))


@app.exception_handler(HTTPException)
def _http_exception_handler(_, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.get("/api/debug")
def api_debug() -> Dict[str, Any]:
    fix = _poll_fix()
    return {
        "settings": {
            "db_path": SETTINGS.db_path,
            "vector_tilejson_url": SETTINGS.vector_tilejson_url,
            "nominatim_url": SETTINGS.nominatim_url,
            "osrm_url": SETTINGS.osrm_url,
            "satellite_tiles_url": SETTINGS.satellite_tiles_url,
            "places_store_path": str(places_store.path),
        },
        "state": state_hub.as_jsonable(active_trip_id=(store.active_trip_id() if store is not None else None)),
        "fix_json": fix.to_jsonable(),
    }
