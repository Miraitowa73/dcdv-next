"""Build an FC zip with production code/dependencies only. No credentials or test server."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
source = root / "cloud-account"
output = root / "runtime" / "dcdv-next-account.zip"
entries = [source / name for name in ("index.js", "service.js", "store.js", "package.json", "package-lock.json")]
dependency_root = source / "node_modules"
if not dependency_root.is_dir():
    raise SystemExit("Run npm ci --prefix cloud-account --ignore-scripts first")
entries += [file for file in dependency_root.rglob("*") if file.is_file()]
for entry in entries:
    if not entry.resolve().is_relative_to(source.resolve()) or entry.name.startswith(".env"):
        raise SystemExit("Unexpected deployment entry")
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for entry in sorted(entries):
        archive.write(entry, entry.relative_to(source).as_posix())
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    assert {"index.js", "service.js", "store.js"}.issubset(archive.namelist())
digest = hashlib.sha256(output.read_bytes()).hexdigest()
print(json.dumps({"path": str(output), "bytes": output.stat().st_size, "sha256": digest, "files": len(entries)}, ensure_ascii=False))
