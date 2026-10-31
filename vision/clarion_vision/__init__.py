"""Clarion's vision service (SPEC-v2 D0, A1-A11)."""
import os

# torch and the conda numpy load different OpenMP runtimes; without this the process aborts when both are in use.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
