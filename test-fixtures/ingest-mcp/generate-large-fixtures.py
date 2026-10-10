#!/usr/bin/env python3
from pathlib import Path


ROOT = Path(__file__).parent


def write_exact_size(path: Path, size_bytes: int, header: str) -> None:
    """
    Input:
    - A destination path, exact byte size, and identifying header.
    Output:
    - None; writes a fixture with the requested size.
    What this function does:
    - Creates deterministic boundary-test files without holding the full payload in memory.
    """
    header_bytes = (header + "\n").encode("utf-8")
    if len(header_bytes) > size_bytes:
        raise ValueError(f"Header too large for {path.name}")
    remaining = size_bytes - len(header_bytes)
    chunk = b"A" * min(65536, remaining)
    with path.open("wb") as f:
        f.write(header_bytes)
        written = 0
        while written < remaining:
            to_write = min(len(chunk), remaining - written)
            f.write(chunk[:to_write])
            written += to_write


def main() -> None:
    """
    Input:
    - No arguments; uses fixture definitions declared in this function.
    Output:
    - None; writes the near-limit and over-limit fixture files.
    What this function does:
    - Generates deterministic upload-size fixtures beside this script.
    """
    targets = [
        (
            ROOT / "07-size-near-limit-3_8mb.txt",
            3_800_000,
            "Fixture near 4MB limit. Token: FIXTURE_SIZE_NEAR_LIMIT_20260629",
        ),
        (
            ROOT / "08-size-over-limit-4_6mb.txt",
            4_600_000,
            "Fixture over 4MB limit. Token: FIXTURE_SIZE_OVER_LIMIT_20260629",
        ),
    ]

    for path, size_bytes, header in targets:
        write_exact_size(path, size_bytes, header)
        print(f"wrote {path.name} ({size_bytes} bytes)")


if __name__ == "__main__":
    main()
