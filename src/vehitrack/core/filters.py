from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional, Tuple

from .geo import implied_speed_mps
from .models import FixState


@dataclass
class FilterConfig:
    max_speed_mps: float = 90.0  # ~200 mph
    reject_time_backwards: bool = True


class JumpRejector:
    """
    Phase-1 quality gate:
      - reject if time goes backwards
      - reject if implied speed exceeds max_speed_mps
    """
    def __init__(self, cfg: FilterConfig):
        self.cfg = cfg
        self._last_ok: Optional[FixState] = None
        self.rejected_count: int = 0

    def last_ok(self) -> Optional[FixState]:
        return self._last_ok

    def consider(self, fix: FixState) -> Tuple[bool, str]:
        if not fix.fix_valid:
            # don't advance last_ok; but allow state to show "invalid"
            return True, "invalid_fix_passthrough"

        if self._last_ok is None:
            self._last_ok = fix
            return True, "first_fix"

        prev = self._last_ok
        if prev.lat_deg is None or prev.lon_deg is None or fix.lat_deg is None or fix.lon_deg is None:
            self._last_ok = fix
            return True, "missing_latlon"

        t1 = prev.ts_utc.timestamp()
        t2 = fix.ts_utc.timestamp()

        if self.cfg.reject_time_backwards and t2 <= t1:
            self.rejected_count += 1
            return False, "time_backwards"

        sp = implied_speed_mps(prev.lat_deg, prev.lon_deg, t1, fix.lat_deg, fix.lon_deg, t2)
        if sp is not None and sp > self.cfg.max_speed_mps:
            self.rejected_count += 1
            return False, f"implied_speed_too_high:{sp:.2f}"

        self._last_ok = fix
        return True, "ok"