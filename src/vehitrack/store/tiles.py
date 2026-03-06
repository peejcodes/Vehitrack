from __future__ import annotations

import sqlite3
from functools import lru_cache
from typing import Optional, Tuple


def _tms_y(z: int, y_xyz: int) -> int:
    # MBTiles uses TMS (flipped Y)
    return (1 << z) - 1 - y_xyz


class Mbtiles:
    def __init__(self, path: str):
        self.path = path
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row

    def close(self) -> None:
        self.conn.close()

    def tile(self, z: int, x: int, y_xyz: int) -> Optional[bytes]:
        y = _tms_y(z, y_xyz)
        cur = self.conn.cursor()
        row = cur.execute(
            "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
            (z, x, y),
        ).fetchone()
        if not row:
            return None
        return row["tile_data"]

    @lru_cache(maxsize=128)
    def format(self) -> Optional[str]:
        cur = self.conn.cursor()
        row = cur.execute("SELECT value FROM metadata WHERE name='format'").fetchone()
        return row["value"] if row else None