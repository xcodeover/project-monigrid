"""Adds monigrid-be root to sys.path so scripts can `import app.*`."""
import os
import sys


def setup() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    be_root = os.path.normpath(os.path.join(here, ".."))
    if be_root not in sys.path:
        sys.path.insert(0, be_root)
