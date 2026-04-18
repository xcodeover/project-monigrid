"""Single source of truth for the backend application version.

Kept as a simple Python module (not in config.json) so:
  - The value is tied to the build artifact, not user-editable runtime config.
  - PyInstaller correctly bundles it into the frozen exe.
  - pyproject.toml and routes can read from one place.

Bump this string when cutting a release.
"""

__version__ = "2.0.0"
