"""Exercise the installed Python wheel and bundled Node runtime in isolation."""
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading
from urllib.request import urlopen


with tempfile.TemporaryDirectory(prefix="gate-python-") as directory:
    root = Path(directory)
    env = {**os.environ, "GATE_RUNTIME_DIR": str(root / "runtime")}
    child = subprocess.Popen(
        ["gate-llm", "serve", "--port", "0", "--data-dir", str(root / "state")],
        cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    lines = queue.Queue()
    def read_output():
        for line in child.stdout:
            lines.put(line)
        lines.put(None)
    threading.Thread(target=read_output, daemon=True).start()
    try:
        output = []
        while True:
            line = lines.get(timeout=30)
            if line is None:
                raise RuntimeError("Python launcher failed: " + "".join(output))
            output.append(line)
            match = re.search(r"http://127\.0\.0\.1:\d+", line)
            if match:
                origin = match[0]
                break
        with urlopen(origin + "/health", timeout=10) as response:
            health = json.load(response)
        version = subprocess.check_output(["gate-llm", "--version"], text=True).strip()
        assert health["version"] == version
        with urlopen(origin + "/api/session", timeout=10) as response:
            assert json.load(response)["setup"] is True
        with urlopen(origin, timeout=10) as response:
            assert 'id="root"' in response.read().decode()
        assert list((root / "runtime").glob("*/node_modules/fastify/package.json"))
        print("Installed Python wheel passes: bundled runtime, fresh state, HTTP API and dashboard.")
    finally:
        child.terminate()
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
