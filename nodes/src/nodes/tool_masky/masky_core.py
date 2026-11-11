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
Shared Masky logic used by both the tool driver and the pipeline step.

Owns the API key lookup, Masky's input limits, HTTP error mapping and the
retry policy. Nothing here touches the engine, so it is testable on its own.
"""

from __future__ import annotations

import datetime
import hashlib
import math
import os
import re
import time
import urllib.parse
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Dict, List, Optional

# Task subprocesses only inherit ROCKETRIDE_* variables from the engine host
# (filter_subprocess_env), so the fallback lives in that namespace.
ENV_API_KEY = 'ROCKETRIDE_MASKY_KEY'

MASKY_BASE_URL = 'https://masky.ai/api'

# Masky's documented input limits (OpenAPI v1.2.0, plus masky.ai/api/docs for
# the image prompt). Checked before any request is sent.
LIMITS: Dict[str, int] = {
    'speech_chars': 500,
    'turn_chars': 500,
    'video_prompt_chars': 2000,
    'video_speech_chars': 300,
    'image_prompt_chars': 2000,
    'video_duration_min': 1,
    'video_duration_max': 20,
    'avatar_name_chars': 80,
    'personality_chars': 4000,
    'knowledge_urls_max': 10,
}

ACTIONS = ('talking_head', 'scene_video', 'image', 'live')
ASPECT_RATIOS = ('16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '1:1')

# Retry policy for 429 and 5xx responses.
MAX_ATTEMPTS = 3
BACKOFF_BASE_SEC = 1.0
MAX_RETRY_AFTER_SEC = 30.0

# Largest media file the pipeline step downloads (a 20 s 1080p clip is far smaller).
MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024


class MaskyError(RuntimeError):
    """A Masky request failed; the message is safe to show to a user or an agent."""

    def __init__(self, message: str, *, status: Optional[int] = None) -> None:  # noqa: D107
        super().__init__(message)
        self.status = status
        self.credit_detail = ''  # set on 402s: ' (needs X, available Y)' when Masky says


def resolve_api_key(configured: Any) -> str:  # noqa: ANN401
    """Return the configured key, falling back to ROCKETRIDE_MASKY_KEY."""
    return (str(configured or '').strip() or os.environ.get(ENV_API_KEY, '')).strip()


def _body_text(body: Any) -> str:  # noqa: ANN401
    if isinstance(body, dict):
        for key in ('error', 'message', 'detail'):
            value = body.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    if isinstance(body, str):
        return body.strip()[:300]
    return ''


def error_for_status(status: int, body: Any, *, method: str, path: str) -> MaskyError:  # noqa: ANN401
    """Turn a failed Masky response into an actionable MaskyError."""
    if status == 401:
        return MaskyError(f'Masky rejected the API key. Set it on the node or in {ENV_API_KEY}.', status=401)
    if status == 403:
        text = _body_text(body)
        detail = f' ({text})' if text else ''
        return MaskyError(
            f'Masky refused access to {path}{detail}. The avatar or conversation is probably not yours or not public; '
            f"if every call fails this way, check the key's scopes on masky.ai/developer.",
            status=403,
        )
    if status == 402:
        detail = ''
        if isinstance(body, dict) and body.get('requiredCredits') is not None:
            detail = f' (needs {body.get("requiredCredits")}, available {body.get("availableCredits")})'
        error = MaskyError(
            f'Masky reports insufficient credits{detail}. Top up at https://masky.ai and retry.', status=402
        )
        error.credit_detail = detail
        return error
    if status == 404:
        return MaskyError(f'Masky found nothing at {path}. Check the id.', status=404)
    if status == 429:
        return MaskyError(
            'Masky is rate limiting this key and retries did not clear it. Wait a minute and retry.', status=429
        )
    text = _body_text(body)
    suffix = f': {text}' if text else ''
    return MaskyError(f'Masky returned HTTP {status} for {method} {path}{suffix}', status=status)


def retry_after_seconds(value: Optional[str], *, now: Optional[float] = None) -> Optional[float]:
    """Parse a Retry-After header (seconds or HTTP date); None if absent or unusable."""
    if not value:
        return None
    value = value.strip()
    try:
        seconds = float(value)
    except ValueError:
        try:
            when = parsedate_to_datetime(value).timestamp()
        except (TypeError, ValueError):
            return None
        seconds = when - (time.time() if now is None else now)
    if math.isnan(seconds) or math.isinf(seconds):
        return None
    return max(0.0, min(seconds, MAX_RETRY_AFTER_SEC))


def should_retry(status: int, method: str = 'GET') -> bool:
    """Whether a response is worth another attempt.

    Reads (GET) retry on 429 and 5xx. Writes (POST/PUT/DELETE) retry only on 429,
    which Masky returns before doing any work: a 5xx on a write may hide a job that
    already started (and will be billed), so resending it could charge twice.
    """
    if status == 429:
        return True
    return method.upper() == 'GET' and 500 <= status < 600


def with_retries(
    send: Callable[[], Any],
    *,
    status_of: Callable[[Any], int],
    retry_after_of: Callable[[Any], Optional[str]],
    sleep: Optional[Callable[[float], None]] = None,
    attempts: int = MAX_ATTEMPTS,
    method: str = 'GET',
) -> Any:  # noqa: ANN401
    """Call ``send`` until it returns a non-retryable response or attempts run out.

    Waits ``Retry-After`` when the response carries it, else 1 s, 2 s, ...
    Returns the last response either way; the caller maps its status.
    """
    sleep = sleep or time.sleep
    response = None
    for attempt in range(1, attempts + 1):
        response = send()
        if not should_retry(status_of(response), method) or attempt == attempts:
            return response
        delay = retry_after_seconds(retry_after_of(response))
        close = getattr(response, 'close', None)
        if callable(close):
            close()  # release the discarded response's connection before retrying
        sleep(delay if delay is not None else BACKOFF_BASE_SEC * (2 ** (attempt - 1)))
    return response


# ---------------------------------------------------------------------------
# Cost: one dated price table and one estimate function
# ---------------------------------------------------------------------------

PRICE_TABLE_DATE = '2026-10-16'

# Credits. Sources: GET /videos/pricing, the OpenAPI spec, masky.ai/api/docs,
# and one measured speak call (5 words of audio, 2.14 s, charged 0.004).
PRICES: Dict[str, Any] = {
    'audio_per_sec': 0.0015,
    'talking_head_per_sec': 0.0265,
    'video_per_sec': {
        ('720p', False): 0.025,
        ('720p', True): 0.015,
        ('1080p', False): 0.05,
        ('1080p', True): 0.03,
    },
    'image_generate': {'default': 0.005, 'ideogram': 0.015},
    'image_edit': {'default': 0.01, 'qwen': 0.03},
}

# Rates found only on Masky's docs page and never measured. Talking head
# (0.0265/s of rendered video: 15.04 s cost 0.3985) and the default image
# (0.005) were measured on 2026-10-20; edit prices are in the OpenAPI spec and
# scene-video rates come from GET /videos/pricing. Live turns are marked
# unverified separately in estimate_turn.
UNVERIFIED_PRICES = frozenset({'image_generate_ideogram'})

# Masky bills the rendered length, which runs one frame past the request
# (5 s rendered as 5.042 s, 15 s as 15.042 s); this margin keeps the estimate
# at or above the real charge.
VIDEO_BILLING_MARGIN_SEC = 0.1

# Speech length is unknown before rendering; 12 characters per second
# deliberately overestimates (the measured call ran at about 15).
CHARS_PER_SEC = 12

# A chat-mode (or reinterpreted) live turn speaks text the avatar writes, whose
# length is unknown and not capped by Masky; assume the 500-character maximum.
CHAT_REPLY_CHARS = 500


def rates_from_pricing(body: Any) -> Optional[Dict[str, Any]]:  # noqa: ANN401
    """Parse GET /videos/pricing into {'video_per_sec': {(res, draft): rate}, 'audio_per_sec': rate}; None if unusable."""
    if not isinstance(body, dict) or not isinstance(body.get('perSecond'), dict):
        return None
    video: Dict[tuple, float] = {}
    for resolution, tiers in body['perSecond'].items():
        if not isinstance(tiers, dict):
            continue
        for tier, draft in (('full', False), ('draft', True)):
            rate = tiers.get(tier)
            if isinstance(rate, (int, float)) and not isinstance(rate, bool) and math.isfinite(rate) and rate > 0:
                video[(str(resolution), draft)] = float(rate)
    if not video:
        return None
    rates: Dict[str, Any] = {'video_per_sec': video}
    audio = body.get('audioPerSecond')
    if isinstance(audio, (int, float)) and not isinstance(audio, bool) and math.isfinite(audio) and audio > 0:
        rates['audio_per_sec'] = float(audio)
    return rates


def round_up_credits(credits: float) -> float:
    """Round up to Masky's billing step of 0.001 credit."""
    return math.ceil(round(credits * 1000, 6)) / 1000


