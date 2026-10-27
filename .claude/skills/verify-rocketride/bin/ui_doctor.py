"""Check that the browser UIs a run serves match this checkout's source.

Usage (through `rr-verify doctor`): ui_doctor.py REPO RUN_DIR

For each UI it prints one `WARN` line when the UI is stale, and an `ok` summary line for the
rest. A UI is stale when a source file is newer than its newest build output, when the copy
the engine serves differs from the build, or (for shell apps) when the bundle seeded into this
run's store at launch differs from the build. Always exits 0: these are warnings.
"""

import filecmp
import json
import os
import sys
from pathlib import Path

SKIP_DIRS = {'node_modules', '__tests__', '__pycache__', 'dist', 'build'}
# Every client-typescript:build rewrites this file's version line, so its time says nothing about edits.
SKIP_FILES = {'packages/client-typescript/src/client/constants.ts'}


def is_test(name: str) -> bool:
    return '.test.' in name or '.spec.' in name


def walk(paths, repo: Path):
    """Yield every source file under the given repo-relative files and directories."""
    for rel in paths:
        p = repo / rel
        if p.is_file():
            yield p
        elif p.is_dir():
            for root, dirs, files in os.walk(p):
                dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
                for name in files:
                    f = Path(root) / name
                    if not is_test(name) and str(f.relative_to(repo)) not in SKIP_FILES:
                        yield f


def newest_mtime(directory: Path) -> float:
    best = 0.0
    for root, _, files in os.walk(directory):
        for name in files:
            try:
                best = max(best, (Path(root) / name).stat().st_mtime)
            except OSError:
                pass
    return best


def ui_table(repo: Path):
    """Return (name, build dir, served dir, entry file, sources, rebuild command) for every UI."""
    sdk = 'packages/client-typescript/src'
    uis = [
        (
            'shell',
            'build/shell',
            'dist/server/static/shell',
            'index.html',
            [
                'packages/shell/src',
                'packages/shell/public',
                'packages/shell/index.html',
                'packages/shell/package.json',
                'packages/shell/rsbuild.config.mts',
                sdk,
            ],
            './builder shell:build',
        ),
    ]
    for name, served in (('chat-ui', 'chat'), ('dropper-ui', 'dropper')):
        uis.append(
            (
                name,
                f'build/{name}',
                f'dist/server/static/{served}',
                'index.html',
                [
                    f'apps/{name}/src',
                    f'apps/{name}/public',
                    f'apps/{name}/package.json',
                    f'apps/{name}/rsbuild.config.mts',
                    sdk,
                ],
                f'./builder {name}:build',
            )
        )
    for pkg in sorted(repo.glob('apps/*/package.json')):
        try:
            manifest = json.loads(pkg.read_text()).get('appManifest', {})
        except (OSError, ValueError):
            continue
        app_id = manifest.get('id')
        if not app_id:
            continue
        name = pkg.parent.name
        # The shell shows the manifest's icon, which some apps keep outside src/.
        icon = [f'apps/{name}/{manifest["icon"].removeprefix("./")}'] if manifest.get('icon') else []
        uis.append(
            (
                name,
                f'build/apps/{app_id}',
                f'dist/server/static/apps/{app_id}',
                'remoteEntry.js',
                [
                    f'apps/{name}/src',
                    f'apps/{name}/public',
                    f'apps/{name}/package.json',
                    f'apps/{name}/rsbuild.config.mts',
                    f'apps/{name}/rsbuild.config.ts',
                    'apps/shared/src',
                    *icon,
                ],
                f'./builder {name}:build',
            )
        )
    return uis


def seeded_entry(run_dir: Path, app_id: str):
    """Return the remoteEntry.js of the newest version seeded into this run's store, if any."""
    deployments = run_dir / 'store' / 'orgs' / 'local' / 'files' / '.deployments' / app_id
    versions = sorted(d for d in deployments.glob('v*-*') if d.is_dir())
    return versions[-1] / 'dist' / 'remoteEntry.js' if versions else None


def main() -> int:
    repo, run_dir = Path(sys.argv[1]), Path(sys.argv[2])
    run_store = (run_dir / 'store').is_dir()
    fresh = []
    for name, build, served, entry, sources, rebuild in ui_table(repo):
        build_dir, served_dir = repo / build, repo / served
        if not served_dir.is_dir():
            print(f'WARN {name}: nothing is served from {served}. Run {rebuild}')
            continue
        if not (build_dir / entry).is_file():
            print(
                f'WARN {name}: no build output in {build}, so {served} did not come from this checkout. Run {rebuild}'
            )
            continue
        built_at = newest_mtime(build_dir)
        newer = [p for p in walk(sources, repo) if p.stat().st_mtime > built_at]
        if newer:
            example = newer[0].relative_to(repo)
            print(
                f'WARN {name}: {len(newer)} source file(s) changed since the last build, such as {example}. Run {rebuild} (add --force if it prints "No changes detected")'
            )
            continue
        if not filecmp.cmp(build_dir / entry, served_dir / entry, shallow=False):
            print(f'WARN {name}: {served}/{entry} differs from {build}/{entry}. Run {rebuild}')
            continue
        if build.startswith('build/apps/') and run_store:
            app_id = build.rsplit('/', 1)[1]
            seeded = seeded_entry(run_dir, app_id)
            if seeded is None or not seeded.is_file():
                print(
                    f"WARN {name}: {app_id} is not seeded in this run's store yet. Wait a few seconds and run doctor again"
                )
                continue
            if not filecmp.cmp(seeded, served_dir / entry, shallow=False):
                print(
                    f'WARN {name}: this run serves the {app_id} bundle seeded at launch, which differs from {served}. Launch a new run'
                )
                continue
        fresh.append(name)
    if fresh:
        apps = [n for n in fresh if n not in ('shell', 'chat-ui', 'dropper-ui')]
        named = [n for n in fresh if n in ('shell', 'chat-ui', 'dropper-ui')]
        parts = named + ([f'{len(apps)} shell app(s)'] if apps else [])
        print(f"ok   this run serves UIs built from this checkout's current source: {', '.join(parts)}")
    if not run_store:
        print(
            'WARN this run shares ~/.rocketlib/store, so shell apps may load bundles another checkout seeded. Launch a new run'
        )

    docs = repo / 'dist' / 'docs'
    if not (docs / 'index.html').is_file():
        print('info the docs site is not built (./builder docs:build)')
    else:
        doc_sources = [
            'docs/public',
            'docs/docusaurus/src',
            'docs/docusaurus/apps',
            'docs/docusaurus/docusaurus.config.ts',
            'docs/docusaurus/sidebars.ts',
            'docs/docusaurus/redirects.ts',
        ]
        doc_sources += [str(p.relative_to(repo)) for p in repo.glob('nodes/src/nodes/*/README.md')]
        doc_sources += [str(p.relative_to(repo)) for p in repo.glob('nodes/src/nodes/*/*/README.md')]
        built_at = newest_mtime(docs)
        newer = [p for p in walk(doc_sources, repo) if p.stat().st_mtime > built_at]
        if newer:
            example = newer[0].relative_to(repo)
            print(
                f'WARN docs-site: {len(newer)} source file(s) changed since dist/docs was built, such as {example}. Run ./builder docs:build'
            )
        else:
            print('ok   the docs site in dist/docs is newer than its sources')
    return 0


if __name__ == '__main__':
    sys.exit(main())
