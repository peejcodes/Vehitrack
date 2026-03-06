from __future__ import annotations

from datetime import datetime
from typing import List, Dict, Any
import csv
import io


def export_csv(points: List[Dict[str, Any]]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["ts", "lat", "lon", "alt_m", "speed_mps", "course_deg", "hdop", "sats_used"])
    for p in points:
        w.writerow([p.get("ts"), p.get("lat"), p.get("lon"), p.get("alt"), p.get("speed"), p.get("course"), p.get("hdop"), p.get("sats_used")])
    return buf.getvalue().encode("utf-8")


def export_gpx(points: List[Dict[str, Any]], name: str = "Trip") -> bytes:
    # Minimal GPX 1.1 track
    def esc(s: str) -> str:
        return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

    parts = []
    parts.append('<?xml version="1.0" encoding="UTF-8"?>')
    parts.append('<gpx version="1.1" creator="vehitrack" xmlns="http://www.topografix.com/GPX/1/1">')
    parts.append(f"<trk><name>{esc(name)}</name><trkseg>")
    for p in points:
        lat = p["lat"]
        lon = p["lon"]
        ele = p.get("alt")
        ts = p.get("ts")
        parts.append(f'<trkpt lat="{lat:.8f}" lon="{lon:.8f}">')
        if ele is not None:
            parts.append(f"<ele>{float(ele):.2f}</ele>")
        if ts:
            parts.append(f"<time>{esc(str(ts))}</time>")
        parts.append("</trkpt>")
    parts.append("</trkseg></trk></gpx>")
    return ("\n".join(parts) + "\n").encode("utf-8")


def export_kml(points: List[Dict[str, Any]], name: str = "Trip") -> bytes:
    # Minimal KML LineString
    coords = []
    for p in points:
        lon = p["lon"]
        lat = p["lat"]
        alt = p.get("alt") or 0
        coords.append(f"{lon:.8f},{lat:.8f},{float(alt):.2f}")

    kml = f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>{name}</name>
    <Placemark>
      <name>{name}</name>
      <LineString>
        <tessellate>1</tessellate>
        <coordinates>
          {' '.join(coords)}
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>
"""
    return kml.encode("utf-8")