"""
Python packages of plugins installed at runtime.

A plugin wheel contains only the plugin's own code; its ``Requires-Dist`` lines name the
packages it needs. By default a runtime install accepts only plugins whose requirements are
already installed. When the operator sets ``PTE_PLUGIN_INSTALL_DEPENDENCIES=1``
(``plugin_install_policy``), the missing packages are installed from PyPI into the plugin's
version directory, which is on ``sys.path`` like the plugin itself and is deleted with it:

1. The missing requirements are resolved with ``uv pip compile``, with every distribution that
   is already installed pinned to its installed version, so the core environment never
   changes. A plugin that needs another version of an installed package is refused.
2. The resolved packages that the environment does not provide are installed with
   ``uv pip install --target <version dir> --no-deps``. Packages that only other
   runtime-installed plugins provide are installed again (in the same, pinned version), so
   that removing one plugin does not break another.

Requirements on other plugins (``pte-plugin-*``) are never installed from PyPI: the required
plugin must be installed first.
"""

import importlib.metadata
import logging
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from packaging.requirements import InvalidRequirement, Requirement
from packaging.utils import canonicalize_name

from fastapi_app.lib.plugins.plugin_wheel import IGNORED_REQUIREMENTS

logger = logging.getLogger(__name__)

PLUGIN_DISTRIBUTION_PREFIX = "pte-plugin-"
UV_TIMEOUT = 600
_PINNED = re.compile(r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)==(?P<version>[^\s;]+)")


class DependencyError(Exception):
    """The packages of a plugin cannot be resolved or installed."""


@dataclass(frozen=True)
class RequirementCheck:
    """The requirements of a plugin, split by what a runtime install can do about them."""

    missing: list[str] = field(default_factory=list)  # packages that can be installed from PyPI
    blocking: list[str] = field(default_factory=list)  # human-readable, cannot be installed here

    def unmet(self, install_missing: bool) -> list[str]:
        """The requirements that prevent the install."""
        if install_missing:
            return list(self.blocking)
        return self.blocking + [f"{req} (not installed)" for req in self.missing]


def check(
    requires: tuple[str, ...] | list[str], available: dict[str, str], packages: dict[str, str] | None = None
) -> RequirementCheck:
    """
    Split the requirements of a plugin into installable and blocking ones.

    Requirements of extras and requirements whose environment marker does not apply are skipped.

    Args:
        requires: ``Requires-Dist`` lines
        available: Installed versions by canonical distribution name
            (``plugin_wheel.installed_distributions()``), used for requirements on plugins
        packages: Versions used for the other requirements (default: ``available``). A runtime
            install passes environment_distributions(), so that a plugin does not rely on a
            package that only another runtime-installed plugin provides
    """
    missing: list[str] = []
    blocking: list[str] = []
    for line in requires:
        try:
            req = Requirement(line)
        except InvalidRequirement:
            blocking.append(f"{line} (invalid requirement)")
            continue
        if req.marker is not None and not req.marker.evaluate({"extra": ""}):
            continue
        name = canonicalize_name(req.name)
        if name in IGNORED_REQUIREMENTS:
            continue
        is_plugin = name.startswith(PLUGIN_DISTRIBUTION_PREFIX)
        version = (available if is_plugin or packages is None else packages).get(name)
        if version is None:
            if is_plugin:
                blocking.append(f"{req} (plugin not installed; install it first)")
            else:
                missing.append(str(req))
        elif req.specifier and not req.specifier.contains(version, prereleases=True):
            blocking.append(f"{req} (installed: {version})")
    return RequirementCheck(missing=missing, blocking=blocking)


def distributions_outside(*directories: Path) -> dict[str, str]:
    """Version of every installed distribution that does not lie in one of the directories, by canonical name."""
    bases = [d.resolve() for d in directories]
    result: dict[str, str] = {}
    for dist in importlib.metadata.distributions():
        name = dist.metadata["Name"]
        if not name:
            continue
        location = Path(str(dist.locate_file(""))).resolve()
        if any(location == base or base in location.parents for base in bases):
            continue
        result.setdefault(canonicalize_name(name), dist.version)
    return result


