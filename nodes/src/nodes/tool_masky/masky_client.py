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

"""
Masky HTTP client.

A thin layer over the Masky REST API (https://masky.ai/api). Retries 429 for
every request and 5xx for reads only (a write Masky may have accepted is never
resent) through ``masky_core.with_retries``, and turns every failure into
a ``MaskyError`` whose message names the cause and the fix. The API key is
only ever placed in the Authorization header; it never appears in an error
message or a log line.
"""

from __future__ import annotations

import urllib.parse
from typing import Any, Dict, List, Optional

from .masky_core import MASKY_BASE_URL, MAX_DOWNLOAD_BYTES, MaskyError, error_for_status, with_retries


class MaskyClient:
    """Thin wrapper over the Masky REST API."""

    def __init__(self, api_key: str, *, base_url: str = MASKY_BASE_URL, timeout: float = 30) -> None:  # noqa: D107
        self._api_key = api_key
        self._base_url = (base_url or MASKY_BASE_URL).rstrip('/')
        self._timeout = timeout

    def close(self) -> None:
        """Drop the API key so it does not outlive the pipeline run."""
        self._api_key = ''

    # ------------------------------------------------------------------
    # Transport
    # ------------------------------------------------------------------

    def _send(self, method: str, path: str, body: Optional[Dict[str, Any]], auth: bool) -> Any:  # noqa: ANN401
        import requests  # deferred: installed by load_depends in beginGlobal

        headers = {'Accept': 'application/json'}
        if auth:
            headers['Authorization'] = f'Bearer {self._api_key}'
        try:
            return requests.request(
                method,
                f'{self._base_url}{path}',
                headers=headers,
                json=body,
                timeout=self._timeout,
            )
        except requests.Timeout:
            if method.upper() == 'GET':
                raise MaskyError(
                    f'Masky did not answer {method} {path} within {self._timeout:g} s. Try again shortly.'
                ) from None
            raise MaskyError(
                f'Masky did not answer {method} {path} within {self._timeout:g} s. The request may still have been accepted: '
                'check get_generation or masky.ai before sending it again, so it is not charged twice.'
            ) from None
        except requests.RequestException as e:
            if method.upper() == 'GET':
                raise MaskyError(
                    f'Could not reach Masky ({type(e).__name__}). Check the network and the base URL.'
                ) from None
            # The connection can drop after the request was sent, so a write may have landed.
            raise MaskyError(
                f'The connection to Masky failed during {method} {path} ({type(e).__name__}). The request may still have '
                'been accepted: check get_generation or masky.ai before sending it again, so it is not charged twice.'
            ) from None

    def _request(self, method: str, path: str, *, body: Optional[Dict[str, Any]] = None, auth: bool = True) -> Any:  # noqa: ANN401
        return self._request_full(method, path, body=body, auth=auth)[1]

    def _request_full(
        self, method: str, path: str, *, body: Optional[Dict[str, Any]] = None, auth: bool = True
    ) -> tuple:
        """Like _request, but returns (status_code, json) so callers can tell 200 from 202."""
        resp = with_retries(
            lambda: self._send(method, path, body, auth),
            status_of=lambda r: r.status_code,
            retry_after_of=lambda r: r.headers.get('Retry-After'),
            method=method,
        )

        if method.upper() != 'GET' and 500 <= resp.status_code < 600:
            raise MaskyError(
                f'Masky returned HTTP {resp.status_code} for {method} {path}. The request may still have been accepted, '
                'so it was not resent: check get_generation or masky.ai before trying again, so it is not charged twice.',
                status=resp.status_code,
            )

        if resp.status_code >= 400:
            try:
                err_body: Any = resp.json()
            except ValueError:
                err_body = resp.text or ''
            raise error_for_status(resp.status_code, err_body, method=method, path=path)

        if not resp.content:
            return resp.status_code, {}
        try:
            return resp.status_code, resp.json()
        except ValueError:
            raise MaskyError(f'Masky returned a non-JSON response for {method} {path}.') from None

    def download(self, url: str, *, max_bytes: int = MAX_DOWNLOAD_BYTES) -> bytes:
        """Fetch a finished media file from its signed URL. Never sends the Masky key."""
        import requests  # deferred: installed by load_depends in beginGlobal

        def send() -> Any:  # noqa: ANN401
            try:
                return requests.get(url, stream=True, timeout=self._timeout * 4)
            except requests.RequestException as e:
                raise MaskyError(f'Could not download the rendered media ({type(e).__name__}).') from None

        resp = with_retries(
            send, status_of=lambda r: r.status_code, retry_after_of=lambda r: r.headers.get('Retry-After')
        )
        if resp.status_code >= 400:
            raise MaskyError(
                f'Downloading the rendered media failed with HTTP {resp.status_code}; the signed URL may have expired.'
            )
        chunks, total = [], 0
        for chunk in resp.iter_content(chunk_size=1024 * 1024):
            total += len(chunk)
            if total > max_bytes:
                resp.close()
                raise MaskyError(
                    f'The rendered media is larger than {max_bytes // (1024 * 1024)} MB; refusing to download it.'
                )
            chunks.append(chunk)
        return b''.join(chunks)

    # ------------------------------------------------------------------
    # Voices and avatars
    # ------------------------------------------------------------------

    def list_voices(self) -> List[Dict[str, Any]]:
        """GET /voices -> raw voice records ({id, name, source})."""
        data = self._request('GET', '/voices')
        voices = data.get('voices') if isinstance(data, dict) else data
        return [v for v in (voices or []) if isinstance(v, dict)]

    def list_avatars(self) -> Dict[str, Any]:
        """GET /avatars -> {avatars: [...], owner: {...}} for the key's account."""
        data = self._request('GET', '/avatars')
        return data if isinstance(data, dict) else {'avatars': data or []}

    def list_public_avatars(self) -> List[Dict[str, Any]]:
        """GET /avatars/public -> publicly renderable avatars (no auth needed)."""
        data = self._request('GET', '/avatars/public', auth=False)
        avatars = data.get('avatars') if isinstance(data, dict) else data
        return [a for a in (avatars or []) if isinstance(a, dict)]

    def lookup(self, user: str) -> Dict[str, Any]:
        """GET /avatars/lookup?user= -> {found, owner?, streamIdentity?, avatars?} by uid, handle or Twitch name."""
        data = self._request('GET', '/avatars/lookup?' + urllib.parse.urlencode({'user': user}))
        return data if isinstance(data, dict) else {}

    def create_avatar(self, body: Dict[str, Any]) -> Dict[str, Any]:
        """POST /avatars -> {avatar: {...}}. Always creates a new avatar."""
        return self._request('POST', '/avatars', body=body)

    def train_avatar(self, avatar_id: str) -> Any:  # noqa: ANN401
        """POST /avatars/{id}/train (no body)."""
        return self._request('POST', f'/avatars/{_seg(avatar_id)}/train')

    def rename_avatar(self, avatar_id: str, name: str) -> Dict[str, Any]:
        """PATCH /avatars/{id} {displayName}: owner only. From Masky's answers; not in the published spec yet."""
        return self._request('PATCH', f'/avatars/{_seg(avatar_id)}', body={'displayName': name})

    def set_avatar_voice(self, avatar_id: str, voice_id: str) -> Any:  # noqa: ANN401
        """POST /avatars/{id}/voice."""
        return self._request('POST', f'/avatars/{_seg(avatar_id)}/voice', body={'voiceId': voice_id})

    def get_stream_identity(self) -> Dict[str, Any]:
        """GET /avatars/stream-identity -> {streamIdentity}."""
        return self._request('GET', '/avatars/stream-identity')

    def set_stream_identity(self, avatar_id: Optional[str], image_url: Optional[str] = None) -> Dict[str, Any]:
        """PUT /avatars/stream-identity. ``avatar_id=None`` clears it."""
        body: Dict[str, Any] = {'avatarId': avatar_id}
        if image_url:
            body['imageUrl'] = image_url
        return self._request('PUT', '/avatars/stream-identity', body=body)

    def set_avatar_public(self, avatar_id: str, public: bool) -> Any:  # noqa: ANN401
        """POST /avatars/{id}/public {publiclyRenderable}."""
        return self._request('POST', f'/avatars/{_seg(avatar_id)}/public', body={'publiclyRenderable': bool(public)})

    def get_video_pricing(self, *, timeout: float = 5) -> Dict[str, Any]:
        """GET /videos/pricing (no auth). One short attempt, no retries: callers fall back on any failure."""
        import requests  # deferred: installed by load_depends in beginGlobal

        try:
            resp = requests.get(
                f'{self._base_url}/videos/pricing', headers={'Accept': 'application/json'}, timeout=timeout
            )
        except requests.RequestException as e:
            raise MaskyError(f'Masky pricing is unreachable ({type(e).__name__}).') from None
        if resp.status_code >= 400:
            raise MaskyError(f'Masky pricing returned HTTP {resp.status_code}.', status=resp.status_code)
        try:
            return resp.json()
        except ValueError:
            raise MaskyError('Masky pricing returned non-JSON.') from None

    # ------------------------------------------------------------------
    # Looks
    # ------------------------------------------------------------------

    def list_images(self, avatar_id: str, owner_user_id: Optional[str] = None) -> Dict[str, Any]:
        """GET /avatars/{id}/images -> {avatarId, avatarOwnerUserId, primary, images: [{url, assetId, isPrimary, createdAt}]}."""
        query = '?' + urllib.parse.urlencode({'avatarOwnerUserId': owner_user_id}) if owner_user_id else ''
        data = self._request('GET', f'/avatars/{_seg(avatar_id)}/images{query}')
        return data if isinstance(data, dict) else {'images': data or []}

    def add_image(self, avatar_id: str, image_url: str) -> Dict[str, Any]:
        """POST /avatars/{id}/images -> {avatarId, assetId, url}."""
        return self._request('POST', f'/avatars/{_seg(avatar_id)}/images', body={'imageUrl': image_url})

    # ------------------------------------------------------------------
    # Renders
    # ------------------------------------------------------------------

    def speak(self, avatar_id: str, body: Dict[str, Any]) -> tuple:
        """POST /avatars/{id}/speak -> (200 inline or 202 queued, body)."""
        return self._request_full('POST', f'/avatars/{_seg(avatar_id)}/speak', body=body)

    def get_speak(self, generation_id: str) -> Dict[str, Any]:
        """GET /avatars/speak/{id} -> {generation: {...}}."""
        return self._request('GET', f'/avatars/speak/{_seg(generation_id)}')

    def generate_video(self, body: Dict[str, Any]) -> Dict[str, Any]:
        """POST /videos/generate -> 202 {generationId, slug, url, status, seconds, creditCost, ...}."""
        return self._request('POST', '/videos/generate', body=body)

    def get_video(self, generation_id: str) -> Dict[str, Any]:
        """GET /videos/{id} -> {generationId, slug, url, status, videoUrl, seconds, creditCost, error?}."""
        return self._request('GET', f'/videos/{_seg(generation_id)}')

    def generate_image(self, body: Dict[str, Any]) -> Dict[str, Any]:
        """POST /images/generate -> {imageUrl, aspectRatio, creditCost} (synchronous)."""
        return self._request('POST', '/images/generate', body=body)

    def edit_image(self, body: Dict[str, Any]) -> Dict[str, Any]:
        """POST /images/edit -> {imageUrl, aspectRatio, model, creditCost} (synchronous)."""
        return self._request('POST', '/images/edit', body=body)

    # ------------------------------------------------------------------
    # Live conversations
    # ------------------------------------------------------------------

    def create_conversation(self, owner_user_id: str, avatar_id: str) -> Dict[str, Any]:
        """POST /conversations -> {conversationId, shareSlug, shareUrl, viewerToken, liveUrl}."""
        return self._request('POST', '/conversations', body={'avatarOwnerUserId': owner_user_id, 'avatarId': avatar_id})

    def send_turn(self, conversation_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
        """POST /conversations/{id}/turn -> 202 {turn, firestorePath, async}."""
        return self._request('POST', f'/conversations/{_seg(conversation_id)}/turn', body=body)

    def get_conversation(self, slug: str) -> Dict[str, Any]:
        """GET /conversations/by-slug/{slug} -> the conversation with its full turn list."""
        data = self._request('GET', f'/conversations/by-slug/{_seg(slug)}')
        return data if isinstance(data, dict) else {}

    def set_conversation_visibility(self, conversation_id: str, public: bool) -> Any:  # noqa: ANN401
        """POST /conversations/{id}/visibility {isPublic}."""
        return self._request(
            'POST', f'/conversations/{_seg(conversation_id)}/visibility', body={'isPublic': bool(public)}
        )

    # The three endpoints below come from Masky's answers (2026-10-22); they are not in
    # the published OpenAPI spec yet. The permanent turn purge (.../forever) is not used.

    def delete_conversation(self, conversation_id: str) -> Any:  # noqa: ANN401
        """DELETE /conversations/{id}: owner only; removes the conversation and its turns."""
        return self._request('DELETE', f'/conversations/{_seg(conversation_id)}')

    def delete_turn(self, conversation_id: str, turn_id: str) -> Any:  # noqa: ANN401
        """DELETE /conversations/{id}/turns/{turnId}: soft delete, restorable."""
        return self._request('DELETE', f'/conversations/{_seg(conversation_id)}/turns/{_seg(turn_id)}')

    def restore_turn(self, conversation_id: str, turn_id: str) -> Any:  # noqa: ANN401
        """POST /conversations/{id}/turns/{turnId}/restore: undo a soft delete."""
        return self._request('POST', f'/conversations/{_seg(conversation_id)}/turns/{_seg(turn_id)}/restore')

    def set_conversation_image(self, conversation_id: str, image_url: str) -> Dict[str, Any]:
        """POST /conversations/{id}/avatar-image -> {ok, avatarImageUrl}."""
        return self._request(
            'POST', f'/conversations/{_seg(conversation_id)}/avatar-image', body={'avatarImageUrl': image_url}
        )

    # ------------------------------------------------------------------
    # Agent binding
    # ------------------------------------------------------------------

    def get_binding(self, avatar_id: str) -> Dict[str, Any]:
        """GET /avatars/{id}/agent-binding -> {avatarId, agentBinding}."""
        return self._request('GET', f'/avatars/{_seg(avatar_id)}/agent-binding')

    def put_binding(self, avatar_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
        """PUT /avatars/{id}/agent-binding -> {avatarId, agentBinding}."""
        return self._request('PUT', f'/avatars/{_seg(avatar_id)}/agent-binding', body=body)

    def delete_binding(self, avatar_id: str) -> Dict[str, Any]:
        """DELETE /avatars/{id}/agent-binding -> {avatarId, agentBinding: null}."""
        return self._request('DELETE', f'/avatars/{_seg(avatar_id)}/agent-binding')


def _seg(value: str) -> str:
    """Quote an id for use as one URL path segment.

    quote() keeps dots, and requests collapses dot segments, so '.' and '..' (or an
    empty or missing id) would address a different resource; they are refused before any request.
    """
    text = '' if value is None else str(value)
    if text in ('', '.', '..'):
        raise MaskyError(f'Invalid id: {text!r}')
    return urllib.parse.quote(text, safe='')
