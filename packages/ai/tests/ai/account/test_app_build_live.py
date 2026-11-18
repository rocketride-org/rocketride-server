"""Real pinned compilers exercise CSS, loader denial and tsconfig read bounds.

Set RR_TEST_APP_COMPILERS=1 to require these checks. The suite bootstraps the
same platform pins as the worker; it never replaces tsc, rsbuild or the guard.
"""

import json
import os

import pytest

from ai.account import app_build as build


@pytest.mark.integration
@pytest.mark.asyncio
async def test_real_compilers_css_loaders_and_tsconfig_boundary(monkeypatch, tmp_path):
    if os.environ.get('RR_TEST_APP_COMPILERS') != '1':
        pytest.skip('set RR_TEST_APP_COMPILERS=1 to run the required live compiler gate')
    monkeypatch.setenv('RR_APP_BUILD_SANDBOX', 'required')
    node = build._find_node()
    assert node, 'a platform Node executable is required'
    env = await build._ensure_toolchain_env()
    job, app = tmp_path / 'job', tmp_path / 'job' / 'app'
    src = app / 'src'
    src.mkdir(parents=True)
    (src / 'screens').mkdir()
    (app / 'package.json').write_text(json.dumps({'name': 'security-css-sample', 'private': True, 'version': '1.0.0'}))
    config = {
        'compilerOptions': {
            'target': 'ES2020',
            'module': 'ESNext',
            'moduleResolution': 'Bundler',
            'strict': True,
            'skipLibCheck': True,
        },
        'include': ['src'],
    }
    tsconfig = app / 'tsconfig.json'
    tsconfig.write_text(json.dumps(config))
    (src / 'index.ts').write_text("import('./AppDescriptor');")
    descriptor = src / 'AppDescriptor.ts'
    descriptor.write_text(
        "import './base.css'; import styles from './style.module.css';\n"
        'export const load = (name: string) => import(`./screens/${name}.ts`);\n'
        "export default { name: 'sample', className: styles.panel };"
    )
    (src / 'screens' / 'sample.ts').write_text('export default 42;')
    (src / 'base.css').write_text('@import "./imported.css"; body { color: #123456; }')
    (src / 'imported.css').write_text('.from-import { display: block; }')
    (src / 'style.module.css').write_text('.panel { margin: 2px; }')
    (src / 'types.d.ts').write_text(
        "declare module '*.module.css' { const styles: Record<string,string>; export default styles; }"
    )
    build._link_toolchain(str(job), env)
    rsconfig = build._emit_config(str(job / '.build'), str(app), str(job / '.out'), 'security_css_sample', env)
    tsc = build._resolve_platform_tsc(env)
    rsbuild = build._resolve_bin(env, '@rsbuild/core', ('rsbuild',))
    assert tsc and rsbuild
    tsc_argv = [
        node,
        tsc,
        '--noEmit',
        '--incremental',
        'false',
        '--composite',
        'false',
        '--tsBuildInfoFile',
        'null',
        '-p',
        str(tsconfig),
    ]

    async def run(argv):
        return await build._exec_compiler(argv, str(app), 120, str(job), env)

    code, output = await run(tsc_argv)
    assert code == 0, output
    bundler_argv = [node, rsbuild, 'build', '--config', rsconfig]
    code, output = await run(bundler_argv)
    assert code == 0, output
    assert (job / '.out' / 'remoteEntry.js').is_file()
    css = '\n'.join(p.read_text() for p in (job / '.out').rglob('*.css'))
    assert 'from-import' in css and 'margin:2px' in css

    marker = job / 'loader-executed'
    (src / 'evil-loader.cjs').write_text(
        'module.exports = function(source) { require("node:fs").writeFileSync('
        + json.dumps(str(marker))
        + ', "executed"); return source; };'
    )
    (src / 'payload.js').write_text('export default 42;')
    descriptor.write_text("import value from '!!./evil-loader.cjs!./payload.js'; export default {value};")
    code, output = await run(bundler_argv)
    assert code != 0 and 'module or loader outside the app build tree' in output
    assert not marker.exists(), 'the developer loader executed before the guard'

    # TypeScript reads these inputs itself, before the bundler guard can run.
    # A successful unisolated compile would reveal this declaration's value.
    outside = tmp_path / 'another-tenant.d.ts'
    outside.write_text('declare const outsideValue: string;')
    descriptor.write_text('export default outsideValue;')
    for key in ('files', 'include'):
        attack = dict(config, **{key: ['src/AppDescriptor.ts', str(outside)]})
        tsconfig.write_text(json.dumps(attack))
        code, output = await run(tsc_argv)
        assert code != 0 and ('outsideValue' in output or 'not found' in output), (key, output)
    outside_config = tmp_path / 'another-tenant-tsconfig.json'
    outside_config.write_text(json.dumps(config))
    tsconfig.write_text(json.dumps({'extends': str(outside_config), 'include': ['src']}))
    code, output = await run(tsc_argv)
    assert code != 0 and 'Cannot read file' in output

    outside_types = tmp_path / 'another-tenant-types' / 'secret'
    outside_types.mkdir(parents=True)
    (outside_types / 'index.d.ts').write_text('declare const outsideValue: string;')
    options = dict(config['compilerOptions'], typeRoots=[str(outside_types.parent)])
    tsconfig.write_text(json.dumps(dict(config, compilerOptions=options)))
    code, output = await run(tsc_argv)
    assert code != 0 and 'outsideValue' in output

    descriptor.write_text("import {secret} from 'tenant-secret'; export default secret;")
    outside_module = tmp_path / 'another-tenant-module.d.ts'
    outside_module.write_text('export declare const secret: string;')
    options = dict(config['compilerOptions'], baseUrl='.', paths={'tenant-secret': [str(outside_module)]})
    tsconfig.write_text(json.dumps(dict(config, compilerOptions=options)))
    code, output = await run(tsc_argv)
    assert code != 0 and "Cannot find module 'tenant-secret'" in output
