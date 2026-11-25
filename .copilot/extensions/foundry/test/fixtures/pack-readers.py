"""Repack source-only Foundry reader fixtures: python3 pack-readers.py OUTPUT EXTENSION_DIR..."""
import io
import sys
import tarfile
from pathlib import Path


def pack(output, directories):
	entries = []
	versions = set()
	for directory in directories:
		work = Path(directory) / "work"
		version = int((work / "reader.version").read_text())
		if version in versions:
			raise ValueError(f"duplicate reader {version}")
		versions.add(version)
		for source in [work / "reader.version", *work.glob("*.mjs")]:
			if not source.name.endswith(".test.mjs"):
				entries.append((source.name, version, source))
	with tarfile.open(output, "w:xz", format=tarfile.USTAR_FORMAT) as archive:
		# Keep revisions of each module adjacent for cross-version compression.
		for name, version, source in sorted(entries):
			data = source.read_bytes()
			entry = tarfile.TarInfo(f"{version}/work/{name}")
			entry.size = len(data)
			archive.addfile(entry, io.BytesIO(data))


if __name__ == "__main__":
	pack(sys.argv[1], sys.argv[2:])
