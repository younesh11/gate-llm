"""Launch the bundled Node application without downloading code at runtime."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from ._version import __version__


def node_path():
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js 22.13+ is required. Install Node.js 24 LTS, or use the Docker image instead.")
    output = subprocess.check_output([node, "--version"], text=True).strip()
    match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", output)
    if not match or tuple(map(int, match.groups())) < (22, 13, 0):
        raise RuntimeError(f"Node.js 22.13+ is required; found {output}. Node.js 24 LTS is recommended.")
    return node


def extract_runtime(archive, destination):
    """Accept only ordinary files/directories under package/, never links."""
    with tarfile.open(archive, "r:gz") as source:
        total = 0
        for member in source:
            path = PurePosixPath(member.name)
            if "\\" in member.name or ":" in member.name or path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != "package":
                raise RuntimeError("Invalid path in bundled runtime.")
            if not member.isdir() and not member.isfile():
                raise RuntimeError("Links and special files are not allowed in the bundled runtime.")
            total += member.size
            if total > 200 * 1024 * 1024:
                raise RuntimeError("Bundled runtime exceeds the extraction size limit.")
            target = destination.joinpath(*path.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as reader, target.open("xb") as writer:
                    shutil.copyfileobj(reader, writer)
                target.chmod(member.mode & 0o755)


def runtime_path():
    vendor = Path(__file__).parent / "vendor"
    manifest = json.loads((vendor / "manifest.json").read_text())
    archive = vendor / "runtime.tgz"
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != manifest["sha256"] or manifest["version"] != __version__:
        raise RuntimeError("Bundled runtime integrity/version check failed. Reinstall the package.")
    base = Path(os.environ.get("GATE_RUNTIME_DIR", Path.home() / ".cache" / "gate-llm"))
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = base / f"{__version__}-{digest[:16]}"
    cli = target / "build" / "cli.js"
    if cli.is_file():
        return cli
    with tempfile.TemporaryDirectory(prefix="extract-", dir=base) as directory:
        staging = Path(directory)
        extract_runtime(archive, staging)
        package = staging / "package"
        if not (package / "build" / "cli.js").is_file():
            raise RuntimeError("Bundled runtime is missing its CLI.")
        try:
            package.rename(target)
        except OSError:
            if not cli.is_file():
                raise
    return cli


def main():
    args = sys.argv[1:]
    if args == ["--version"]:
        print(__version__)
        return
    if args == ["--help"]:
        print("GATE — self-hosted LLM gateway\n\nUsage: gate-llm [serve] [options]\n       gate-llm backup --data-dir PATH --output NEW_DIRECTORY\n       gate-llm verify-backup --input BACKUP_DIRECTORY\n       gate-llm restore --input BACKUP_DIRECTORY --data-dir NEW_DIRECTORY\n       gate-llm reset-password --data-dir PATH --email ACCOUNT_EMAIL\n\nStop the gateway before backup or password reset. Restore never overwrites a directory.\nPassword reset prompts privately; use --password-stdin to read one line from a pipe.\nBackups contain the encryption key: store them privately, outside your data directory.\n\nRequires Node.js 22.13+ (24 LTS recommended). Runtime dependencies and dashboard are bundled.\nServe options: --host ADDRESS, --port NUMBER, --data-dir PATH, --env-file PATH,\n         --allow-private-upstreams, --allow-remote-setup, --secure-cookie, --log-level LEVEL, --version\nPersistent data defaults to ~/.gate-llm. GATE_RUNTIME_DIR overrides the runtime cache.\nThis package is a launcher; it is not a Python model SDK.")
        return
    try:
        node = node_path()
        cli = runtime_path()
        os.execv(node, [node, str(cli), *args])
    except (RuntimeError, OSError, ValueError, KeyError, tarfile.TarError, subprocess.SubprocessError) as error:
        print(f"GATE: {error}", file=sys.stderr)
        raise SystemExit(1)
