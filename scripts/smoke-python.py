"""Exercise the installed Python wheel and bundled Node runtime in isolation."""
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading
from urllib.request import Request, urlopen


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
        with urlopen(origin + "/ready", timeout=10) as response:
            assert json.load(response)["status"] == "ready"
        with urlopen(origin + "/api/session", timeout=10) as response:
            assert json.load(response)["setup"] is True
        with urlopen(origin, timeout=10) as response:
            assert 'id="root"' in response.read().decode()
        assert list((root / "runtime").glob("*/node_modules/fastify/package.json"))
        setup = Request(origin + "/api/setup", data=json.dumps({"workspace": "Python test", "name": "Owner", "email": "python@example.test", "password": "synthetic-python-password"}).encode(), headers={"Content-Type": "application/json"})
        with urlopen(setup, timeout=10) as response:
            assert response.status == 200
    finally:
        child.terminate()
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    def maintenance(*args, password=None):
        result = subprocess.run(["gate-llm", *args], cwd=root, env=env, input=password, capture_output=True, text=True, timeout=30, check=True)
        if password:
            assert password.strip() not in result.stdout + result.stderr
        return json.loads(result.stdout)
    assert maintenance("backup", "--data-dir", str(root / "state"), "--output", str(root / "backup"))["status"] == "backup_created"
    assert maintenance("verify-backup", "--input", str(root / "backup"))["status"] == "backup_verified"
    assert maintenance("restore", "--input", str(root / "backup"), "--data-dir", str(root / "restored"))["status"] == "backup_restored"
    assert maintenance("reset-password", "--data-dir", str(root / "restored"), "--email", "python@example.test", "--password-stdin", password="synthetic-replacement-password\n")["status"] == "password_reset"
    print("Installed Python wheel passes: bundled runtime, HTTP API, dashboard, backup/restore and password recovery.")
