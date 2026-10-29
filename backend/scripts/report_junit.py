"""Expose pytest failures as GitHub annotations when a CI job fails."""

import sys
import xml.etree.ElementTree as ET


def escape(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def main(path: str) -> None:
    root = ET.parse(path).getroot()  # Locally generated pytest report.
    for case in root.iter("testcase"):
        for failure in case:
            if failure.tag not in {"failure", "error"}:
                continue
            name = f"{case.get('classname', '')}.{case.get('name', '')}"
            detail = (failure.text or failure.get("message") or "Test failed")[:12000]
            print(f"::error title=Pytest::{escape(name + chr(10) + detail)}")


if __name__ == "__main__":
    main(sys.argv[1])
