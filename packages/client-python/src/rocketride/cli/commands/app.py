# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
App lifecycle commands: ``app create/deploy/verify``.

``app deploy`` is a DEPLOYMENT-TARGET verb (ROCKETRIDE_DEPLOY_* pair,
hard stop when absent). ``app create`` is a DEV-workspace operation that
vendors platform packages from the development server. ``app verify``
needs no connection at all. Kept in exact parity with the TypeScript
CLI's ``src/cli/commands/app.ts``.
"""

import os

from rocketride_common.provision import to_http_base

from ..utils.common import connect_client, run_cli_command
from ..utils.env import NO_DEPLOY_TARGET_MESSAGE
from ..utils.output import Output


async def run_app(args) -> int:
    """
    Execute one ``app`` subcommand.

    Args:
        args: Parsed argparse namespace (app_subcommand + verb args).

    Returns:
        Exit code.
    """

    async def action(out: Output) -> int:
        subcommand = args.app_subcommand

        # app deploy: deployment-target verb — the ROCKETRIDE_DEPLOY_*
        # pair, never the development connection as a fallback
        if subcommand == 'deploy':
            if not args.uri:
                return out.fail(NO_DEPLOY_TARGET_MESSAGE)
            client = await connect_client(args.uri, args.apikey)
            on_progress = (lambda line: out.line(f'  {line}')) if args.verbose else None
            result = await client.deploy.add_app(
                args.folder,
                workspace_root=args.workspace,
                comment=args.comment,
                on_progress=on_progress,
            )
            artifact = result.get('artifact') or {}
            name = f' ({artifact["name"]})' if artifact.get('name') else ''
            out.line(f'Deployed app version v{artifact.get("version", "?")}{name}')
            if artifact.get('projectId'):
                out.line(f'Project: {artifact["projectId"]}')
            out.line('Deploying activates nothing - publish a rung to serve it.')
            out.result(
                {
                    'projectId': artifact.get('projectId'),
                    'version': artifact.get('version'),
                    'name': artifact.get('name'),
                }
            )
            return 0

        # app create: scaffold a new app — the programmatic twin of the
        # App Builder wizard; vendoring reads the DEVELOPMENT server
        if subcommand == 'create':
            from ..._app_scaffold import create_app_workspace

            server_base_url = to_http_base(args.uri) if args.uri else None
            created = create_app_workspace(
                args.workspace or os.getcwd(),
                args.slug,
                template=args.template,
                display_name=args.name,
                developer_id=args.developer,
                sidebar=bool(args.sidebar),
                status_footer=args.status_footer,
                doc_tabs=bool(args.doc_tabs),
                install=args.install,
                server_base_url=server_base_url,
                on_progress=lambda line: out.line(f'  {line}'),
            )
            out.line(f'Created {created["appId"]} at {created["folder"]}')
            out.line(
                f'Open {created["folder"]}/{args.slug}.rrapp in VS Code for the App Builder, or edit {created["folder"]}/src/App.tsx directly.'
            )
            out.result({'appId': created['appId'], 'folder': created['folder']})
            return 0

        # app verify: local precheck, no server connection at all
        if subcommand == 'verify':
            from ..._app_pack import verify_app_source

            report = verify_app_source(args.workspace or os.getcwd(), args.folder)
            for check in report.checks:
                out.line(f'{"OK  " if check.ok else "FAIL"}  {check.id}: {check.note}')
            if report.ok:
                out.line(f'Ready to deploy: {report.file_count} files, {report.uncompressed_bytes} bytes uncompressed.')
            else:
                out.line('Not ready - fix the FAIL lines above.')
            out.result(
                {
                    'ok': report.ok,
                    'checks': [{'id': c.id, 'ok': c.ok, 'note': c.note} for c in report.checks],
                    'fileCount': report.file_count,
                    'uncompressedBytes': report.uncompressed_bytes,
                }
            )
            return 0 if report.ok else 1

        return out.fail(f'Unknown app subcommand: {subcommand}')

    return await run_cli_command(args, action)
