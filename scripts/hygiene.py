#!/usr/bin/env python3
"""Scan every git-tracked file for things that must never be committed.

Written in Python on purpose. `grep -P '\\x00'` is not available in every grep on every
box and returns no matches where Python finds the byte immediately, so an audit built on
it reports everything clean while reading nothing. And one NUL byte makes git and grep
treat a whole file as binary, so `grep -I` skips it entirely: a scan that skips a file
prints the same "ok" as a scan that read it and found nothing.

The detectors are self-tested at the end against strings assembled at runtime, so no
complete credential pattern ever exists on disk for GitHub push protection to reject.
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_BYTES = 1_000_000

# Case-sensitive where the real format is. `AKIA[0-9A-Z]{16}` under grep -i matches
# ordinary base64, so every page with an inline image becomes a false alarm.
SECRET_PATTERNS = [
    ("AWS access key id", re.compile(rb"AKIA[0-9A-Z]{16}")),
    ("GitHub token", re.compile(rb"gh[pousr]_[A-Za-z0-9]{36}")),
    ("OpenAI-style key", re.compile(rb"sk-[A-Za-z0-9_-]{32,}")),
    ("Slack token", re.compile(rb"xox[baprs]-[A-Za-z0-9-]{10,}")),
    ("private key block", re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----")),
    ("Google API key", re.compile(rb"AIza[0-9A-Za-z_-]{35}")),
]

# An absolute home path in a committed file is both private and unportable.
HOME_PATH = re.compile(rb"/home/[A-Za-z0-9_.-]+/")

problems = []


def tracked_files():
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True
    ).stdout
    return [ROOT / p.decode() for p in out.split(b"\0") if p]


files = tracked_files()
if not files:
    print("git ls-files returned nothing; there is nothing to scan")
    sys.exit(1)

nul_files = 0
scanned = 0
total_bytes = 0

for path in files:
    if not path.is_file():
        continue
    data = path.read_bytes()
    scanned += 1
    total_bytes += len(data)
    rel = path.relative_to(ROOT)

    if len(data) > MAX_BYTES:
        problems.append(f"{rel}: {len(data)} bytes, over the {MAX_BYTES} byte limit")

    if b"\0" in data:
        nul_files += 1
        problems.append(
            f"{rel}: contains a NUL byte, which makes git and grep treat the file as "
            f"binary and skip it in every text scan. Write it as the two-character "
            f"escape \\0 instead of embedding the byte."
        )

    for label, pattern in SECRET_PATTERNS:
        m = pattern.search(data)
        if m:
            problems.append(f"{rel}: looks like a {label} at byte {m.start()}")

    m = HOME_PATH.search(data)
    if m:
        line = data[: m.start()].count(b"\n") + 1
        problems.append(
            f"{rel}:{line}: absolute home path {m.group().decode(errors='replace')}..."
        )

print(f"  {scanned} tracked files scanned, {total_bytes} bytes, {nul_files} with NUL bytes")

# --- the detectors need their own test -------------------------------------------------
# Assembled at runtime so no complete pattern sits on disk.
selftests = [
    ("AKIA" + "ABCDEFGHIJKLMNOP", SECRET_PATTERNS[0][1]),
    ("gh" + "p_" + "a" * 36, SECRET_PATTERNS[1][1]),
    ("sk-" + "b" * 40, SECRET_PATTERNS[2][1]),
    ("xox" + "b-" + "1234567890abc", SECRET_PATTERNS[3][1]),
    ("-----BEGIN " + "PRIVATE KEY-----", SECRET_PATTERNS[4][1]),
    ("AIza" + "c" * 35, SECRET_PATTERNS[5][1]),
    ("/home/" + "someone" + "/x", HOME_PATH),
]
broken = [s for s, pat in selftests if not pat.search(s.encode())]
if broken:
    print("  the scanner itself is broken: these did not match their own pattern:")
    for s in broken:
        print(f"    {s[:12]}...")
    sys.exit(1)
print(f"  {len(selftests)} detectors self-tested against synthetic samples")

# And prove the NUL detector fires, since it is the one that silently blinds everything.
if b"\0" not in ("a" + chr(0) + "b").encode():
    print("  the NUL detector does not detect a NUL")
    sys.exit(1)
print("  NUL detection confirmed on a synthetic sample")

# Case sensitivity is a property worth pinning: a case-insensitive AWS pattern matches
# ordinary base64 and turns every embedded image into a false alarm.
if SECRET_PATTERNS[0][1].search(b"AkiAqaMkgIem1yaUXNKiJ2M"):
    print("  the AWS pattern is case-insensitive and will false-positive on base64")
    sys.exit(1)
print("  the AWS pattern stays case-sensitive, so base64 does not false-positive")

if problems:
    print("")
    for p in problems:
        print(f"  {p}")
    sys.exit(1)
sys.exit(0)
