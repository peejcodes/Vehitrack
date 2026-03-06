from __future__ import annotations

import math
from typing import Optional


EARTH_R_M = 6371008.8


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    # Inputs in degrees; output meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = phi2 - phi1
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_R_M * math.asin(math.sqrt(a))


def implied_speed_mps(
    lat1: float, lon1: float, t1_s: float,
    lat2: float, lon2: float, t2_s: float
) -> Optional[float]:
    dt = t2_s - t1_s
    if dt <= 0:
        return None
    dist = haversine_m(lat1, lon1, lat2, lon2)
    return dist / dt