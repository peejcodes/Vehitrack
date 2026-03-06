from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Callable

from vehitrack.core.models import FixState, now_utc


def _parse_gpsd_time(t: Any) -> datetime:
    if isinstance(t, str) and t:
        # gpsd often uses ISO8601 with "Z"
        s = t.replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(s).astimezone(timezone.utc)
        except ValueError:
            return now_utc()
    return now_utc()


@dataclass
class GpsdConfig:
    host: str = "127.0.0.1"
    port: int = 2947
    reconnect_s: float = 1.0


class GpsdClient:
    """
    Connects to gpsd TCP socket, enables JSON watch, parses TPV + SKY.
    Emits FixState via callback.
    """
    def __init__(self, cfg: GpsdConfig, on_fix: Callable[[FixState], Any]):
        self.cfg = cfg
        self.on_fix = on_fix
        self._stop = asyncio.Event()
        self._last_sky: Dict[str, Any] = {}

    def stop(self) -> None:
        self._stop.set()

    async def run_forever(self) -> None:
        while not self._stop.is_set():
            try:
                await self._run_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                # Back off and reconnect
                await asyncio.sleep(self.cfg.reconnect_s)

    async def _run_once(self) -> None:
        reader, writer = await asyncio.open_connection(self.cfg.host, self.cfg.port)
        try:
            watch = '?WATCH={"enable":true,"json":true,"scaled":true}\n'
            writer.write(watch.encode("utf-8"))
            await writer.drain()

            while not self._stop.is_set():
                line = await reader.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line.decode("utf-8", errors="ignore").strip())
                except json.JSONDecodeError:
                    continue

                cls = msg.get("class")
                if cls == "SKY":
                    self._last_sky = msg
                elif cls == "TPV":
                    fix = self._tpv_to_fix(msg, self._last_sky)
                    maybe = self.on_fix(fix)
                    if asyncio.iscoroutine(maybe):
                        await maybe
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    def _tpv_to_fix(self, tpv: Dict[str, Any], sky: Dict[str, Any]) -> FixState:
        mode = int(tpv.get("mode") or 0)
        lat = tpv.get("lat")
        lon = tpv.get("lon")
        alt = tpv.get("alt")
        speed = tpv.get("speed")  # m/s if scaled:true
        track = tpv.get("track")  # degrees

        # SKY fields vary; uSat = used satellites (commonly present)
        sats_used = sky.get("uSat") if isinstance(sky, dict) else None
        hdop = sky.get("hdop") if isinstance(sky, dict) else None

        fix_valid = mode >= 2 and isinstance(lat, (int, float)) and isinstance(lon, (int, float))

        return FixState(
            ts_utc=_parse_gpsd_time(tpv.get("time")),
            lat_deg=float(lat) if isinstance(lat, (int, float)) else None,
            lon_deg=float(lon) if isinstance(lon, (int, float)) else None,
            alt_m=float(alt) if isinstance(alt, (int, float)) else None,
            speed_mps=float(speed) if isinstance(speed, (int, float)) else None,
            course_deg=float(track) if isinstance(track, (int, float)) else None,
            fix_valid=fix_valid,
            fix_type=mode,
            sats_used=int(sats_used) if isinstance(sats_used, (int, float)) else None,
            hdop=float(hdop) if isinstance(hdop, (int, float)) else None,
            source="gpsd",
        )