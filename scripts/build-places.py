"""Refresh the bundled town directory from GeoNames, licensed CC BY 4.0.
Run explicitly; never fetch external data during a normal application build.
"""
import io
import json
from pathlib import Path
import urllib.request
import zipfile

places = []
for country in ("IE", "GB"):
    with urllib.request.urlopen(f"https://download.geonames.org/export/dump/{country}.zip", timeout=40) as response:
        archive = response.read(20_000_001)
    if len(archive) > 20_000_000:
        raise ValueError("GeoNames archive exceeds the input limit")
    with zipfile.ZipFile(io.BytesIO(archive)) as compressed:
        rows = compressed.read(f"{country}.txt").decode().splitlines()
    for row in rows:
        fields = row.split("\t")
        if (fields[6] == "P" and fields[7] in ("PPL", "PPLA", "PPLA2", "PPLC")
                and int(fields[14] or 0) >= 500 and (country == "IE" or fields[10] == "NIR")):
            places.append(dict(id=f"gn-{fields[0]}", name=fields[1], lat=float(fields[4]),
                               lon=float(fields[5]), region="Northern Ireland" if country == "GB" else "Ireland"))
if not 100 < len(places) < 5000 or len({place["id"] for place in places}) != len(places):
    raise ValueError("Unexpected town count or duplicate IDs; directory was not written")
places.sort(key=lambda place: place["name"])
target = Path(__file__).resolve().parents[1] / "lib" / "towns.json"
target.write_text(json.dumps(places, ensure_ascii=False, separators=(",", ":")) + "\n")
print(f"Wrote {len(places)} places to {target.name}")