def environment_distributions(site_dir: Path) -> dict[str, str]:
    """Version of every installed distribution outside the plugin site directory, by canonical name."""
    return distributions_outside(site_dir)


def uv_command() -> list[str]:
    """
    The command that runs uv.

    Raises:
        DependencyError: If uv is not available
    """
    found = shutil.which("uv")
    if found:
        return [found]
    try:
        from uv import find_uv_bin  # type: ignore[import-not-found]

        return [str(find_uv_bin())]
    except (ImportError, FileNotFoundError):
        pass
    raise DependencyError("Installing plugin dependencies needs uv, which is not installed")


def _run(args: list[str], what: str) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("VIRTUAL_ENV")}
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=UV_TIMEOUT, env=env, check=False)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise DependencyError(f"Could not {what}: {e}") from e
    if result.returncode != 0:
        lines = [line for line in result.stderr.strip().splitlines() if line.strip()]
        raise DependencyError(f"Could not {what}: " + "\n".join(lines[-15:]))
    return result.stdout


def resolve(requirements: list[str], pins: dict[str, str], workdir: Path) -> list[str]:
    """
    Resolve requirements without changing any installed distribution.

    Args:
        requirements: Requirements to resolve
        pins: Versions to keep, by canonical distribution name (all installed distributions)
        workdir: Directory for the input files

    Returns:
        ``name==version`` of every package of the resolution

    Raises:
        DependencyError: If the requirements conflict with the installed versions or cannot be found
    """
    requirements_file = workdir / "requirements.in"
    constraints_file = workdir / "constraints.txt"
    requirements_file.write_text("\n".join(requirements) + "\n", encoding="utf-8")
    constraints_file.write_text("".join(f"{name}=={version}\n" for name, version in sorted(pins.items())), encoding="utf-8")
    output = _run(
        uv_command() + [
            "pip", "compile", str(requirements_file), "--constraint", str(constraints_file),
            "--python", sys.executable, "--no-header", "--no-annotate", "--quiet",
        ],
        "resolve the plugin's packages",
    )
    resolved: list[str] = []
    for line in output.splitlines():
        match = _PINNED.match(line.strip())
        if match:
            resolved.append(f"{canonicalize_name(match['name'])}=={match['version']}")
    return resolved


def to_install(resolved: list[str], environment: dict[str, str]) -> list[str]:
    """The resolved packages that the environment does not provide."""
    return [spec for spec in resolved if canonicalize_name(spec.split("==", 1)[0]) not in environment]


def install(packages: list[str], target: Path) -> None:
    """
    Install pinned packages, without their dependencies, into a directory.

    Raises:
        DependencyError: If the installation fails
    """
    if not packages:
        return
    _run(
        uv_command() + ["pip", "install", "--target", str(target), "--no-deps", "--python", sys.executable, *packages],
        "install the plugin's packages",
    )
    logger.info(f"Installed plugin packages into {target}: {', '.join(packages)}")


def install_missing(
    missing: list[str], site_dir: Path, target: Path, workdir: Path, replaced: Path | None = None
) -> list[str]:
    """
    Resolve and install the missing requirements of a plugin into its version directory.

    Args:
        missing: Requirements that are not installed (RequirementCheck.missing)
        site_dir: Plugin site directory
        target: The plugin's version directory
        workdir: Directory for temporary files
        replaced: Version directory of the version being upgraded, whose packages are not pinned

    Returns:
        The installed packages (``name==version``)

    Raises:
        DependencyError: If resolving or installing fails
    """
    if not missing:
        return []
    pins = distributions_outside(*(d for d in (target, replaced) if d is not None))
    resolved = resolve(missing, pins, workdir)
    packages = to_install(resolved, environment_distributions(site_dir))
    install(packages, target)
    return packages
