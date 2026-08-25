# Copyright 2026 Aparavi Software AG. MIT License.
"""Engine access seam for the MCP module.

The MCP tool/resource logic depends only on the ``EngineClient`` protocol. The
v0 implementation reuses the ``RocketRideClient`` WS SDK so the server runs
today; a later revision can swap in direct in-process ``modules/task`` calls
without touching any tool code.
"""

import asyncio
import os
from typing import Any, Dict, List, Optional, Protocol, runtime_checkable


class LogNotFound(KeyError):
    """A requested run-log chapter or trace is absent or evicted.

    Raised by the log seam (``log_traces`` on an unknown ``chapter_begin_seq``,
    ``log_trace`` on a ``begin_seq`` below the retention horizon) so the tool
    layer can catch this exact condition without also swallowing incidental
    ``KeyError``s from unrelated dict lookups. Subclasses ``KeyError`` to keep
    the seam's original contract.
    """


@runtime_checkable
class EngineClient(Protocol):
    @property
    def base_url(self) -> str: ...
    async def list_tasks(self) -> List[dict]: ...
    async def list_nodes(self) -> List[dict]: ...
    async def send(
        self,
        token: str,
        data: Any,
        objinfo: Optional[Dict[str, Any]] = None,
        mimetype: Optional[str] = None,
        on_sse: Optional[Any] = None,
    ) -> Any: ...
    async def get_services(self) -> Dict[str, Any]: ...
    async def get_service(self, name: str) -> Optional[Dict[str, Any]]: ...
    async def validate(self, pipeline: dict, source: Optional[str] = None) -> Dict[str, Any]: ...
    async def use(self, **kwargs: Any) -> Dict[str, Any]: ...
    async def terminate(self, token: str) -> None: ...
    async def send_files(self, files: List[Any], token: str) -> Any: ...
    async def fs_read_string(self, path: str) -> str: ...
    async def fs_list_dir(self, path: str = '') -> Dict[str, Any]: ...
    async def save_template(self, template_id: str, pipeline: dict) -> None: ...
    async def get_template(self, template_id: str) -> Dict[str, Any]: ...
    async def deploy_add(self, pipeline: dict, schedule: Optional[str] = None) -> Dict[str, Any]: ...
    async def deploy_list(self) -> List[Dict[str, Any]]: ...
    async def get_task_status(self, token: str) -> Dict[str, Any]: ...
    async def fs_stat(self, path: str) -> Dict[str, Any]: ...
    async def fs_get_url(self, path: str, expires_in: int = 3600, download_name: Optional[str] = None) -> str: ...
    async def deploy_status(self, project_id: str) -> Dict[str, Any]: ...
    async def deploy_remove(self, project_id: str) -> None: ...
    async def deploy_update(
        self, project_id: str, pipeline: Optional[dict] = None, schedule: Optional[str] = None
    ) -> None: ...
    async def log_chapters(self, project_id: str, source: str, team_id: str = '') -> Dict[str, Any]: ...
    async def log_read(
        self,
        project_id: str,
        source: str,
        team_id: str = '',
        *,
        from_seq: Optional[int] = None,
        cursor: Optional[int] = None,
        max_events: Optional[int] = None,
        max_bytes: Optional[int] = None,
        types: Optional[List[str]] = None,
    ) -> Dict[str, Any]: ...
    async def log_traces(
        self,
        project_id: str,
        source: str,
        team_id: str = '',
        *,
        n: int = 20,
        chapter_begin_seq: Optional[int] = None,
    ) -> Dict[str, Any]: ...
    async def log_trace(
        self, project_id: str, source: str, team_id: str = '', *, begin_seq: int = 0
    ) -> Dict[str, Any]: ...
    async def get_environment_keys(self) -> List[str]: ...
    async def close(self) -> None: ...