# Masky's own billing for speech (talking head, audio, live turns): seconds are
# estimated from the spoken text, max(1, round(chars / 15)), plus a flat fee for
# the text step. Confirmed by Masky on 2026-10-22 and reproduced exactly by our
# three measured charges (0.004, 0.3985, 0.7165).
SPEECH_BILLING_CHARS_PER_SEC = 15
SPEECH_TEXT_STEP_FEE = 0.001


def billed_speech_seconds(chars: int) -> int:
    """Masky's billed seconds for ``chars`` characters of spoken text: max(1, round(chars / 15)), rounding half up."""
    return max(1, math.floor(chars / SPEECH_BILLING_CHARS_PER_SEC + 0.5))


def speech_seconds(text: str) -> int:
    """Conservative spoken length of ``text`` in whole seconds (at least 1)."""
    return max(1, math.ceil(len(text or '') / CHARS_PER_SEC))


def _estimate(credits: float, basis: str, rates: tuple, *, exact: bool = False) -> Dict[str, Any]:
    return {
        # Speech follows Masky's formula, which bills to four decimals; everything else
        # rounds up to 0.001 so the guard errs high.
        'credits': round(credits, 4) if exact else round_up_credits(credits),
        'basis': basis,
        'price_table_date': PRICE_TABLE_DATE,
        'verified': not any(r in UNVERIFIED_PRICES for r in rates),
    }


