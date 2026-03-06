from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Optional, Any, Dict


@dataclass(frozen=True)
class FixState:
    ts_utc: datetime
    lat_deg: Optional[float] = None
    lon_deg: Optional[float] = None
    alt_m: Optional[float] = None
    speed_mps: Optional[float] = None
    course_deg: Optional[float] = None

    fix_valid: bool = False
    fix_type: int = 0  # gpsd "mode": 0/1/2/3
    sats_used: Optional[int] = None
    hdop: Optional[float] = None

    source: str = "unknown"

    def to_jsonable(self) -> Dict[str, Any]:
        d = asdict(self)
        d["ts_utc"] = self.ts_utc.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        return d


def now_utc() -> datetime:
    return datetime.now(timezone.utc)