class WsEngineClient:
    """v0 seam impl: wraps the RocketRideClient WS/DAP SDK.

    ``RocketRideClient.request()``/``use()``/``send()`` do not auto-connect —
    the underlying DAP ``request()`` raises ``RuntimeError('Server is not
    connected')`` unless ``connect()`` has already succeeded (constructor only
    builds the client; the transport is created by ``connect()``/``attach()``).
    This shim connects lazily on first use and reuses the connection for the
    lifetime of the client, guarded by a lock so concurrent calls don't race
    to open the socket twice.
    """

    def __init__(self, uri: str, auth: str) -> None:
        from rocketride import RocketRideClient  # deferred import; SDK on the engine env

        self._client = RocketRideClient(uri=uri, auth=auth)
        self._uri = uri
        self._connected = False
        self._connect_lock = asyncio.Lock()

    @property
    def base_url(self) -> str:
        """HTTP(S) base for the engine REST surface, derived from the WS/HTTP uri.

        The data-ingress endpoint (`/task/data`) is HTTP, but ``ROCKETRIDE_URI``
        may be a ``ws://`` URL. Normalize the scheme and strip any trailing slash.
        """
        uri = self._uri
        if uri.startswith('ws://'):
            uri = 'http://' + uri[len('ws://') :]
        elif uri.startswith('wss://'):
            uri = 'https://' + uri[len('wss://') :]
        return uri.rstrip('/')

    async def _ensure_connected(self) -> None:
        if self._connected:
            return
        async with self._connect_lock:
            if not self._connected:
                await self._client.connect()
                self._connected = True

    def _note_transport_error(self, exc: BaseException) -> None:
        """Clear the cached connected flag when ``exc`` signals a lost transport.

        Without this, the process-wide singleton latches ``_connected`` and
        every later call fails with the SDK's ``RuntimeError('Server is not
        connected')`` until the process restarts. The RuntimeError match is
        narrowed to that message: clearing the flag on an unrelated
        RuntimeError would make the next call re-``connect()`` an already-live
        SDK client.
        """
        if isinstance(exc, ConnectionError) or (isinstance(exc, RuntimeError) and 'not connected' in str(exc).lower()):
            self._connected = False

    async def _guarded(self, call: Any) -> Any:
        """Connect lazily, await ``call()``, and un-latch on transport loss
        so the next tool call reconnects instead of failing forever.
        """
        await self._ensure_connected()
        try:
            return await call()
        except (ConnectionError, RuntimeError) as exc:
            self._note_transport_error(exc)
            raise

    async def close(self) -> None:
        """Tear down the connection. Safe to call even if never connected.

        Takes the connect lock so a concurrent ``_ensure_connected`` cannot
        mark the client connected while teardown runs; the flag clears even
        if ``disconnect()`` raises.
        """
        async with self._connect_lock:
            if self._connected:
                try:
                    await self._client.disconnect()
                finally:
                    self._connected = False

    async def _request(self, command: str) -> dict:
        async def _do() -> Any:
            req = self._client.build_request(command=command)
            return await self._client.request(req)

        resp = await self._guarded(_do)
        return (resp or {}).get('body') or {}

    async def list_tasks(self) -> List[dict]:
        return (await self._request('rrext_get_tasks')).get('tasks', [])

    async def list_nodes(self) -> List[dict]:
        return (await self._request('rrext_get_nodes')).get('nodes', [])

    async def send(
        self,
        token: str,
        data: Any,
        objinfo: Optional[Dict[str, Any]] = None,
        mimetype: Optional[str] = None,
        on_sse: Optional[Any] = None,
    ) -> Any:
        return await self._guarded(
            lambda: self._client.send(token, data, objinfo=objinfo, mimetype=mimetype, on_sse=on_sse)
        )

    async def get_services(self) -> Dict[str, Any]:
        return await self._guarded(lambda: self._client.get_services())

    async def get_service(self, name: str) -> Optional[Dict[str, Any]]:
        return await self._guarded(lambda: self._client.get_service(name))

    async def validate(self, pipeline: dict, source: Optional[str] = None) -> Dict[str, Any]:
        return await self._guarded(lambda: self._client.validate(pipeline, source=source))

    async def use(self, **kwargs: Any) -> Dict[str, Any]:
        return await self._guarded(lambda: self._client.use(**kwargs))

    async def terminate(self, token: str) -> None:
        await self._guarded(lambda: self._client.terminate(token))

    async def send_files(self, files: List[Any], token: str) -> Any:
        return await self._guarded(lambda: self._client.send_files(files, token))

    async def fs_read_string(self, path: str) -> str:
        return await self._guarded(lambda: self._client.fs_read_string(path))

    async def fs_list_dir(self, path: str = '') -> Dict[str, Any]:
        return await self._guarded(lambda: self._client.fs_list_dir(path))

    async def save_template(self, template_id: str, pipeline: dict) -> None:
        await self._guarded(lambda: self._client.save_template(template_id, pipeline))

    async def get_template(self, template_id: str) -> Dict[str, Any]:
        return await self._guarded(lambda: self._client.get_template(template_id))

    async def deploy_add(self, pipeline: dict, schedule: Optional[str] = None) -> Dict[str, Any]:
        return await self._guarded(lambda: self._client.deploy.add(pipeline, schedule=schedule))

    async def deploy_list(self) -> List[Dict[str, Any]]:
        return await self._guarded(lambda: self._client.deploy.list())

    async def get_task_status(self, token: str) -> Dict[str, Any]:
        return await self._guarded(lambda: self._client.get_task_status(token))

    async def fs_stat(self, path: str) -> Dict[str, Any]:
        return await self._guarded(lambda: self._client.fs_stat(path))

    async def fs_get_url(self, path: str, expires_in: int = 3600, download_name: Optional[str] = None) -> str:
        return await self._guarded(
            lambda: self._client.fs_get_url(path, expires_in=expires_in, download_name=download_name)
        )

    async def deploy_status(self, project_id: str) -> Dict[str, Any]:
        return await self._guarded(lambda: self._client.deploy.status(project_id))

    async def deploy_remove(self, project_id: str) -> None:
        await self._guarded(lambda: self._client.deploy.remove(project_id))

    async def deploy_update(
        self, project_id: str, pipeline: Optional[dict] = None, schedule: Optional[str] = None
    ) -> None:
        await self._guarded(lambda: self._client.deploy.update(project_id, pipeline=pipeline, schedule=schedule))

    async def log_chapters(self, project_id: str, source: str, team_id: str = '') -> Dict[str, Any]:
        return await self._guarded(lambda: self._client.log.chapters(project_id, source, team_id=team_id))

    async def log_read(
        self,
        project_id: str,
        source: str,
        team_id: str = '',
        *,
        from_seq: Optional[int] = None,
        cursor: Optional[int] = None,
        max_events: Optional[int] = None,
        max_bytes: Optional[int] = None,
        types: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        return await self._guarded(
            lambda: self._client.log.read(
                project_id,
                source,
                team_id=team_id,
                from_seq=from_seq,
                cursor=cursor,
                max_events=max_events,
                max_bytes=max_bytes,
                types=types,
            )
        )

    async def log_traces(
        self,
        project_id: str,
        source: str,
        team_id: str = '',
        *,
        n: int = 20,
        chapter_begin_seq: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Return the SDK's raw trace-summary shape verbatim: ``{'open': [...], 'closed': [...]}``.

        This seam is a faithful transport — it does not flatten or reshape the
        SDK result. Callers (the ``log_traces`` MCP tool) are responsible for
        picking the right list(s) out of the two buckets.

        By default (``chapter_begin_seq=None``) the session seeks ``'live'``,
        so traces come back for whatever is most recent. Passing
        ``chapter_begin_seq`` instead addresses a specific past run: it looks
        up that chapter via ``log.chapters()`` (matching its ``beginSeq``),
        then seeks to that chapter's ``endTime`` (or ``'live'`` if the
        chapter has no ``endTime`` — i.e. it is still open) before reading
        traces, so the result reflects that run's activity rather than the
        latest one. No matching chapter raises ``LogNotFound(chapter_begin_seq)``
        — callers (the ``log_traces`` MCP tool) map that to a structured
        not-found result the same way ``log_trace`` already maps an expired
        ``beginSeq``.
        """
        await self._ensure_connected()
        session = self._client.log.open_event_stream(project_id, source, team_id=team_id)
        try:
            if chapter_begin_seq is None:
                await session.seek('live')
            else:
                chapters_result = await self._client.log.chapters(project_id, source, team_id=team_id)
                chapters = (chapters_result or {}).get('chapters') or []
                chapter = next((c for c in chapters if c.get('beginSeq') == chapter_begin_seq), None)
                if chapter is None:
                    raise LogNotFound(chapter_begin_seq)
                end_time = chapter.get('endTime')
                await session.seek('live' if end_time is None else end_time)
            return await session.get_traces(n)
        except (ConnectionError, RuntimeError) as exc:
            self._note_transport_error(exc)
            raise
        finally:
            session.close_event_stream()

    async def log_trace(self, project_id: str, source: str, team_id: str = '', *, begin_seq: int = 0) -> Dict[str, Any]:
        """Return the SDK's raw trace-detail shape verbatim: ``{'summary': {...}, 'events': [...]}``.

        This seam is a faithful transport — it does not unwrap ``events`` out
        of the result. Callers (the ``log_trace`` MCP tool) are responsible
        for picking the fields they need out of the dict.
        """
        await self._ensure_connected()
        session = self._client.log.open_event_stream(project_id, source, team_id=team_id)
        try:
            await session.seek('live')
            try:
                return await session.get_trace(begin_seq)
            except KeyError as exc:
                # get_trace() contracts a plain KeyError for a begin_seq with
                # no trace — never recorded, or expired below the retention
                # horizon (log_stream.py). Translate it to the module's typed
                # LogNotFound at this seam so the tool layer's catch cannot
                # swallow unrelated KeyErrors.
                raise LogNotFound(begin_seq) from exc
        except (ConnectionError, RuntimeError) as exc:
            self._note_transport_error(exc)
            raise
        finally:
            session.close_event_stream()

    async def get_environment_keys(self) -> List[str]:
        return await self._guarded(lambda: self._client.account.get_environment_keys())


def make_engine_client(config: Dict[str, Any]) -> EngineClient:
    """Build the seam client. ``config`` keys (``rocketride_uri``,
    ``rocketride_auth``) take precedence; the environment variables are the
    fallback so existing deployments keep working unchanged.
    """
    config = config or {}
    uri = config.get('rocketride_uri') or os.environ.get('ROCKETRIDE_URI') or ''
    auth = (
        config.get('rocketride_auth') or os.environ.get('ROCKETRIDE_AUTH') or os.environ.get('ROCKETRIDE_APIKEY') or ''
    )
    if not uri:
        raise ValueError('Missing engine URI: set config rocketride_uri or env ROCKETRIDE_URI')
    if not auth:
        raise ValueError('Missing engine auth: set config rocketride_auth or env ROCKETRIDE_AUTH/ROCKETRIDE_APIKEY')
    return WsEngineClient(uri=uri, auth=auth)
