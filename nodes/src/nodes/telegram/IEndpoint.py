# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

import json
import os
import argparse
import sys
import asyncio
import secrets
import uuid
from typing import Any, Callable, Dict
from rocketlib import IEndpointBase, monitorOther, monitorStatus, monitorCompleted, monitorFailed, debug, getObject, AVI_ACTION
from ai.web import WebServer

from depends import depends  # type: ignore

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)


class IEndpoint(IEndpointBase):
    """
    IEndpoint for the Telegram Bot source node.

    Receives messages from a Telegram bot via long polling or webhook,
    routes each message type to the appropriate pipeline lane, and
    sends the pipeline response back to the Telegram chat.
    """

    target: IEndpointBase | None = None
    _server: WebServer | None = None
    _poll_task: asyncio.Task | None = None
    _http_session = None  # aiohttp.ClientSession
    _bot_token: str = ''
    _mode: str = 'polling'
    _webhook_url: str = ''
    _webhook_secret: str = ''
    _inflight: set

    def _get_telegram_config(self) -> Dict[str, Any]:
        """Read the telegram config block from serviceConfig parameters.

        The engine strips the field namespace prefix ('telegram.') before
        storing values, so keys arrive flat: 'botToken', 'mode', 'webhookUrl'.
        """
        try:
            parameters = self.endpoint.serviceConfig['parameters']
            return parameters
        except Exception as e:
            debug(f'Telegram _get_telegram_config: EXCEPTION {e}')
            return {}

    async def _startup(self):
        # Config was already loaded in _run() (sync context) — use stored values
        if not self._bot_token:
            monitorStatus('Telegram Bot: missing bot token')
            return

        import aiohttp

        self._inflight = set()
        self._http_session = aiohttp.ClientSession()

        if self._mode == 'webhook':
            self._webhook_secret = secrets.token_hex(32)
            await self._setup_webhook()
        else:
            await self._clear_webhook()
            self._poll_task = asyncio.create_task(self._poll_loop())

        info = {
            'url-text': 'Telegram Bot',
            'url-link': 'https://t.me/',
            'auth-text': 'Bot Token (last 6 chars)',
            'auth-key': f'...{self._bot_token[-6:]}' if len(self._bot_token) >= 6 else '(set)',
        }
        monitorOther('usr', json.dumps([info]))
        monitorStatus('Telegram Bot ready - waiting for messages')

    async def _shutdown(self):
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
            self._poll_task = None

        if self._inflight:
            await asyncio.gather(*self._inflight, return_exceptions=True)

        if self._mode == 'webhook' and self._bot_token:
            await self._delete_webhook()

        if self._http_session:
            await self._http_session.close()
            self._http_session = None

        monitorOther('usr')

    # -------------------------------------------------------------------------
    # Webhook management
    # -------------------------------------------------------------------------

    async def _setup_webhook(self):
        """Register the webhook URL with Telegram."""
        if not self._webhook_url:
            debug('Telegram: webhook mode selected but no webhook URL configured')
            return
        await self._delete_webhook()
        url = f'https://api.telegram.org/bot{self._bot_token}/setWebhook'
        async with self._http_session.post(url, json={'url': self._webhook_url, 'secret_token': self._webhook_secret}) as resp:
            data = await resp.json()
            if not data.get('ok'):
                debug(f'Telegram: setWebhook failed: {data}')

    async def _delete_webhook(self):
        """Tell Telegram to stop sending webhook calls."""
        try:
            url = f'https://api.telegram.org/bot{self._bot_token}/deleteWebhook'
            async with self._http_session.post(url) as resp:
                await resp.json()
        except Exception as e:
            debug(f'Telegram: deleteWebhook error: {e}')

    async def _clear_webhook(self):
        """Clear any previously registered webhook before starting polling."""
        await self._delete_webhook()

    # -------------------------------------------------------------------------
    # Long polling loop
    # -------------------------------------------------------------------------

    async def _poll_loop(self):
        """Background task: long-poll Telegram getUpdates indefinitely."""
        offset = 0
        poll_count = 0
        while True:
            try:
                url = f'https://api.telegram.org/bot{self._bot_token}/getUpdates'
                params = {'offset': offset, 'timeout': 30, 'limit': 100}
                import aiohttp

                async with self._http_session.get(
                    url,
                    params=params,
                    timeout=aiohttp.ClientTimeout(total=35),
                ) as resp:
                    data = await resp.json()

                poll_count += 1
                ok = data.get('ok')
                updates = data.get('result', []) if ok else []

                if ok:
                    for update in updates:
                        uid = update.get('update_id')
                        await self._handle_update(update)
                        offset = uid + 1

            except asyncio.CancelledError:
                break
            except Exception as e:
                debug(f'Telegram polling error: {e}')
                await asyncio.sleep(5)

    # -------------------------------------------------------------------------
    # Webhook route handler
    # -------------------------------------------------------------------------

    async def _webhook_handler(self, request):
        """FastAPI POST handler for incoming Telegram webhook calls."""
        from fastapi.responses import JSONResponse

        secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token', '')
        if secret != self._webhook_secret:
            return JSONResponse({'ok': False}, status_code=403)

        try:
            update = await request.json()
            task = asyncio.create_task(self._handle_update(update))
            self._inflight.add(task)
            task.add_done_callback(self._inflight.discard)
        except Exception as e:
            debug(f'Telegram webhook handler error: {e}')
        return JSONResponse({'ok': True})

    # -------------------------------------------------------------------------
    # Update routing
    # -------------------------------------------------------------------------

    async def _handle_update(self, update: dict):
        """Route a Telegram update to the correct pipeline lane."""
        uid = update.get('update_id')

        message = update.get('message') or update.get('edited_message')
        if not message:
            return

        chat_id = message.get('chat', {}).get('id')
        if not chat_id:
            return

        try:
            if 'text' in message:
                text = message['text']
                reply = await asyncio.to_thread(self._run_text_pipeline, text, chat_id)
            elif 'photo' in message:
                file_id = message['photo'][-1]['file_id']
                reply = await self._run_file_pipeline(file_id, 'image/jpeg', chat_id)
            elif 'document' in message:
                doc = message['document']
                mime = doc.get('mime_type', 'application/octet-stream')
                reply = await self._run_file_pipeline(doc['file_id'], mime, chat_id)
            elif 'audio' in message:
                audio = message['audio']
                mime = audio.get('mime_type', 'audio/mpeg')
                reply = await self._run_file_pipeline(audio['file_id'], mime, chat_id)
            elif 'voice' in message:
                voice = message['voice']
                mime = voice.get('mime_type', 'audio/ogg')
                reply = await self._run_file_pipeline(voice['file_id'], mime, chat_id)
            elif 'video' in message:
                video = message['video']
                mime = video.get('mime_type', 'video/mp4')
                reply = await self._run_file_pipeline(video['file_id'], mime, chat_id)
            else:
                return
            if reply:
                await self._send_message(chat_id, reply)

        except Exception as e:
            debug(f'Telegram: error processing update {uid}: {e}')

    # -------------------------------------------------------------------------
    # Pipeline execution — text
    # -------------------------------------------------------------------------

    def _run_text_pipeline(self, text: str, chat_id: int) -> str:
        """
        Push a text message through the pipeline on the text lane.
        Returns the answer text, or empty string if no answer was produced.
        Called in a thread (blocking).
        """
        entry = getObject(
            obj={
                'url': f'telegram://{chat_id}/{uuid.uuid4()}',
                'name': text[:200],
            }
        )
        pipe = self.target.getPipe()
        try:
            pipe.open(entry)
            pipe.writeText(text)
            pipe.close()
            results = entry.response.toDict()
            answers = results.get('answers', [])
            monitorCompleted(len(text.encode('utf-8')))
            return answers[0] if answers else ''
        except Exception as e:
            monitorFailed(len(text.encode('utf-8')))
            debug(f'Telegram: text pipeline error: {e}')
            return ''
        finally:
            self.target.putPipe(pipe)

    # -------------------------------------------------------------------------
    # Pipeline execution — binary files (images, audio, video, documents)
    # -------------------------------------------------------------------------

    async def _run_file_pipeline(self, file_id: str, mime_type: str, chat_id: int) -> str:
        """
        Download a Telegram file and push it through the appropriate pipeline lane.
        Returns the answer text, or empty string if no answer was produced.
        """
        file_data = await self._download_telegram_file(file_id)
        if not file_data:
            return ''

        return await asyncio.to_thread(self._run_binary_pipeline, file_data, mime_type, file_id, chat_id)

    def _run_binary_pipeline(self, file_data: bytes, mime_type: str, file_id: str, chat_id: int) -> str:
        """
        Push binary file data through the appropriate lane. Called in a thread (blocking).
        """
        entry = getObject(
            obj={
                'url': f'telegram://{chat_id}/{file_id}',
                'name': file_id,
                'size': len(file_data),
                'mimeType': mime_type,
            }
        )
        pipe = self.target.getPipe()
        try:
            pipe.open(entry)

            if mime_type.startswith('image/'):
                pipe.writeImage(AVI_ACTION.BEGIN, mime_type)
                pipe.writeImage(AVI_ACTION.WRITE, mime_type, file_data)
                pipe.writeImage(AVI_ACTION.END, mime_type)
            elif mime_type.startswith('audio/'):
                pipe.writeAudio(AVI_ACTION.BEGIN, mime_type)
                pipe.writeAudio(AVI_ACTION.WRITE, mime_type, file_data)
                pipe.writeAudio(AVI_ACTION.END, mime_type)
            elif mime_type.startswith('video/'):
                pipe.writeVideo(AVI_ACTION.BEGIN, mime_type)
                pipe.writeVideo(AVI_ACTION.WRITE, mime_type, file_data)
                pipe.writeVideo(AVI_ACTION.END, mime_type)
            else:
                # Document (PDF, Word, etc.) — write as tagged data for the tags lane,
                # which connects to a Parser node downstream
                pipe.writeTagBeginObject()
                pipe.writeTagBeginStream()
                pipe.writeTagData(file_data)
                pipe.writeTagEndStream()
                pipe.writeTagEndObject()

            pipe.close()
            results = entry.response.toDict()
            answers = results.get('answers', [])
            monitorCompleted(len(file_data))
            return answers[0] if answers else ''

        except Exception as e:
            monitorFailed(len(file_data))
            debug(f'Telegram: binary pipeline error ({mime_type}): {e}')
            return ''
        finally:
            self.target.putPipe(pipe)

    # -------------------------------------------------------------------------
    # Telegram API helpers
    # -------------------------------------------------------------------------

    async def _download_telegram_file(self, file_id: str) -> bytes | None:
        """Resolve a file_id to its download URL and fetch the bytes."""
        try:
            url = f'https://api.telegram.org/bot{self._bot_token}/getFile'
            async with self._http_session.get(url, params={'file_id': file_id}) as resp:
                data = await resp.json()
            if not data.get('ok'):
                debug(f'Telegram: getFile failed for {file_id}: {data}')
                return None
            file_path = data['result']['file_path']
            file_size = data['result'].get('file_size', 'unknown')
            debug(f'Telegram: file_path={file_path}, file_size={file_size}')
            download_url = f'https://api.telegram.org/file/bot{self._bot_token}/{file_path}'
            async with self._http_session.get(download_url) as resp:
                content = await resp.read()
                if len(content) == 0:
                    debug(f'Telegram: WARNING — 0 bytes downloaded! headers={dict(resp.headers)}')
                return content
        except Exception as e:
            debug(f'Telegram: download error for {file_id}: {e}')
            return None

    async def _send_message(self, chat_id: int, text: str):
        """Send a text reply back to a Telegram chat."""
        try:
            # Telegram message limit is 4096 chars; truncate if needed
            if len(text) > 4096:
                text = text[:4093] + '...'
            url = f'https://api.telegram.org/bot{self._bot_token}/sendMessage'
            async with self._http_session.post(url, json={'chat_id': chat_id, 'text': text}) as resp:
                await resp.read()
        except Exception as e:
            debug(f'Telegram: sendMessage error: {e}')

    # -------------------------------------------------------------------------
    # Server lifecycle
    # -------------------------------------------------------------------------

    def _run(self):
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument('--data_host', type=str, default='localhost')
        parser.add_argument('--data_port', type=int, default=5567)
        parsed_args, _ = parser.parse_known_args(sys.argv)

        # Read config HERE (sync context)
        config = self._get_telegram_config()
        self._bot_token = config.get('botToken', '')
        self._mode = config.get('mode', 'polling')
        self._webhook_url = config.get('webhookUrl', '')
        debug(f'Telegram _run: mode={self._mode!r} token_present={bool(self._bot_token)}')

        self._server = WebServer(
            config={
                'port': parsed_args.data_port,
                'host': parsed_args.data_host,
            },
            on_startup=self._startup,
            on_shutdown=self._shutdown,
        )
        self._server.app.state.target = self.target

        # Register webhook route (used only when mode == 'webhook')
        self._server.add_route('/telegram/webhook', self._webhook_handler, ['POST'], public=True)

        self._server.use('profiler')
        self._server.run()

    def scanObjects(self, _path: str, _scanCallback: Callable[[Dict[str, Any]], None]):
        self.target = self.endpoint.target
        self._run()
