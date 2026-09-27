#!/usr/bin/env python3
"""Run the local Pi bridge under the current macOS user's launchd session."""

import os
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
LOCAL_HOME = ROOT / "langwatch" / ".local"
LABEL = "com.local.langwatch.pi-bridge"
PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def main() -> None:
    node = shutil.which("node")
    if not node:
        raise SystemExit("Node.js is required to run Pi")
    LOCAL_HOME.mkdir(parents=True, exist_ok=True)
    LOCAL_HOME.chmod(0o700)
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    config = {
        "Label": LABEL,
        "ProgramArguments": [sys.executable, str(ROOT / "scripts" / "pi-model-proxy.py")],
        "WorkingDirectory": str(ROOT),
        "RunAtLoad": True,
        "KeepAlive": True,
        "StandardOutPath": str(LOCAL_HOME / "pi-proxy.log"),
        "StandardErrorPath": str(LOCAL_HOME / "pi-proxy.log"),
        "EnvironmentVariables": {
            "PI_BIN": str(ROOT / "node_modules" / ".bin" / "pi"),
            "PATH": os.pathsep.join(
                dict.fromkeys(
                    [str(Path(node).parent), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
                )
            ),
            "PI_JUDGE_MODEL": "gpt-5.6-sol",
            "PI_PROXY_PORT": "11435",
            "PYTHONUNBUFFERED": "1",
        },
    }
    with PLIST.open("wb") as output:
        plistlib.dump(config, output)
    PLIST.chmod(0o600)
    domain = f"gui/{os.getuid()}"
    subprocess.run(
        ["launchctl", "bootout", domain, str(PLIST)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    subprocess.run(["launchctl", "bootstrap", domain, str(PLIST)], check=True)
    print("Pi bridge installed for this macOS user")


if __name__ == "__main__":
    main()
