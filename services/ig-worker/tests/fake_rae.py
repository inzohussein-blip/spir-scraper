#!/usr/bin/env python3
"""A stand-in for the reverse-api-engineer CLI in tests: same commands and JSON
shapes (agent --dry-run/--json-stream, engineer, list, show), no browser or AI."""

import json
import os
import sys
import time
from pathlib import Path

RAE_HOME = Path(os.environ.get("RAE_HOME", str(Path.home() / ".reverse-api")))


def write_run(run_id: str, prompt: str) -> Path:
    folder = RAE_HOME / "runs" / "scripts" / run_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "api_client.ts").write_text(
        "export async function listItems() {\n  return fetch('https://example.com/api/items');\n}\n"
    )
    (folder / "README.md").write_text(f"# Client\n\nGoal: {prompt}\n")
    (folder / ".secret").write_text("hidden")
    (RAE_HOME / "runs" / f"{run_id}.json").write_text(
        json.dumps({"run_id": run_id, "prompt": prompt, "file_count": 2, "har_entries": 3})
    )
    return folder / "api_client.ts"


def arg(name: str, default=None):
    args = sys.argv[1:]
    return args[args.index(name) + 1] if name in args else default


def main() -> None:
    args = sys.argv[1:]
    if args[:1] == ["--version"]:
        print("reverse-api-engineer 9.9.9 (fake)")
        return
    if args[:1] == ["agent"]:
        prompt, url = arg("-p"), arg("-u")
        if "--dry-run" in args:
            print(
                json.dumps(
                    {
                        "status": "ok",
                        "checks": [{"name": "url", "status": "ok"}],
                        "would_run": {
                            "agent_provider": "auto",
                            "url": url,
                            "key": os.environ.get("ANTHROPIC_API_KEY", "")[:3],
                        },
                    }
                )
            )
            return
        run_id = "run" + str(int(time.time() * 1000))[-6:]
        print(json.dumps({"event": "start", "run_id": run_id}), flush=True)
        time.sleep(0.3)
        print(json.dumps({"event": "message", "text": f"browsing {url}"}), flush=True)
        script = write_run(run_id, prompt)
        print(
            json.dumps(
                {
                    "event": "result",
                    "status": "ok",
                    "run_id": run_id,
                    "script_path": str(script),
                    "har_path": None,
                    "usage": {"total_cost_usd": 0.12},
                }
            ),
            flush=True,
        )
        return
    if args[:1] == ["engineer"]:
        run_id = args[1]
        script = write_run(run_id, arg("-p", "again"))
        print(
            json.dumps(
                {"event": "result", "status": "ok", "run_id": run_id, "script_path": str(script)}
            ),
            flush=True,
        )
        return
    if args[:1] == ["list"]:
        runs = [json.loads(p.read_text()) for p in sorted((RAE_HOME / "runs").glob("*.json"))]
        search = arg("--search")
        if search:
            runs = [r for r in runs if search in r["prompt"]]
        print(json.dumps(runs))
        return
    if args[:1] == ["show"]:
        p = RAE_HOME / "runs" / f"{args[1]}.json"
        if not p.exists():
            print(json.dumps({"status": "error", "error": "not found"}))
            sys.exit(1)
        print(p.read_text())
        return
    sys.exit(2)


if __name__ == "__main__":
    main()