def estimate_speak(text: str, output: str, text_mode: str = 'literal') -> Dict[str, Any]:
    """Talking head (video) or voice-only (audio) speech.

    Uses Masky's billing formula (seconds estimated from the text, plus the text-step
    fee). In ``personality`` mode Masky bills the rewritten line, whose length is
    unknown: the estimate assumes the full 500 characters and is marked unverified.
    """
    rewritten = text_mode == 'personality'
    chars = max(len(text or ''), LIMITS['speech_chars']) if rewritten else len(text or '')
    seconds = billed_speech_seconds(chars)
    rate_key = 'talking_head_per_sec' if output == 'video' else 'audio_per_sec'
    rate = PRICES[rate_key]
    label = 'talking-head video' if output == 'video' else 'audio'
    what = f'a rewrite assumed to be {chars} chars' if rewritten else f'{chars} chars'
    est = _estimate(
        seconds * rate + SPEECH_TEXT_STEP_FEE,
        f'{seconds} s of {label} at {rate} credits/s plus {SPEECH_TEXT_STEP_FEE} for the text step '
        f"({what} at {SPEECH_BILLING_CHARS_PER_SEC} chars/s, Masky's billing formula)",
        (rate_key,),
        exact=True,
    )
    if rewritten:
        est['verified'] = False
        est['assumed_rewrite'] = True
    return est


