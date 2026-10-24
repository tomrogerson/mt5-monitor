"""Starts one collector per terminal in config.json and restarts any that stop."""
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main():
    cfg_path = HERE / "config.json"
    if not cfg_path.exists():
        print("config.json not found. Copy config.example.json to config.json and fill it in.")
        sys.exit(1)
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    terminals = cfg.get("terminals", [])
    if not terminals:
        print("No terminals listed in config.json.")
        sys.exit(1)

    procs = {}

    def launch(t):
        cmd = [sys.executable, str(HERE / "collector.py"), "--config", str(cfg_path),
               "--name", t["name"], "--path", t["path"]]
        if t.get("group"):
            cmd += ["--group", t["group"]]
        procs[t["path"]] = subprocess.Popen(cmd)

    for t in terminals:
        launch(t)
        time.sleep(1.5)  # stagger so terminals aren't all attached at once
    print(f"{datetime.now():%H:%M:%S} started {len(terminals)} collectors. Ctrl+C to stop.")

    try:
        while True:
            time.sleep(10)
            for t in terminals:
                if procs[t["path"]].poll() is not None:
                    print(f"{datetime.now():%H:%M:%S} restarting {t['name']}")
                    launch(t)
    except KeyboardInterrupt:
        for p in procs.values():
            p.terminate()


if __name__ == "__main__":
    main()
