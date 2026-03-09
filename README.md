# vehitrack

Offline, map-first GPS logger for in-vehicle Linux mini PCs.

## Prereqs
- NMEA gps reviever
- gpsd running and reading your receiver (recommended)
- Python 3.11+

## Install
```bash
python -m venv .venv
. .venv/bin/activate
pip install -U pip
pip install -e .