# Retained images

Do not delete or move the files in this directory, or `docs/images/canvas.png`
and `docs/images/trace.png`, without republishing every package that links to
them.

Already-published, immutable artifacts hot-link these files by raw GitHub URL
on a branch name, so the URL cannot be redirected:

| Artifact | Links to |
| --- | --- |
| npm `rocketride@1.3.0` | `main/images/banner-typescript.png`, `main/images/install.png`, `develop/docs/images/canvas.png` |
| PyPI `rocketride 1.3.0` | `main/images/banner-python.png`, `main/images/install.png`, `develop/docs/images/canvas.png` |
| PyPI `rocketride-mcp 1.3.0` | `main/images/banner-mcp.png` |
| VS Code Marketplace `RocketRide.rocketride 1.3.0` | `main/images/banner-vscode.png`, `develop/docs/images/canvas.png`, `develop/docs/images/trace.png` |

The current package READMEs use per-client `assets/` paths instead, so these
files can be removed once every one of those registry pages has been
republished from a README that no longer references them.
