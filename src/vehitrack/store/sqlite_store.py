from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any, Tuple

from vehitrack.core.models import FixState
from vehitrack.core.geo import haversine_m


@dataclass
class LoggingConfig:
    db_path: str
    raw_fixes: bool = False
    min_time_s: float = 1.0
    min_distance_m: float = 7.0


class SqliteStore:
    def __init__(self, cfg: LoggingConfig):
        self.cfg = cfg
        os.makedirs(os.path.dirname(cfg.db_path), exist_ok=True)
        self._conn = sqlite3.connect(cfg.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

        self._active_trip_id: Optional[int] = None
        self._last_logged: Optional[FixState] = None

    def close(self) -> None:
        self._conn.close()

    def _init_schema(self) -> None:
        cur = self._conn.cursor()

        cur.execute("""
        CREATE TABLE IF NOT EXISTS trips (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT,
          start_ts TEXT NOT NULL,
          end_ts TEXT,
          notes TEXT
        )""")

        cur.execute("""
        CREATE TABLE IF NOT EXISTS trip_points (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trip_id INTEGER NOT NULL,
          ts TEXT NOT NULL,
          lat REAL NOT NULL,
          lon REAL NOT NULL,
          alt REAL,
          speed REAL,
          course REAL,
          hdop REAL,
          sats_used INTEGER,
          FOREIGN KEY(trip_id) REFERENCES trips(id)
        )""")

        cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_trip_points_trip_ts
        ON trip_points(trip_id, ts)
        """)

        cur.execute("""
        CREATE TABLE IF NOT EXISTS fixes_raw (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          json TEXT NOT NULL
        )""")

        self._conn.commit()

    # ---- Trip control ----
    def active_trip_id(self) -> Optional[int]:
        return self._active_trip_id

    def start_trip(self, name: Optional[str] = None, notes: Optional[str] = None) -> int:
        if self._active_trip_id is not None:
            return self._active_trip_id

        ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        cur = self._conn.cursor()
        cur.execute(
            "INSERT INTO trips(name, start_ts, end_ts, notes) VALUES(?, ?, NULL, ?)",
            (name or "Trip", ts, notes),
        )
        self._conn.commit()
        self._active_trip_id = int(cur.lastrowid)
        self._last_logged = None
        return self._active_trip_id

    def stop_trip(self) -> Optional[int]:
        if self._active_trip_id is None:
            return None
        ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        cur = self._conn.cursor()
        cur.execute("UPDATE trips SET end_ts=? WHERE id=?", (ts, self._active_trip_id))
        self._conn.commit()
        tid = self._active_trip_id
        self._active_trip_id = None
        self._last_logged = None
        return tid

    # ---- Logging ----
    def maybe_log_fix(self, fix: FixState) -> bool:
        """
        Log throttled points only when a trip is active and fix_valid==True.
        Returns True if a point was logged.
        """
        if self._active_trip_id is None:
            return False
        if not fix.fix_valid or fix.lat_deg is None or fix.lon_deg is None:
            return False

        if self._last_logged is None:
            self._insert_point(self._active_trip_id, fix)
            self._last_logged = fix
            return True

        prev = self._last_logged
        t1 = prev.ts_utc.timestamp()
        t2 = fix.ts_utc.timestamp()
        dt = t2 - t1

        dist = 0.0
        if prev.lat_deg is not None and prev.lon_deg is not None:
            dist = haversine_m(prev.lat_deg, prev.lon_deg, fix.lat_deg, fix.lon_deg)

        if dt >= self.cfg.min_time_s or dist >= self.cfg.min_distance_m:
            self._insert_point(self._active_trip_id, fix)
            self._last_logged = fix
            return True

        return False

    def _insert_point(self, trip_id: int, fix: FixState) -> None:
        cur = self._conn.cursor()
        cur.execute(
            """INSERT INTO trip_points(trip_id, ts, lat, lon, alt, speed, course, hdop, sats_used)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                trip_id,
                fix.ts_utc.isoformat().replace("+00:00", "Z"),
                fix.lat_deg,
                fix.lon_deg,
                fix.alt_m,
                fix.speed_mps,
                fix.course_deg,
                fix.hdop,
                fix.sats_used,
            ),
        )
        self._conn.commit()

    # ---- Queries ----
    def list_trips(self) -> List[Dict[str, Any]]:
        cur = self._conn.cursor()
        rows = cur.execute("SELECT * FROM trips ORDER BY id DESC").fetchall()
        return [dict(r) for r in rows]

    def trip_points(self, trip_id: int, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        cur = self._conn.cursor()
        q = "SELECT ts, lat, lon, alt, speed, course, hdop, sats_used FROM trip_points WHERE trip_id=? ORDER BY ts ASC"
        params: Tuple[Any, ...] = (trip_id,)
        if limit is not None:
            q += " LIMIT ?"
            params = (trip_id, int(limit))
        rows = cur.execute(q, params).fetchall()
        return [dict(r) for r in rows]