def estimate_video(
    *,
    resolution: str,
    draft: bool,
    duration_sec: Optional[int] = None,
    speech_text: str = '',
    audio_url: str = '',
    live_rates: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Scene video. Speech sets the length; an audio URL is assumed to run the full 20 s.

    ``live_rates`` (from GET /videos/pricing) replaces the dated table when it has the tier.
    """
    if speech_text:
        seconds = min(LIMITS['video_duration_max'], speech_seconds(speech_text))
        how = f'speech line of {len(speech_text)} chars'
    elif audio_url:
        seconds = LIMITS['video_duration_max']
        how = 'audio track of unknown length, assumed the 20 s maximum'
    else:
        seconds = duration_sec or 5
        how = 'requested duration'
    table = PRICES['video_per_sec'][(resolution, bool(draft))]
    live = (live_rates or {}).get('video_per_sec', {}).get((resolution, bool(draft)))
    # Live pricing can only raise an estimate: a lower (or bogus) live rate never
    # lets the cost guard pass a render the dated table would refuse.
    rate = max(live, table) if live else table
    source = 'live Masky pricing' if live and live >= table else f'price table of {PRICE_TABLE_DATE}'
    quality = f'{resolution}{" draft" if draft else ""}'
    billed = seconds + VIDEO_BILLING_MARGIN_SEC
    return _estimate(
        billed * rate,
        f'{seconds} s ({how}) plus {VIDEO_BILLING_MARGIN_SEC} s billing margin of {quality} scene video at {rate} credits/s ({source})',
        ('video_per_sec',),
    )


MAX_EDIT_IMAGES = 5
MAX_QWEN_IMAGES = 2  # the qwen edit engine takes at most two reference images


def estimate_image(*, edit: bool, engine: str) -> Dict[str, Any]:
    """One generated or edited image."""
    key = 'image_edit' if edit else 'image_generate'
    price = PRICES[key][engine]
    rate_key = 'image_edit' if edit else ('image_generate_ideogram' if engine == 'ideogram' else 'image_generate')
    return _estimate(price, f'one {"edited" if edit else "generated"} image with the {engine} engine', (rate_key,))


def estimate_turn(text: str, *, mode: str, output: str, reinterpret: bool = False) -> Dict[str, Any]:
    """One live-conversation turn: the avatar speaks the text (speak) or its own reply (chat, or reinterpreted speak).

    Masky charges each rendered turn with the same formula as speech (seconds estimated
    from the spoken text plus the text-step fee).
    """
    literal = mode == 'speak' and not reinterpret
    chars = len(text or '') if literal else max(len(text or ''), CHAT_REPLY_CHARS)
    rate_key = 'talking_head_per_sec' if output == 'video' else 'audio_per_sec'
    seconds = billed_speech_seconds(chars)
    rate = PRICES[rate_key]
    what = 'the text' if literal else f'text the avatar writes, assumed to be {chars} chars'
    est = _estimate(
        seconds * rate + SPEECH_TEXT_STEP_FEE,
        f'{seconds} s of {output} speaking {what} at {rate} credits/s plus {SPEECH_TEXT_STEP_FEE} for the text step '
        "(Masky's billing formula; turns are charged after they render)",
        (rate_key,),
        exact=True,
    )
    if not literal:
        est['verified'] = False
        est['assumed_rewrite'] = True
    return est


def check_budget(estimate: Dict[str, Any], cap: float) -> None:
    """Refuse a render whose estimate is above the per-call cap (0 disables the guard)."""
    if cap and estimate['credits'] > cap:
        hint = ''
        if estimate.get('assumed_rewrite'):
            hint = (
                ' Chat-mode, reinterpreted and personality-mode speech is estimated as if the avatar writes 500 characters, '
                'because its length is unknown; video at that length needs a higher cap.'
            )
        raise MaskyError(
            f'Estimated cost {estimate["credits"]} credits ({estimate["basis"]}) is above the cap of {cap:g} credits per call.'
            f'{hint} Raise Max Credits per Call (maxCreditsPerCall) on the node, or set it to 0 to turn the guard off.'
        )


# ---------------------------------------------------------------------------
# Job ids and look ids
# ---------------------------------------------------------------------------

JOB_KINDS = ('speak', 'video', 'image')


def encode_job_id(kind: str, raw_id: str) -> str:
    """``speak:<id>``, ``video:<id>`` or ``image:<id>``."""
    return f'{kind}:{raw_id}'


def decode_job_id(generation_id: str, kind: Optional[str] = None) -> tuple:
    """Return ``(kind, raw_id)`` from a prefixed id, or a raw id plus ``kind``."""
    generation_id = (generation_id or '').strip()
    if not generation_id:
        raise ValueError('generation_id is required')
    prefix, sep, rest = generation_id.partition(':')
    if sep and prefix in JOB_KINDS:
        if kind and kind != prefix:
            raise ValueError(f'generation_id {generation_id!r} is a {prefix} job but kind={kind!r} was given')
        if not rest:
            raise ValueError(f'generation_id {generation_id!r} has no id after the prefix')
        return prefix, rest
    if not kind:
        raise ValueError(
            f'generation_id {generation_id!r} has no kind prefix. Pass the prefixed id this node returned '
            f'(speak:..., video:..., image:...) or add kind ({", ".join(JOB_KINDS)}).'
        )
    if kind not in JOB_KINDS:
        raise ValueError(f'kind must be one of {", ".join(JOB_KINDS)}')
    return kind, generation_id


def _url_key(url: str) -> str:
    return (url or '').split('?', 1)[0]


def look_id_for(url: str, asset_id: Optional[str] = None) -> str:
    """Masky's asset id when the look has one; otherwise a short hash of the URL."""
    if asset_id:
        return str(asset_id)
    return 'look_' + hashlib.sha256(_url_key(url).encode('utf-8')).hexdigest()[:10]


def resolve_look(value: str, looks: list) -> str:
    """Map a look_id or look URL to the registered look URL; raise with the valid ids if unknown.

    ``looks`` is the ``images`` list from ``GET /avatars/{id}/images``.
    """
    value = (value or '').strip()
    for look in looks:
        url = look.get('url') or ''
        if value.lower().startswith(('http://', 'https://')):
            if value == url or _url_key(value) == _url_key(url):
                return url
        elif value == look_id_for(url, look.get('assetId')):
            return url
    valid = ', '.join(look_id_for(lk.get('url') or '', lk.get('assetId')) for lk in looks) or 'none registered'
    raise MaskyError(
        f'Look {value!r} is not registered on this avatar. Valid look_ids: {valid}. Add one with add_look.'
    )


def image_job_id(image_url: str) -> str:
    """Images have no Masky id; the node derives one from the URL for this run."""
    return encode_job_id('image', hashlib.sha256(_url_key(image_url).encode('utf-8')).hexdigest()[:16])


# ---------------------------------------------------------------------------
# URLs, polling and receipts
# ---------------------------------------------------------------------------


def url_expires_at(url: Optional[str]) -> Optional[str]:
    """ISO-8601 UTC expiry of a signed URL (``Expires=<epoch>``), or None."""
    if not url or 'Expires=' not in url:
        return None
    try:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        epoch = int(query['Expires'][0])
    except (KeyError, ValueError, IndexError):
        return None
    return datetime.datetime.fromtimestamp(epoch, tz=datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def image_mime(url: str) -> str:
    """MIME type from an image URL's extension (default image/png)."""
    path = _url_key(url).lower()
    for ext, mime in (('.jpg', 'image/jpeg'), ('.jpeg', 'image/jpeg'), ('.webp', 'image/webp'), ('.gif', 'image/gif')):
        if path.endswith(ext):
            return mime
    return 'image/png'


class MaskyCancelled(MaskyError):
    """The pipeline was cancelled while waiting for a render."""


def poll(
    fetch: Callable[[], Any],
    is_done: Callable[[Any], bool],
    *,
    timeout_sec: float,
    interval_sec: float,
    is_cancelled: Optional[Callable[[], bool]] = None,
    sleep: Optional[Callable[[float], None]] = None,
    clock: Optional[Callable[[], float]] = None,
) -> tuple:
    """Fetch until ``is_done`` or the timeout; return ``(last_result, finished)``.

    Waits in slices of at most one second so a cancelled pipeline stops promptly.
    """
    sleep = sleep or time.sleep
    clock = clock or time.monotonic
    deadline = clock() + timeout_sec
    while True:
        result = fetch()
        if is_done(result):
            return result, True
        if clock() >= deadline:
            return result, False
        wait_until = min(deadline, clock() + interval_sec)
        while clock() < wait_until:
            if is_cancelled and is_cancelled():
                raise MaskyCancelled('Cancelled while waiting for Masky to finish rendering.')
            sleep(min(1.0, max(0.0, wait_until - clock())))


def _media(mime: str, url: Optional[str]) -> Dict[str, Any]:
    media: Dict[str, Any] = {'mime': mime}
    if url:
        media['url'] = url
        expires = url_expires_at(url)
        if expires:
            media['url_expires_at'] = expires
    return media


def _receipt(
    generation_id: str, kind: str, status: str, estimate: Dict[str, Any], elapsed_sec: float
) -> Dict[str, Any]:
    return {
        'generation_id': generation_id,
        'kind': kind,
        'status': status,
        'estimated_credits': estimate.get('credits') if estimate else None,
        'credits_charged': None,
        'elapsed_sec': round(elapsed_sec, 1),
        'warnings': [],
    }


SPEAK_RUNNING = ('pending', 'queued', 'running', 'processing')


def speak_status(generation: Dict[str, Any], output: str) -> str:
    """Map Masky's speak status to queued|running|done|failed for the requested output."""
    status = (generation.get('status') or 'pending').lower()
    if status == 'video':
        return 'done'
    if status == 'audio':
        return 'done' if output == 'audio' else 'running'
    if status == 'error':
        if generation.get('audioUrl') and output == 'audio':
            return 'done'
        return 'failed'
    return 'running'


def speak_receipt(body: Dict[str, Any], *, output: str, estimate: Dict[str, Any], elapsed_sec: float) -> Dict[str, Any]:
    """Receipt for a speak job from a POST (inline) or poll response."""
    gen = body.get('generation') if isinstance(body.get('generation'), dict) else body
    raw_id = str(gen.get('generationId') or body.get('generationId') or '')
    status = speak_status(gen, output)
    receipt = _receipt(encode_job_id('speak', raw_id), 'speak', status, estimate, elapsed_sec)
    masky_error = gen.get('videoError') or gen.get('error') or gen.get('geminiError')
    audio_url, video_url = gen.get('audioUrl'), gen.get('videoUrl')

    if output == 'video' and status == 'done':
        receipt['media'] = _media('video/mp4', video_url)
    elif status == 'done' or (status == 'failed' and audio_url):
        receipt['media'] = _media('audio/mpeg', audio_url)
    else:
        receipt['media'] = _media('video/mp4' if output == 'video' else 'audio/mpeg', None)

    if (gen.get('status') or '').lower() == 'error':
        if status == 'done':
            receipt['warnings'].append(
                f'Masky reported an error after the audio was ready: {masky_error or "no detail"}'
            )
        else:
            receipt['error'] = (
                f'Render failed (job {receipt["generation_id"]}): {masky_error or "Masky gave no detail"}'
            )
            if audio_url:
                receipt['warnings'].append('The video failed but the audio rendered; it is attached as media.')
    receipt['warnings'].extend(str(w) for w in (gen.get('warnings') or []))
    receipt['credits_charged'] = gen.get('creditsCharged')
    receipt['spoken_text'] = gen.get('spokenText')
    receipt['share_url'] = gen.get('shareUrl')
    receipt['reused'] = bool(body.get('reused') or gen.get('reused'))
    return receipt


VIDEO_STATUS = {'queued': 'queued', 'rendering': 'running', 'ready': 'done', 'error': 'failed'}


def video_receipt(body: Dict[str, Any], *, estimate: Dict[str, Any], elapsed_sec: float) -> Dict[str, Any]:
    """Receipt for a scene-video job (POST 202 or poll)."""
    raw_status = (body.get('status') or 'queued').lower()
    status = VIDEO_STATUS.get(raw_status, 'running')
    receipt = _receipt(
        encode_job_id('video', str(body.get('generationId') or '')), 'video', status, estimate, elapsed_sec
    )
    receipt['media'] = _media('video/mp4', body.get('videoUrl') if status == 'done' else None)
    if status == 'failed':
        receipt['error'] = (
            f'Render failed (job {receipt["generation_id"]}): {body.get("error") or "Masky gave no detail"}'
        )
    receipt['credits_charged'] = body.get('creditCost')
    receipt['share_url'] = body.get('url')
    return receipt


def image_receipt(body: Dict[str, Any], *, estimate: Dict[str, Any], elapsed_sec: float) -> Dict[str, Any]:
    """Receipt for a generated or edited image (synchronous)."""
    url = body.get('imageUrl') or ''
    receipt = _receipt(image_job_id(url), 'image', 'done', estimate, elapsed_sec)
    receipt['media'] = _media(image_mime(url), url)
    receipt['credits_charged'] = body.get('creditCost')
    return receipt


def timeout_warning(receipt: Dict[str, Any], timeout_sec: float) -> None:
    """Mark a receipt whose render outlived the wait."""
    receipt['warnings'].append(
        f'Still rendering after {timeout_sec:g} s (job {receipt["generation_id"]}). Call get_generation with this id to check again.'
    )


def strip_media_urls(receipt: Dict[str, Any]) -> Dict[str, Any]:
    """Remove signed media URLs (includeMediaUrls off). The share page URL stays."""
    media = receipt.get('media')
    if isinstance(media, dict):
        media.pop('url', None)
        media.pop('url_expires_at', None)
    return receipt


# ---------------------------------------------------------------------------
# Downloaded media: duration and dimensions, read from the bytes
# ---------------------------------------------------------------------------

_MP3_BITRATES = {
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],  # MPEG-1 Layer III
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],  # MPEG-2/2.5 Layer III
}
_MP3_RATES = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}


