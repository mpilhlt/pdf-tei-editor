# Runtime plugin install: packages from direct references

## Problem

Enabling mpcdf-llm 2.0.0 after a runtime install failed with `ModuleNotFoundError: No module named 'mpcdf_llm'`. The plugin requires `mpcdf-llm[fastapi,testing] @ git+https://gitlab.mpcdf.mpg.de/cboul/llm-mpcdf.git@<sha>`. `uv pip compile` prints such a package as `mpcdf-llm @ git+https://...`, but `plugin_deps.resolve()` only parsed `name==version` lines and silently dropped the others, so the library's dependencies were installed into the version directory and the library itself was not.

## Change

- `resolve()` also returns `name @ url` for direct references, and refuses any other line of uv output instead of skipping it, so a package can no longer go missing without an error.
- `to_install()` reads the name of both forms (`spec_name()`).
- `install()` passes the `name @ url` spec to `uv pip install --target`, which builds it (git is in the image).

Verified against the real requirement of mpcdf-llm: `install_missing()` installs `mpcdf_llm` into the target directory. Tests in `tests/unit/fastapi/test_plugin_deps.py` use a `file://` wheel URL.

An installation that is already broken is repaired by removing the plugin in the Plugin Manager and installing it again (the same version can be installed again before the restart since the previous change).
