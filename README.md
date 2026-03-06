# vehitrack

Offline, map-first GPS logger for in-vehicle Linux mini PCs.

## Prereqs
- gpsd running and reading your receiver (recommended)
- Python 3.11+

## Install
```bash
python -m venv .venv
. .venv/bin/activate
pip install -U pip
pip install -e .