def mp3_duration(data: bytes) -> Optional[float]:
    """Playing time of an MP3 (Layer III) by walking its frames; None if unreadable."""
    pos = 0
    if data[:3] == b'ID3' and len(data) >= 10:
        pos = 10 + ((data[6] & 0x7F) << 21 | (data[7] & 0x7F) << 14 | (data[8] & 0x7F) << 7 | (data[9] & 0x7F))
    samples = 0
    rate = 0
    while pos + 4 <= len(data):
        b1, b2 = data[pos + 1], data[pos + 2]
        if data[pos] != 0xFF or (b1 & 0xE0) != 0xE0:
            pos += 1
            continue
        version = (b1 >> 3) & 0x03  # 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
        layer = (b1 >> 1) & 0x03  # 1 = Layer III
        bitrate_idx, rate_idx, padding = (b2 >> 4) & 0x0F, (b2 >> 2) & 0x03, (b2 >> 1) & 0x01
        if version == 1 or layer != 1 or bitrate_idx in (0, 15) or rate_idx == 3:
            pos += 1
            continue
        rate = _MP3_RATES[version][rate_idx]
        bitrate = _MP3_BITRATES[1 if version == 3 else 2][bitrate_idx] * 1000
        per_frame = 1152 if version == 3 else 576
        length = (per_frame // 8) * bitrate // rate + padding
        if length <= 4:
            break
        samples += per_frame
        pos += length
    return round(samples / rate, 3) if rate and samples else None


def _boxes(data: bytes, start: int, end: int):
    pos = start
    while pos + 8 <= end:
        size = int.from_bytes(data[pos : pos + 4], 'big')
        kind = data[pos + 4 : pos + 8]
        header = 8
        if size == 1 and pos + 16 <= end:
            size, header = int.from_bytes(data[pos + 8 : pos + 16], 'big'), 16
        elif size == 0:
            size = end - pos
        if size < header:
            return
        yield kind, pos + header, min(pos + size, end)
        pos += size


def mp4_info(data: bytes) -> Dict[str, Any]:
    """Duration (s) and the first video track's width/height from an MP4's moov box."""
    info: Dict[str, Any] = {}
    for kind, body, end in _boxes(data, 0, len(data)):
        if kind != b'moov':
            continue
        for sub, sbody, send in _boxes(data, body, end):
            if sub == b'mvhd':
                if data[sbody : sbody + 1] == b'\x01':  # slice: an empty box must not raise
                    scale, duration = (
                        int.from_bytes(data[sbody + 20 : sbody + 24], 'big'),
                        int.from_bytes(data[sbody + 24 : sbody + 32], 'big'),
                    )
                else:
                    scale, duration = (
                        int.from_bytes(data[sbody + 12 : sbody + 16], 'big'),
                        int.from_bytes(data[sbody + 16 : sbody + 20], 'big'),
                    )
                if scale:
                    info['duration'] = round(duration / scale, 3)
            elif sub == b'trak' and 'width' not in info:
                for tk, tbody, _ in _boxes(data, sbody, send):
                    if tk == b'tkhd':
                        off = tbody + (88 if data[tbody : tbody + 1] == b'\x01' else 76)
                        width, height = (
                            int.from_bytes(data[off : off + 4], 'big') >> 16,
                            int.from_bytes(data[off + 4 : off + 8], 'big') >> 16,
                        )
                        if width and height:
                            info['width'], info['height'] = width, height
    return info


def image_size(data: bytes) -> Dict[str, int]:
    """Width/height of a PNG, JPEG or WebP image; empty if unknown."""
    if data[:8] == b'\x89PNG\r\n\x1a\n' and len(data) >= 24:
        return {'width': int.from_bytes(data[16:20], 'big'), 'height': int.from_bytes(data[20:24], 'big')}
    if data[:2] == b'\xff\xd8':
        pos = 2
        while pos + 9 < len(data):
            if data[pos] != 0xFF:
                pos += 1
                continue
            marker = data[pos + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                return {
                    'height': int.from_bytes(data[pos + 5 : pos + 7], 'big'),
                    'width': int.from_bytes(data[pos + 7 : pos + 9], 'big'),
                }
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                pos += 2
                continue
            pos += 2 + int.from_bytes(data[pos + 2 : pos + 4], 'big')
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP' and len(data) >= 30:
        chunk = data[12:16]
        if chunk == b'VP8X':
            return {
                'width': 1 + int.from_bytes(data[24:27], 'little'),
                'height': 1 + int.from_bytes(data[27:30], 'little'),
            }
        if chunk == b'VP8 ':
            return {
                'width': int.from_bytes(data[26:28], 'little') & 0x3FFF,
                'height': int.from_bytes(data[28:30], 'little') & 0x3FFF,
            }
        if chunk == b'VP8L':
            bits = int.from_bytes(data[21:25], 'little')
            return {'width': (bits & 0x3FFF) + 1, 'height': ((bits >> 14) & 0x3FFF) + 1}
    return {}


def media_details(mime: str, data: bytes) -> Dict[str, Any]:
    """Measured facts about downloaded media: byte size plus duration and/or dimensions."""
    details: Dict[str, Any] = {'size_bytes': len(data)}
    if mime == 'audio/mpeg':
        duration = mp3_duration(data)
        if duration:
            details['duration_sec'] = duration
    elif mime.startswith('video/'):
        info = mp4_info(data)
        if info.get('duration'):
            details['duration_sec'] = info['duration']
        if info.get('width'):
            details['width'], details['height'] = info['width'], info['height']
    elif mime.startswith('image/'):
        details.update(image_size(data))
    return details


def speech_over_limit(text: str) -> Optional[str]:
    """The cloud_tts-style message for a pipeline record over Masky's speech limit, or None."""
    limit = LIMITS['speech_chars']
    if len(text) <= limit:
        return None
    return (
        f'Masky accepts {limit} characters per speech request and this record has {len(text)}. '
        'Split it upstream with a chunker or summarization node.'
    )


# ---------------------------------------------------------------------------
# Live: split text into turns
# ---------------------------------------------------------------------------

_SENTENCE_BREAK = re.compile(r'(?<=[.!?…])\s+')


def split_turns(text: str, limit: Optional[int] = None) -> List[str]:
    """Split text into turns of at most ``limit`` characters (default: Masky's 500).

    Whole sentences are packed into each turn. A sentence longer than the limit
    is split between words. Only a single word longer than the limit (a long
    URL, say) is cut inside the word, because nothing else fits.
    """
    limit = limit or LIMITS['turn_chars']
    flat = ' '.join((text or '').split())
    if not flat:
        return []

    pieces: List[str] = []
    for sentence in _SENTENCE_BREAK.split(flat):
        if len(sentence) <= limit:
            pieces.append(sentence)
            continue
        current = ''
        for word in sentence.split(' '):
            while len(word) > limit:
                if current:
                    pieces.append(current)
                    current = ''
                pieces.append(word[:limit])
                word = word[limit:]
            if current and len(current) + 1 + len(word) > limit:
                pieces.append(current)
                current = word
            else:
                current = f'{current} {word}' if current else word
        if current:
            pieces.append(current)

    turns: List[str] = []
    current = ''
    for piece in pieces:
        if current and len(current) + 1 + len(piece) > limit:
            turns.append(current)
            current = piece
        else:
            current = f'{current} {piece}' if current else piece
    if current:
        turns.append(current)
    return turns
