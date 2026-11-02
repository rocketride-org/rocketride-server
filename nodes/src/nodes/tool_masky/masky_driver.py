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
Masky tool-provider driver.

Exposes the public Masky API (avatars, voices, looks, speech, scene video,
images, live conversations and agent binding) to agents as namespaced tools.
Every input is validated in ``_tool_validate`` before any HTTP request, and
every paid render is estimated and checked against the per-call credit cap
first.

API docs: https://masky.ai/api/docs/masky-openapi.json
"""

from __future__ import annotations

import json
import re
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from ai.common.tools import ToolsBase
from ai.common.utils import (
    normalize_tool_input,
    optional_bool,
    optional_int,
    optional_str,
    require_bool,
    require_str,
)

from .masky_client import MaskyClient
from .masky_core import (
    ASPECT_RATIOS,
    JOB_KINDS,
    LIMITS,
    MaskyCancelled,
    MaskyError,
    check_budget,
    decode_job_id,
    encode_job_id,
    estimate_image,
    estimate_speak,
    estimate_turn,
    estimate_video,
    image_receipt,
    look_id_for,
    MAX_EDIT_IMAGES,
    MAX_QWEN_IMAGES,
    poll,
    rates_from_pricing,
    resolve_look,
    speak_receipt,
    speak_status,
    strip_media_urls,
    timeout_warning,
    url_expires_at,
    video_receipt,
)

# ---------------------------------------------------------------------------
# Schema helpers
# ---------------------------------------------------------------------------


def _s(description: str, **extra: Any) -> Dict[str, Any]:
    return {'type': 'string', 'description': description, **extra}


def _b(description: str) -> Dict[str, Any]:
    return {'type': 'boolean', 'description': description}


def _i(description: str, **extra: Any) -> Dict[str, Any]:
    return {'type': 'integer', 'description': description, **extra}


def _obj(properties: Dict[str, Any], required: Optional[List[str]] = None) -> Dict[str, Any]:
    schema: Dict[str, Any] = {'type': 'object', 'properties': properties}
    if required:
        schema['required'] = required
    return schema


AVATAR_ID = _s("Masky avatar id, or @handle. Defaults to the node's Default Avatar.")
LOOK_ID = _s('A look_id from list_looks.')
LOOK_URL = _s('A registered look image URL (from list_looks). Use look_id or look_url, not both.')
WAIT = _b(
    "Wait until the render finishes (up to the node's Render Timeout) instead of returning straight away. Default false."
)
OUTPUT = _s('audio (voice only) or video (lip-synced talking head). Default video.', enum=['audio', 'video'])

RECEIPT_NOTE = (
    'Returns a receipt {generation_id, kind, status: queued|running|done|failed, media: {mime, url?, url_expires_at?}, '
    'estimated_credits, credits_charged, elapsed_sec, warnings, error?}. Signed media URLs expire after about an hour.'
)

PUBKEY_RE = re.compile(r'^[0-9a-f]{64}$')

# Defaults for agent tool calls. They are fixed here, not taken from the node's
# pipeline-action settings, so an agent's call never inherits a hidden setting
# (a 1080p pipeline would otherwise make every agent video 1080p).
TOOL_DEFAULTS: Dict[str, Any] = {
    'text_mode': 'literal',
    'resolution': '720p',
    'draft': True,
    'fps': 24,
    'aspect_ratio': '16:9',
    'duration_sec': 5,
    'silent': False,
    'expand_prompt': True,
    'share': 'private',
    'engine': 'default',
    'edit_engine': 'default',
}

# Permission switches, matching the repo's conventions (tool_github/tool_gohighlevel
# readOnly, tool_filesystem/calendar allowDelete, calendar allowPublicSharing).
# Tools that change or spend nothing stay available in read-only mode.
READ_TOOLS = frozenset(
    {
        'list_avatars',
        'get_avatar',
        'get_stream_identity',
        'list_voices',
        'list_looks',
        'get_generation',
        'estimate_cost',
        'get_turns',
        'get_binding',
    }
)
# Tools that delete something need allowDelete, even when read-only mode is off.
DELETE_TOOLS = frozenset({'unbind_agent', 'delete_conversation', 'delete_turn'})

READ_ONLY_REFUSAL = 'This operation is not permitted: the node is configured in read-only mode (readOnly).'

NAME_LOCKED_MESSAGE = "This avatar's name is locked to its linked Twitch account; change it on Twitch or masky.ai."


def _flag_refusal(op: str, flag: str) -> str:
    return f'{op} is gated by {flag!r}, which is off by default. Enable {flag!r} in the node config to allow it.'


# Bound on the run-scoped job and image caches, so a long-lived pipeline
# (fed by a webhook, say) does not grow them without limit.
CACHE_LIMIT = 500


_CACHE_LOCK = threading.Lock()


def _remember(cache: Dict[str, Any], key: str, value: Any) -> None:  # noqa: ANN401
    """Insert into an insertion-ordered dict, dropping the oldest entries past CACHE_LIMIT.

    Runs after a paid request, so it must never raise: concurrent renders share
    the caches, hence the lock and the tolerant pop.
    """
    with _CACHE_LOCK:
        cache.pop(key, None)
        cache[key] = value
        while len(cache) > CACHE_LIMIT:
            cache.pop(next(iter(cache)), None)


def _str(value: Any) -> str:  # noqa: ANN401
    return value.strip() if isinstance(value, str) else ''


def _str_or_none(value: Any) -> Optional[str]:  # noqa: ANN401
    return _str(value) or None


def _is_http(url: str) -> bool:
    return url.lower().startswith(('http://', 'https://'))


# ---------------------------------------------------------------------------
# Validation helpers (raise ValueError before any request)
# ---------------------------------------------------------------------------


# Type checks use the shared strict helpers in ai.common.utils.tool_args
# (require_str, optional_str, require_bool, optional_bool, optional_int). The
# helpers below cover what those do not: enums, Masky's length limits, public
# URLs and the look_id / look_url pair.


def _max_len(value: str, name: str, limit: int, way_out: str) -> None:
    if len(value) > limit:
        raise ValueError(f'{name} is {len(value)} characters; Masky accepts {limit}. {way_out}')


def _enum(args: Dict[str, Any], name: str, allowed: Tuple[Any, ...]) -> None:
    if args.get(name) is not None and args.get(name) not in allowed:
        raise ValueError(f'{name} must be one of {", ".join(map(str, allowed))} (got {args.get(name)!r})')


def _int_range(args: Dict[str, Any], name: str, minimum: int, maximum: Optional[int] = None) -> None:
    """Range-check an optional integer and store it back as an int (a numeric string is accepted)."""
    if args.get(name) is not None:
        args[name] = optional_int(args, name, lo=minimum, hi=maximum)


def _url(args: Dict[str, Any], name: str, required: bool = False) -> None:
    optional_str(args, name)
    value = _str(args.get(name))
    if not value:
        if required:
            raise ValueError(f'{name} is required')
        return
    if not _is_http(value):
        raise ValueError(f'{name} must be a public http(s) URL; Masky cannot read uploaded or local files')


def _one_look(args: Dict[str, Any]) -> None:
    optional_str(args, 'look_id')
    _url(args, 'look_url')
    if _str(args.get('look_id')) and _str(args.get('look_url')):
        raise ValueError('Pass look_id or look_url, not both')


def _edit_sources(args: Dict[str, Any]) -> List[str]:
    """image_url plus images, deduplicated, in order."""
    sources: List[str] = []
    for url in [args.get('image_url')] + list(args.get('images') or []):
        url = _str(url)
        if url and url not in sources:
            sources.append(url)
    return sources


def _is_object_input(value: Any) -> bool:  # noqa: ANN401
    """True for input normalize_tool_input reads as an object: None, a dict, a model or a JSON object string."""
    if value is None or isinstance(value, dict) or hasattr(value, 'model_dump') or hasattr(value, 'dict'):
        return True
    if isinstance(value, str):
        try:
            return isinstance(json.loads(value or '{}'), dict)
        except ValueError:
            return False
    return False


def _bool_arg(args: Dict[str, Any], *names: str) -> None:
    for name in names:
        optional_bool(args, name)


class MaskyDriver(ToolsBase):
    """Tool driver that exposes the Masky API to agents."""

    def __init__(  # noqa: D107
        self,
        *,
        server_name: str,
        client: MaskyClient,
        include_media_urls: bool = True,
        settings: Optional[Dict[str, Any]] = None,
        is_cancelled: Optional[Callable[[], bool]] = None,
    ) -> None:
        self._server_name = (server_name or '').strip() or 'masky'
        self._client = client
        self._include_media_urls = include_media_urls
        self._settings = settings or {}
        self._is_cancelled = is_cancelled
        # Run-scoped state: image receipts (Masky has no image lookup), render
        # metadata for jobs this node started, and conversations it created.
        self._images: Dict[str, Dict[str, Any]] = {}
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._conversations: Dict[str, Dict[str, Any]] = {}
        self._owners: Dict[str, str] = {}
        self._pipeline_conversation: Optional[Dict[str, Any]] = None
        self._lock = threading.Lock()
        self._pricing_lock = threading.Lock()
        self._live_rates: Optional[Dict[str, Any]] = None
        self._pricing_loaded = False

        self._tools: Dict[str, Dict[str, Any]] = {
            # Avatars
            'list_avatars': {
                'description': (
                    "List the Masky avatars this API key owns. Optional: include_public (also list other users' public "
                    'avatars), query (substring of name or handle). Returns [{avatar_id, name, handle, voice_id, public, own}]. '
                    'An avatar with no voice_id cannot speak until set_avatar_voice.'
                ),
                'schema': _obj(
                    {
                        'include_public': _b('Also list public avatars. Default false.'),
                        'query': _s('Case-insensitive substring of the avatar name or handle.'),
                    }
                ),
                'run': self._list_avatars,
            },
            'get_avatar': {
                'description': (
                    'Get one avatar with its looks and voice. Pass exactly one of avatar_id, handle or twitch_name. '
                    'Returns {avatar_id, name, handle, voice_id, personality, public, own, image_url?, looks: [{look_id, is_primary, created_at, url?}]}.'
                ),
                'schema': _obj(
                    {
                        'avatar_id': _s('Masky avatar id.'),
                        'handle': _s('Masky username, with or without @.'),
                        'twitch_name': _s('Twitch username of the avatar owner.'),
                    }
                ),
                'run': self._get_avatar,
            },
            'create_avatar': {
                'description': (
                    'Create a NEW Masky avatar. Masky has no edit endpoint, so every call creates another avatar. '
                    'Required: name (up to 80 chars), image_url (public http(s) face image). Optional: personality (up to 4000 chars), '
                    'voice_id (from list_voices), knowledge_urls (up to 10 public URLs). Returns {avatar_id, name, voice_id}.'
                ),
                'schema': _obj(
                    {
                        'name': _s('Display name, up to 80 characters.'),
                        'image_url': _s('Public http(s) URL of the face image.'),
                        'personality': _s('Personality prompt, up to 4000 characters.'),
                        'voice_id': _s('A voice_id from list_voices.'),
                        'knowledge_urls': {
                            'type': 'array',
                            'items': {'type': 'string'},
                            'description': 'Up to 10 public URLs the avatar learns from.',
                        },
                        'public': _b('Let other Masky users render this avatar. Default false.'),
                    },
                    ['name', 'image_url'],
                ),
                'run': self._create_avatar,
            },
            'train_avatar': {
                'description': (
                    'Start Masky "Gem" training from the avatar\'s personality and knowledge URLs. Required: avatar_id. '
                    'Masky reports only "trained or queued"; training progress cannot be polled.'
                ),
                'schema': _obj({'avatar_id': _s('Masky avatar id.')}, ['avatar_id']),
                'run': self._train_avatar,
            },
            'rename_avatar': {
                'description': (
                    'Rename one of your avatars. Required: avatar_id, name (1 to 80 characters). An avatar whose name is '
                    'locked to a linked Twitch account cannot be renamed here. Returns {avatar_id, name}.'
                ),
                'schema': _obj(
                    {'avatar_id': _s('One of your avatar ids.'), 'name': _s('New display name, 1 to 80 characters.')},
                    ['avatar_id', 'name'],
                ),
                'run': self._rename_avatar,
            },
            'set_avatar_public': {
                'description': (
                    'Make one of your avatars public (other Masky users can render it) or private. Required: avatar_id, public (true|false). '
                    'Returns {avatar_id, public}.'
                ),
                'schema': _obj(
                    {'avatar_id': _s('One of your avatar ids.'), 'public': _b('true makes it public, false private.')},
                    ['avatar_id', 'public'],
                ),
                'run': self._set_avatar_public,
            },
            'get_stream_identity': {
                'description': (
                    "Get the account's stream identity: the one avatar (and look) used for stream overlays. It is set per account, "
                    'not per avatar. Returns {stream_identity: null or {avatar_id, look_id, display_name, voice_id, updated_at}}.'
                ),
                'schema': _obj({}),
                'run': self._get_stream_identity,
            },
            'set_stream_identity': {
                'description': (
                    "Set or clear the account's stream identity. Pass avatar_id (one of your avatars) with an optional look_id or look_url, "
                    'or clear=true to remove it. Returns the stored stream identity (null once cleared).'
                ),
                'schema': _obj(
                    {
                        'avatar_id': _s('One of your avatar ids.'),
                        'look_id': LOOK_ID,
                        'look_url': LOOK_URL,
                        'clear': _b('Remove the stream identity instead of setting it.'),
                    }
                ),
                'run': self._set_stream_identity,
            },
            # Voices
            'list_voices': {
                'description': (
                    "List the voices an avatar can speak with: presets plus the account's custom voices. "
                    'Optional: query (substring of the voice name), include_custom (default true). Returns [{voice_id, name, kind: preset|custom}].'
                ),
                'schema': _obj(
                    {
                        'query': _s('Case-insensitive substring of the voice name.'),
                        'include_custom': _b('Include custom (cloned) voices. Default true.'),
                    }
                ),
                'run': self._list_voices,
            },
            'set_avatar_voice': {
                'description': 'Attach a voice to an avatar so it can speak. Required: avatar_id, voice_id (from list_voices). Returns {ok}.',
                'schema': _obj(
                    {'avatar_id': _s('Masky avatar id.'), 'voice_id': _s('A voice_id from list_voices.')},
                    ['avatar_id', 'voice_id'],
                ),
                'run': self._set_avatar_voice,
            },
            # Looks
            'list_looks': {
                'description': (
                    "List an avatar's looks (registered still images it can render with). Required: avatar_id. "
                    'Returns [{look_id, is_primary, created_at}]. Pass a look_id to speak, generate_video or create_conversation.'
                ),
                'schema': _obj({'avatar_id': AVATAR_ID}, ['avatar_id']),
                'run': self._list_looks,
            },
            'add_look': {
                'description': (
                    'Register a new look on an avatar from a public image URL (http(s), up to 12 MB). Masky has no upload, so '
                    'the image must already be online. Required: avatar_id, image_url. Returns {avatar_id, look_id, url?}.'
                ),
                'schema': _obj(
                    {'avatar_id': _s('Masky avatar id.'), 'image_url': _s('Public http(s) image URL.')},
                    ['avatar_id', 'image_url'],
                ),
                'run': self._add_look,
            },
            # Renders
            'speak': {
                'description': (
                    'Make an avatar speak text: a lip-synced talking-head video, or voice-only audio. Required: text (up to 500 '
                    'characters; split longer text first). Optional: avatar_id, output (video|audio, default video), look_id or look_url, '
                    'language, text_mode (literal reads the text as written; personality lets the avatar rephrase it), wait_for_completion. '
                    "Refused before any request if the estimate exceeds the node's credit cap. Without waiting the receipt is queued, unless Masky "
                    'answers at once (for example a reused identical request), when it is done. '
                    + RECEIPT_NOTE
                    + ' Also: spoken_text, share_url, reused.'
                ),
                'schema': _obj(
                    {
                        'text': _s('What the avatar says, up to 500 characters.'),
                        'avatar_id': AVATAR_ID,
                        'output': OUTPUT,
                        'look_id': LOOK_ID,
                        'look_url': LOOK_URL,
                        'language': _s('Spoken language code, e.g. en, es, fr.'),
                        'text_mode': _s('literal or personality. Default literal.', enum=['literal', 'personality']),
                        'wait_for_completion': WAIT,
                    },
                    ['text'],
                ),
                'run': self._speak,
            },
            'generate_video': {
                'description': (
                    'Render a cinematic scene video from a prompt, optionally animating an image. NOT lip-synced: use speak for a talking '
                    'head. Required: prompt (up to 2000 chars). Optional: image_url (public http(s)) or look_id/look_url (needs avatar_id), last_frame_image_url; '
                    "speech_text (up to 300 chars, spoken in the avatar's voice, sets the length; needs a voiced avatar) or audio_url; "
                    'duration_sec 1-20 (default 5; ignored with speech); resolution 720p|1080p; fps 24|48; aspect_ratio; seed; draft '
                    '(about 40% cheaper); silent; expand_prompt; share private|public; wait_for_completion. Renders take up to about 3 minutes. '
                    + RECEIPT_NOTE
                    + ' Also: share_url.'
                ),
                'schema': _obj(
                    {
                        'prompt': _s('Scene description, up to 2000 characters.'),
                        'avatar_id': AVATAR_ID,
                        'image_url': _s('Public http(s) image to animate.'),
                        'look_id': LOOK_ID,
                        'look_url': LOOK_URL,
                        'speech_text': _s("Line spoken in the avatar's voice, up to 300 characters."),
                        'audio_url': _s('Public http(s) audio track.'),
                        'last_frame_image_url': _s('Public http(s) image the clip ends on.'),
                        'duration_sec': _i('Clip length, 1 to 20 seconds. Default 5.', minimum=1, maximum=20),
                        'resolution': _s('720p or 1080p.', enum=['720p', '1080p']),
                        'fps': _i('24 or 48.', enum=[24, 48]),
                        'aspect_ratio': _s('Frame shape.', enum=list(ASPECT_RATIOS)),
                        'seed': _i('Optional seed for repeatable results.', minimum=0),
                        'draft': _b('Draft quality, about 40% cheaper.'),
                        'silent': _b('Render without an audio track.'),
                        'expand_prompt': _b('Let Masky enrich the prompt. Default true.'),
                        'share': _s('Who can open the share page. Default private.', enum=['private', 'public']),
                        'wait_for_completion': WAIT,
                    },
                    ['prompt'],
                ),
                'run': self._generate_video,
            },
            'generate_image': {
                'description': (
                    'Generate an image from a prompt. Images return immediately (no job to poll) and their ids cannot be looked up in a later '
                    'run. Required: prompt (up to 2000 chars). Optional: engine (default|ideogram; ideogram costs about 3x), aspect_ratio. '
                    + RECEIPT_NOTE
                ),
                'schema': _obj(
                    {
                        'prompt': _s('Image description.'),
                        'engine': _s('default or ideogram.', enum=['default', 'ideogram']),
                        'aspect_ratio': _s('Frame shape.', enum=list(ASPECT_RATIOS)),
                    },
                    ['prompt'],
                ),
                'run': self._generate_image,
            },
            'edit_image': {
                'description': (
                    'Edit, restyle or compose images with an instruction. Masky reads images only from public http(s) URLs. Required: prompt '
                    '(the instruction) and image_url and/or images (up to 5 images in total, e.g. to combine references). Optional: engine '
                    '(default|qwen; qwen costs about 3x), aspect_ratio. Returns immediately. ' + RECEIPT_NOTE
                ),
                'schema': _obj(
                    {
                        'image_url': _s('Public http(s) image to edit.'),
                        'images': {
                            'type': 'array',
                            'items': {'type': 'string'},
                            'description': 'Up to 5 public http(s) reference images (with image_url, 5 in total).',
                        },
                        'prompt': _s('Edit instruction, e.g. "make it a studio portrait".'),
                        'engine': _s('default or qwen.', enum=['default', 'qwen']),
                        'aspect_ratio': _s('Optional output frame shape, e.g. 1:1.'),
                    },
                    ['prompt'],
                ),
                'run': self._edit_image,
            },
            'get_generation': {
                'description': (
                    'Check a render by its generation_id (speak:..., video:..., image:...). A raw Masky id also works with kind. '
                    'Optional: wait_for_completion. Image results exist only for the current run. ' + RECEIPT_NOTE
                ),
                'schema': _obj(
                    {
                        'generation_id': _s('The generation_id a render returned.'),
                        'kind': _s('speak, video or image; only needed for a raw id.', enum=list(JOB_KINDS)),
                        'wait_for_completion': WAIT,
                    },
                    ['generation_id'],
                ),
                'run': self._get_generation,
            },
            'estimate_cost': {
                'description': (
                    "Estimate the credits a render would cost. Makes no render request (it may read Masky's free pricing once per run). "
                    'Required: kind (speak|video|image|turn) plus that '
                    "call's parameters (speak: text, output, text_mode; video: duration_sec, resolution, draft, speech_text, audio_url; image: engine, "
                    'image_url for an edit; turn: text, mode, output, reinterpret). Returns {estimated_credits, basis, price_table_date, verified, cap, within_cap}.'
                ),
                'schema': _obj(
                    {
                        'kind': _s('What to estimate.', enum=['speak', 'video', 'image', 'turn']),
                        'text': _s('speak or turn text.'),
                        'output': OUTPUT,
                        'duration_sec': _i('Scene video length, 1 to 20.', minimum=1, maximum=20),
                        'resolution': _s('720p or 1080p.', enum=['720p', '1080p']),
                        'draft': _b('Draft scene video.'),
                        'speech_text': _s('Scene video speech line.'),
                        'audio_url': _s('Scene video audio track.'),
                        'engine': _s(
                            'Image engine: default, ideogram, or qwen for edits.', enum=['default', 'ideogram', 'qwen']
                        ),
                        'image_url': _s('Set for an image edit.'),
                        'mode': _s('Live turn mode: chat or speak.', enum=['chat', 'speak']),
                        'text_mode': _s('speak: literal or personality.', enum=['literal', 'personality']),
                        'reinterpret': _b('turn: speak mode with reinterpret.'),
                    },
                    ['kind'],
                ),
                'run': self._estimate_cost,
            },
            # Live
            'create_conversation': {
                'description': (
                    'Start a live Masky conversation with an avatar, viewable on a share page and a live page (e.g. an OBS overlay). '
                    'Optional: avatar_id, look_id or look_url. Returns {conversation_slug, conversation_id, share_url, live_url?}.'
                ),
                'schema': _obj({'avatar_id': AVATAR_ID, 'look_id': LOOK_ID, 'look_url': LOOK_URL}),
                'run': self._create_conversation,
            },
            'set_conversation_visibility': {
                'description': (
                    'Make a live conversation public (anyone with the share link can watch) or private. New conversations start private. '
                    'Required: slug (or conversation_id), public (true|false). Returns {conversation_slug, conversation_id, public}.'
                ),
                'schema': _obj(
                    {
                        'slug': _s('Conversation slug (c-..).'),
                        'conversation_id': _s('Conversation id.'),
                        'public': _b('true makes it public, false private.'),
                    },
                    ['public'],
                ),
                'run': self._set_conversation_visibility,
            },
            'send_turn': {
                'description': (
                    'Send one turn into a live conversation. Required: slug (or conversation_id), text (up to 500 chars). Optional: mode '
                    '(chat: the avatar answers; speak: it says the text as written; default chat), output (audio|video, default audio), '
                    'wait_for_agent (wait until the turn renders; needs the slug). Returns {turn_id, status, user_text, avatar_text, media, share_url, '
                    'credits_charged (null until Masky reports turn charges), estimated_credits, warnings?}.'
                ),
                'schema': _obj(
                    {
                        'slug': _s('Conversation slug (c-..).'),
                        'conversation_id': _s('Conversation id, if you have it instead of the slug.'),
                        'text': _s('Turn text, up to 500 characters.'),
                        'mode': _s('chat or speak. Default chat.', enum=['chat', 'speak']),
                        'output': _s('audio or video. Default audio.', enum=['audio', 'video']),
                        'wait_for_agent': _b('Wait until the turn has rendered. Default false.'),
                        'reinterpret': _b(
                            'speak mode only: let the avatar rewrite the text in its own voice before speaking it.'
                        ),
                    },
                    ['text'],
                ),
                'run': self._send_turn,
            },
            'get_turns': {
                'description': (
                    'Read the turns of a live conversation. Required: slug. Optional: since (a turn_id or createdAt epoch ms; only later '
                    'turns), limit (1-100, default 20, newest last). Returns {conversation_slug, turns, count}.'
                ),
                'schema': _obj(
                    {
                        'slug': _s('Conversation slug (c-..).'),
                        'since': _s('A turn_id, or a createdAt value in epoch milliseconds written as digits.'),
                        'limit': _i('1 to 100. Default 20.', minimum=1, maximum=100),
                    },
                    ['slug'],
                ),
                'run': self._get_turns,
            },
            'set_conversation_look': {
                'description': (
                    'Change which look a live conversation shows. Required: slug (or conversation_id) and look_id or look_url. Optional: '
                    'avatar_id when the conversation was not created in this run. Returns {ok, look_id}.'
                ),
                'schema': _obj(
                    {
                        'slug': _s('Conversation slug.'),
                        'conversation_id': _s('Conversation id.'),
                        'look_id': LOOK_ID,
                        'look_url': LOOK_URL,
                        'avatar_id': AVATAR_ID,
                    }
                ),
                'run': self._set_conversation_look,
            },
            # Cleanup (endpoints from Masky's answers, not yet in the published spec)
            'delete_conversation': {
                'description': (
                    'Delete one of your live conversations and all its turns. Deleted conversations cannot be recovered. '
                    "Required: conversation_id. Needs the node's Allow deletion switch. Returns {conversation_id, deleted}."
                ),
                'schema': _obj(
                    {'conversation_id': _s('Conversation id (from create_conversation).')}, ['conversation_id']
                ),
                'run': self._delete_conversation,
            },
            'delete_turn': {
                'description': (
                    'Delete one turn from a live conversation. This is a soft delete: restore_turn brings it back. '
                    "Required: conversation_id, turn_id. Needs the node's Allow deletion switch. Returns {conversation_id, turn_id, deleted, restorable}."
                ),
                'schema': _obj(
                    {
                        'conversation_id': _s('Conversation id.'),
                        'turn_id': _s('Turn id (from send_turn or get_turns).'),
                    },
                    ['conversation_id', 'turn_id'],
                ),
                'run': self._delete_turn,
            },
            'restore_turn': {
                'description': 'Restore a turn removed with delete_turn. Required: conversation_id, turn_id. Returns {conversation_id, turn_id, restored}.',
                'schema': _obj(
                    {'conversation_id': _s('Conversation id.'), 'turn_id': _s('Turn id.')},
                    ['conversation_id', 'turn_id'],
                ),
                'run': self._restore_turn,
            },
            # Agent binding
            'bind_agent': {
                'description': (
                    'Bind an external agent to an avatar over Nostr: Masky publishes each conversation turn to the relay and the agent '
                    'answers with a signed reply. This only stores the binding; running the agent is up to you. Required: avatar_id, '
                    'pubkey (64 hex chars), relay (wss:// URL). Optional: timeout_sec (5-120, default 45), fallback (gemini|fail), enabled, '
                    'kind (Nostr event kind, default 9391), extra_tags. Returns {avatar_id, agent_binding}.'
                ),
                'schema': _obj(
                    {
                        'avatar_id': _s('One of your avatar ids.'),
                        'pubkey': _s('Agent public key, 64 lowercase hex characters.'),
                        'relay': _s('Nostr relay, wss://...'),
                        'timeout_sec': _i('Seconds Masky waits for the agent, 5 to 120.', minimum=5, maximum=120),
                        'fallback': _s(
                            'What Masky does on timeout: gemini answers instead, or fail.', enum=['gemini', 'fail']
                        ),
                        'enabled': _b('Default true.'),
                        'kind': _i('Nostr event kind Masky publishes turns as. Default 9391.', minimum=1),
                        'extra_tags': {
                            'type': 'array',
                            'items': {'type': 'array', 'items': {'type': 'string'}},
                            'description': 'Extra Nostr tags.',
                        },
                    },
                    ['avatar_id', 'pubkey', 'relay'],
                ),
                'run': self._bind_agent,
            },
            'get_binding': {
                'description': "Get an avatar's agent binding. Required: avatar_id. Returns {avatar_id, agent_binding: null or {...}}.",
                'schema': _obj({'avatar_id': _s('One of your avatar ids.')}, ['avatar_id']),
                'run': self._get_binding,
            },
            'unbind_agent': {
                'description': "Remove an avatar's agent binding. Required: avatar_id. Returns {avatar_id, agent_binding: null}.",
                'schema': _obj({'avatar_id': _s('One of your avatar ids.')}, ['avatar_id']),
                'run': self._unbind_agent,
            },
        }

    def close(self) -> None:
        """Release the client (clears the API key)."""
        self._client.close()

    def load_pricing(self) -> Optional[Dict[str, Any]]:
        """Fetch Masky's live video rates once per run (free, no auth). Any failure falls back to the dated table."""
        if not self._pricing_loaded:
            with self._pricing_lock:
                if not self._pricing_loaded:
                    try:
                        self._live_rates = rates_from_pricing(self._client.get_video_pricing())
                    except Exception:  # noqa: BLE001 - pricing must never block a render
                        self._live_rates = None
                    self._pricing_loaded = True
        return self._live_rates

    def download(self, url: str) -> bytes:
        """Fetch a finished media file (used by the pipeline step)."""
        return self._client.download(url)

    # ------------------------------------------------------------------
    # ToolsBase hooks
    # ------------------------------------------------------------------

    def _gate(self, bare: str) -> Optional[str]:
        """Why a tool is switched off for this node, or None when it is available."""
        if self._settings.get('read_only') and bare not in READ_TOOLS:
            return READ_ONLY_REFUSAL
        if bare in DELETE_TOOLS and not self._settings.get('allow_delete'):
            return _flag_refusal(f'{self._server_name}.{bare}', 'allowDelete')
        return None

    def _require_public_sharing(self, op: str) -> None:
        """Making something public needs allowPublicSharing; making it private never does."""
        if not self._settings.get('allow_public_sharing'):
            raise ValueError(_flag_refusal(op, 'allowPublicSharing'))

    def _owns_tool(self, tool_name: str) -> bool:
        """Own every tool this node registers, including ones a permission switch hides.

        ToolsBase routes tool.validate / tool.invoke only to tools the node owns, and its
        default reads _tool_query, which leaves switched-off tools out. Owning them here
        lets _tool_validate refuse a direct call with a message naming the switch.
        """
        prefix, sep, bare = (tool_name or '').partition('.')
        return bool(sep) and prefix == self._server_name and bare in self._tools

    def _tool_query(self) -> List[Dict[str, Any]]:
        # A switched-off tool is hidden, so an agent never sees it; invoking it anyway is refused.
        return [
            {'name': f'{self._server_name}.{name}', 'description': info['description'], 'inputSchema': info['schema']}
            for name, info in self._tools.items()
            if self._gate(name) is None
        ]

    def _bare(self, tool_name: str) -> str:
        return tool_name.split('.', 1)[-1] if '.' in tool_name else tool_name

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:  # noqa: ANN401
        self._checked_args(tool_name, input_obj)

    def _checked_args(self, tool_name: str, input_obj: Any) -> Tuple[str, Dict[str, Any]]:  # noqa: ANN401
        """Refuse an unknown or switched-off tool, normalise its input and check it; return (bare, args)."""
        bare = self._bare(tool_name)
        if bare not in self._tools:
            raise ValueError(
                f'Unknown tool {tool_name!r}. Available: {", ".join(f"{self._server_name}.{t}" for t in self._tools)}'
            )
        refusal = self._gate(bare)
        if refusal:
            raise ValueError(refusal)
        args = normalize_tool_input(input_obj, tool_name=self._server_name)
        if not args and not _is_object_input(input_obj):
            # normalize_tool_input turns a list, number or non-JSON string into {}; refuse it
            # rather than run the tool with its defaults.
            raise ValueError('Tool input must be a JSON object')
        self._validate_args(bare, args)
        return bare, args

    def _validate_args(self, bare: str, a: Dict[str, Any]) -> None:  # noqa: C901
        """Check one tool's arguments in place; integers given as numeric strings are stored back as ints."""
        if bare == 'list_avatars':
            optional_str(a, 'query')
            _bool_arg(a, 'include_public')
        elif bare == 'get_avatar':
            for key in ('avatar_id', 'handle', 'twitch_name'):
                optional_str(a, key)
            given = [k for k in ('avatar_id', 'handle', 'twitch_name') if _str(a.get(k))]
            if len(given) != 1:
                raise ValueError('Pass exactly one of avatar_id, handle or twitch_name')
        elif bare == 'create_avatar':
            _max_len(require_str(a, 'name'), 'name', LIMITS['avatar_name_chars'], 'Shorten it.')
            _url(a, 'image_url', required=True)
            optional_str(a, 'personality')
            _max_len(_str(a.get('personality')), 'personality', LIMITS['personality_chars'], 'Shorten it.')
            optional_str(a, 'voice_id')
            urls = a.get('knowledge_urls')
            if urls is not None:
                if not isinstance(urls, list) or len(urls) > LIMITS['knowledge_urls_max']:
                    raise ValueError(f'knowledge_urls must be a list of up to {LIMITS["knowledge_urls_max"]} URLs')
                for url in urls:
                    if not isinstance(url, str) or not _is_http(url.strip()):
                        raise ValueError('knowledge_urls must contain public http(s) URLs')
            _bool_arg(a, 'public')
            if optional_bool(a, 'public', default=False):
                self._require_public_sharing(f'{self._server_name}.create_avatar(public=true)')
        elif bare == 'delete_conversation':
            require_str(a, 'conversation_id')
        elif bare in ('delete_turn', 'restore_turn'):
            require_str(a, 'conversation_id')
            require_str(a, 'turn_id')
        elif bare in ('train_avatar', 'list_looks', 'get_binding', 'unbind_agent'):
            require_str(a, 'avatar_id')
        elif bare == 'rename_avatar':
            require_str(a, 'avatar_id')
            _max_len(require_str(a, 'name'), 'name', LIMITS['avatar_name_chars'], 'Shorten it.')
        elif bare == 'set_avatar_public':
            require_str(a, 'avatar_id')
            if require_bool(a, 'public'):
                self._require_public_sharing(f'{self._server_name}.set_avatar_public(public=true)')
        elif bare == 'set_stream_identity':
            _bool_arg(a, 'clear')
            optional_str(a, 'avatar_id')
            clearing = optional_bool(a, 'clear', default=False)
            if clearing and (_str(a.get('avatar_id')) or _str(a.get('look_id')) or _str(a.get('look_url'))):
                raise ValueError('Pass clear=true on its own, or avatar_id (with an optional look) to set it')
            if not clearing and not _str(a.get('avatar_id')):
                raise ValueError('avatar_id is required (or clear=true to remove the stream identity)')
            _one_look(a)
        elif bare == 'list_voices':
            optional_str(a, 'query')
            _bool_arg(a, 'include_custom')
        elif bare == 'set_avatar_voice':
            require_str(a, 'avatar_id')
            require_str(a, 'voice_id')
        elif bare == 'add_look':
            require_str(a, 'avatar_id')
            _url(a, 'image_url', required=True)
        elif bare == 'speak':
            _max_len(require_str(a, 'text'), 'text', LIMITS['speech_chars'], 'Split it into several speak calls.')
            self._validate_avatar(a)
            _enum(a, 'output', ('audio', 'video'))
            _enum(a, 'text_mode', ('literal', 'personality'))
            optional_str(a, 'language')
            _one_look(a)
            _bool_arg(a, 'wait_for_completion')
        elif bare == 'generate_video':
            _max_len(require_str(a, 'prompt'), 'prompt', LIMITS['video_prompt_chars'], 'Shorten the prompt.')
            _url(a, 'image_url')
            _one_look(a)
            if _str(a.get('image_url')) and (_str(a.get('look_id')) or _str(a.get('look_url'))):
                raise ValueError('Pass image_url or a look, not both')
            if (_str(a.get('look_id')) or _str(a.get('look_url'))) and not (
                _str(a.get('avatar_id')) or self._settings.get('default_avatar')
            ):
                raise ValueError('A look needs avatar_id (or a Default Avatar on the node)')
            optional_str(a, 'speech_text')
            _max_len(_str(a.get('speech_text')), 'speech_text', LIMITS['video_speech_chars'], 'Shorten the line.')
            _url(a, 'audio_url')
            if _str(a.get('speech_text')) and _str(a.get('audio_url')):
                raise ValueError('Pass speech_text or audio_url, not both')
            _url(a, 'last_frame_image_url')
            if _str(a.get('speech_text')) and not (_str(a.get('avatar_id')) or self._settings.get('default_avatar')):
                raise ValueError('speech_text needs avatar_id (or a Default Avatar on the node) whose voice speaks it')
            _int_range(a, 'duration_sec', LIMITS['video_duration_min'], LIMITS['video_duration_max'])
            _enum(a, 'resolution', ('720p', '1080p'))
            _enum(a, 'fps', (24, 48))
            _enum(a, 'aspect_ratio', ASPECT_RATIOS)
            _int_range(a, 'seed', 0)
            _enum(a, 'share', ('private', 'public'))
            if a.get('share') == 'public':
                self._require_public_sharing(f'{self._server_name}.generate_video(share=public)')
            _bool_arg(a, 'draft', 'silent', 'expand_prompt', 'wait_for_completion')
        elif bare == 'generate_image':
            _max_len(require_str(a, 'prompt'), 'prompt', LIMITS['image_prompt_chars'], 'Shorten the prompt.')
            _enum(a, 'engine', ('default', 'ideogram'))
            _enum(a, 'aspect_ratio', ASPECT_RATIOS)
        elif bare == 'edit_image':
            _url(a, 'image_url')
            images = a.get('images')
            if images is not None:
                if not isinstance(images, list) or not all(isinstance(u, str) and _is_http(u.strip()) for u in images):
                    raise ValueError('images must be a list of public http(s) URLs')
            sources = _edit_sources(a)
            if not sources:
                raise ValueError('image_url or images is required')
            if len(sources) > MAX_EDIT_IMAGES:
                raise ValueError(f'Masky accepts up to {MAX_EDIT_IMAGES} images per edit; got {len(sources)}')
            if _str(a.get('engine')) == 'qwen' and len(sources) > MAX_QWEN_IMAGES:
                raise ValueError(
                    f'The qwen edit engine takes at most {MAX_QWEN_IMAGES} images; got {len(sources)}. Use engine=default for up to {MAX_EDIT_IMAGES}.'
                )
            _max_len(require_str(a, 'prompt'), 'prompt', LIMITS['image_prompt_chars'], 'Shorten the instruction.')
            _enum(a, 'engine', ('default', 'qwen'))
            optional_str(a, 'aspect_ratio')
        elif bare == 'get_generation':
            require_str(a, 'generation_id')
            _enum(a, 'kind', JOB_KINDS)
            decode_job_id(a['generation_id'], _str(a.get('kind')) or None)
            _bool_arg(a, 'wait_for_completion')
        elif bare == 'estimate_cost':
            require_str(a, 'kind')
            _enum(a, 'kind', ('speak', 'video', 'image', 'turn'))
            _enum(a, 'output', ('audio', 'video'))
            _enum(a, 'resolution', ('720p', '1080p'))
            _enum(a, 'mode', ('chat', 'speak'))
            _enum(a, 'text_mode', ('literal', 'personality'))
            _bool_arg(a, 'reinterpret', 'draft')
            _int_range(a, 'duration_sec', LIMITS['video_duration_min'], LIMITS['video_duration_max'])
            kind = a['kind']
            if kind in ('speak', 'turn'):
                require_str(a, 'text')
            if kind == 'image':
                _enum(a, 'engine', ('default', 'qwen') if _str(a.get('image_url')) else ('default', 'ideogram'))
        elif bare == 'create_conversation':
            self._validate_avatar(a)
            _one_look(a)
        elif bare == 'set_conversation_visibility':
            self._need_conversation(a)
            if require_bool(a, 'public'):
                self._require_public_sharing(f'{self._server_name}.set_conversation_visibility(public=true)')
        elif bare == 'send_turn':
            self._need_conversation(a)
            _bool_arg(a, 'reinterpret')
            if optional_bool(a, 'reinterpret', default=False) and (_str(a.get('mode')) or 'chat') != 'speak':
                raise ValueError('reinterpret only applies to mode=speak')
            _max_len(require_str(a, 'text'), 'text', LIMITS['turn_chars'], 'Split it into several turns.')
            _enum(a, 'mode', ('chat', 'speak'))
            _enum(a, 'output', ('audio', 'video'))
            _bool_arg(a, 'wait_for_agent')
        elif bare == 'get_turns':
            require_str(a, 'slug')
            since = a.get('since')
            if since is not None and (isinstance(since, bool) or not isinstance(since, (str, int))):
                raise ValueError('since must be a turn_id or epoch milliseconds')
            _int_range(a, 'limit', 1, 100)
        elif bare == 'set_conversation_look':
            self._need_conversation(a)
            _one_look(a)
            if not (_str(a.get('look_id')) or _str(a.get('look_url'))):
                raise ValueError('look_id or look_url is required')
        elif bare == 'bind_agent':
            require_str(a, 'avatar_id')
            if not PUBKEY_RE.match(require_str(a, 'pubkey')):
                raise ValueError('pubkey must be 64 lowercase hex characters (a Nostr public key)')
            if not require_str(a, 'relay').lower().startswith('wss://'):
                raise ValueError('relay must be a wss:// URL')
            _int_range(a, 'timeout_sec', 5, 120)
            _int_range(a, 'kind', 1)
            _enum(a, 'fallback', ('gemini', 'fail'))
            _bool_arg(a, 'enabled')
            tags = a.get('extra_tags')
            if tags is not None and (
                not isinstance(tags, list)
                or not all(isinstance(t, list) and all(isinstance(x, str) for x in t) for t in tags)
            ):
                raise ValueError('extra_tags must be a list of string lists, e.g. [["t", "support"]]')

    def _validate_avatar(self, a: Dict[str, Any]) -> None:
        optional_str(a, 'avatar_id')
        if not (_str(a.get('avatar_id')) or self._settings.get('default_avatar')):
            raise ValueError('avatar_id is required (or set a Default Avatar on the node). Find ids with list_avatars.')

    def _need_conversation(self, a: Dict[str, Any]) -> None:
        optional_str(a, 'slug')
        optional_str(a, 'conversation_id')
        if not (_str(a.get('slug')) or _str(a.get('conversation_id'))):
            raise ValueError('slug or conversation_id is required')

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:  # noqa: ANN401
        bare, args = self._checked_args(tool_name, input_obj)
        return self._tools[bare]['run'](args)

    # ------------------------------------------------------------------
    # Shared lookups
    # ------------------------------------------------------------------

    def _finish(self, receipt: Dict[str, Any]) -> Dict[str, Any]:
        return receipt if self._include_media_urls else strip_media_urls(receipt)

    def _url_field(self, url: Optional[str]) -> Dict[str, Any]:
        return {'url': url} if (self._include_media_urls and url) else {}

    def _resolve_avatar(self, a: Dict[str, Any]) -> Tuple[str, Optional[str]]:
        """Return (avatar_id, owner_user_id or None); resolves @handle via lookup."""
        value = _str(a.get('avatar_id')) or self._settings.get('default_avatar') or ''
        if not value.startswith('@'):
            return value, self._owners.get(value)
        found = self._client.lookup(value[1:])
        avatars = [x for x in (found.get('avatars') or []) if isinstance(x, dict)] if found.get('found') else []
        if not avatars:
            raise MaskyError(f'No Masky avatar found for {value}.')
        chosen = next((x for x in avatars if x.get('isDefaultAvatar')), avatars[0])
        avatar_id = str(chosen.get('avatarId'))
        owner = _str_or_none(chosen.get('avatarOwnerUserId')) or _str_or_none((found.get('owner') or {}).get('userId'))
        if owner:
            self._owners[avatar_id] = owner
        return avatar_id, owner

    def _owner_of(self, avatar_id: str) -> str:
        if avatar_id in self._owners:
            return self._owners[avatar_id]
        mine = self._client.list_avatars()
        for x in mine.get('avatars') or []:
            if isinstance(x, dict) and x.get('avatarId') == avatar_id:
                owner = _str_or_none(x.get('avatarOwnerUserId')) or _str_or_none(
                    (mine.get('owner') or {}).get('userId')
                )
                if owner:
                    self._owners[avatar_id] = owner
                    return owner
        for x in self._client.list_public_avatars():
            if x.get('avatarId') == avatar_id and _str(x.get('avatarOwnerUserId')):
                self._owners[avatar_id] = x['avatarOwnerUserId']
                return x['avatarOwnerUserId']
        raise MaskyError(f'Avatar {avatar_id} is neither yours nor public. Check the id with list_avatars.')

    def _looks(self, avatar_id: str, owner: Optional[str] = None) -> List[Dict[str, Any]]:
        data = self._client.list_images(avatar_id, owner)
        return [x for x in (data.get('images') or []) if isinstance(x, dict)]

    def _look_id_of(self, avatar_id: Optional[str], url: Optional[str], owner: Optional[str] = None) -> Optional[str]:
        """The look_id for a registered look URL, using Masky's assetId when it has one."""
        if not url:
            return None
        if avatar_id:
            key = url.split('?', 1)[0]
            for look in self._looks(avatar_id, owner):
                if (look.get('url') or '').split('?', 1)[0] == key:
                    return look_id_for(look.get('url') or '', look.get('assetId'))
        return look_id_for(url)

    def _look_url(
        self, avatar_id: str, a: Dict[str, Any], owner: Optional[str] = None, use_default: bool = True
    ) -> Optional[str]:
        value = (
            _str(a.get('look_url'))
            or _str(a.get('look_id'))
            or (self._settings.get('default_look') if use_default else '')
            or ''
        )
        if not value:
            return None
        return resolve_look(value, self._looks(avatar_id, owner))

    def _paid(self, estimate: Dict[str, Any], call: Callable[[], Any]) -> Any:  # noqa: ANN401
        """Run a paid request; name the estimate when Masky reports insufficient credits."""
        try:
            return call()
        except MaskyError as e:
            if e.status == 402:
                detail = getattr(e, 'credit_detail', '') or ''
                raise MaskyError(
                    f'Masky reports insufficient credits{detail} for a render estimated at {estimate["credits"]} credits. '
                    'Top up at https://masky.ai and retry.',
                    status=402,
                ) from None
            raise

    def _wait_after_paid(
        self,
        fetch: Callable[[], Any],
        is_done: Callable[[Any], bool],
        initial: Any,  # noqa: ANN401
        what: str,
    ) -> Tuple[Any, bool, Optional[str]]:
        """Wait after a paid request was accepted; a failing status check returns, it does not raise.

        Returns ``(result, finished, poll_error)``. If checking fails, ``result`` is the
        accepted response (``initial``) and ``poll_error`` says why, so the caller keeps
        the job id instead of losing it. Cancellation still propagates, naming ``what``.
        """
        try:
            result, finished = self._wait(fetch, is_done)
            return result, finished, None
        except MaskyCancelled as e:
            raise MaskyCancelled(
                f'{e} Masky had already accepted {what}; it may still render and be charged, so check it '
                'instead of sending it again.'
            ) from None
        except MaskyError as e:
            return initial, False, str(e)
        except (AttributeError, KeyError, TypeError, ValueError) as e:
            # A status reply in an unexpected shape must not lose the id either.
            return initial, False, f'Masky sent a status reply this node could not read ({type(e).__name__})'

    @staticmethod
    def _poll_failed(receipt: Dict[str, Any], what: str, error: str) -> None:
        """Mark a receipt whose status check failed after Masky accepted the request."""
        receipt['status'] = 'running' if receipt.get('status') in (None, 'queued', 'running') else receipt['status']
        receipt['poll_error'] = error
        receipt.setdefault('warnings', []).append(
            f'Could not check on {what} after Masky accepted it ({error}). It is probably still rendering and will be '
            'charged; check it later instead of sending it again.'
        )

    def _wait(self, fetch: Callable[[], Any], is_done: Callable[[Any], bool]) -> Tuple[Any, bool]:
        return poll(
            fetch,
            is_done,
            timeout_sec=self._settings.get('timeout_sec', 300),
            interval_sec=self._settings.get('poll_interval_sec', 3),
            is_cancelled=self._is_cancelled,
        )

    # ------------------------------------------------------------------
    # Avatars and voices
    # ------------------------------------------------------------------

    def _shape_avatar(self, a: Dict[str, Any], *, own: bool, owner: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        avatar_id = _str_or_none(a.get('avatarId'))
        if not avatar_id:
            return None
        handle = _str_or_none(a.get('avatarOwnerTwitchUsername'))
        if own and not handle:
            handle = _str_or_none(owner.get('username')) or _str_or_none(owner.get('twitchUsername'))
        shaped = {
            'avatar_id': avatar_id,
            'name': _str_or_none(a.get('displayName')) or avatar_id,
            'handle': handle,
            'voice_id': _str_or_none(a.get('voiceId')),
            'public': bool(a.get('publiclyRenderable')),
            'own': own,
        }
        if self._include_media_urls:
            shaped['image_url'] = _str_or_none(a.get('avatarImageUrl'))
        owner_id = _str_or_none(a.get('avatarOwnerUserId'))
        if owner_id:
            self._owners[avatar_id] = owner_id
        return shaped

    def _list_avatars(self, a: Dict[str, Any]) -> Dict[str, Any]:
        query = _str(a.get('query')).lower()
        data = self._client.list_avatars()
        owner = data.get('owner') if isinstance(data.get('owner'), dict) else {}
        avatars, seen = [], set()
        for x in data.get('avatars') or []:
            shaped = self._shape_avatar(x, own=True, owner=owner) if isinstance(x, dict) else None
            if shaped:
                seen.add(shaped['avatar_id'])
                avatars.append(shaped)
        if optional_bool(a, 'include_public', default=False):
            for x in self._client.list_public_avatars():
                shaped = self._shape_avatar(x, own=False, owner={})
                if shaped and shaped['avatar_id'] not in seen:
                    avatars.append(shaped)
        if query:
            avatars = [x for x in avatars if query in x['name'].lower() or query in (x['handle'] or '').lower()]
        return {'avatars': avatars, 'count': len(avatars)}

    def _shape_looks(self, looks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [
            {
                'look_id': look_id_for(x.get('url') or '', x.get('assetId')),
                'is_primary': bool(x.get('isPrimary')),
                'created_at': x.get('createdAt'),
                **self._url_field(x.get('url')),
            }
            for x in looks
        ]

    def _get_avatar(self, a: Dict[str, Any]) -> Dict[str, Any]:
        found: Optional[Dict[str, Any]] = None
        own = False
        if _str(a.get('avatar_id')):
            avatar_id = _str(a.get('avatar_id'))
            mine = self._client.list_avatars()
            owner = mine.get('owner') if isinstance(mine.get('owner'), dict) else {}
            match = next(
                (x for x in mine.get('avatars') or [] if isinstance(x, dict) and x.get('avatarId') == avatar_id), None
            )
            if match:
                found, own = self._shape_avatar(match, own=True, owner=owner), True
                found['personality'] = match.get('personalityPrompt')
            else:
                match = next((x for x in self._client.list_public_avatars() if x.get('avatarId') == avatar_id), None)
                if match:
                    found = self._shape_avatar(match, own=False, owner={})
                    found['personality'] = match.get('personalityPrompt')
        else:
            user = (_str(a.get('handle')) or _str(a.get('twitch_name'))).lstrip('@')
            result = self._client.lookup(user)
            avatars = [x for x in (result.get('avatars') or []) if isinstance(x, dict)] if result.get('found') else []
            match = next((x for x in avatars if x.get('isDefaultAvatar')), avatars[0] if avatars else None)
            if match:
                found = self._shape_avatar(match, own=False, owner=result.get('owner') or {})
                found['personality'] = match.get('personalityPrompt')
        if not found:
            raise MaskyError('No Masky avatar matched. Check the id or handle with list_avatars.')
        found['own'] = own or found.get('own', False)
        found['looks'] = self._shape_looks(self._looks(found['avatar_id'], self._owners.get(found['avatar_id'])))
        return found

    def _create_avatar(self, a: Dict[str, Any]) -> Dict[str, Any]:
        body: Dict[str, Any] = {'displayName': _str(a['name']), 'imageUrl': _str(a['image_url'])}
        if _str(a.get('personality')):
            body['personalityPrompt'] = _str(a['personality'])
        if _str(a.get('voice_id')):
            body['voiceId'] = _str(a['voice_id'])
        if a.get('knowledge_urls'):
            body['knowledgeBaseUrls'] = [u.strip() for u in a['knowledge_urls']]
        if a.get('public') is not None:
            body['publiclyRenderable'] = require_bool(a, 'public')
        result = self._client.create_avatar(body)
        avatar = result.get('avatar') if isinstance(result, dict) and isinstance(result.get('avatar'), dict) else {}
        return {
            'avatar_id': avatar.get('avatarId'),
            'name': avatar.get('displayName') or body['displayName'],
            'voice_id': avatar.get('voiceId'),
            'public': bool(avatar.get('publiclyRenderable', body.get('publiclyRenderable', False))),
        }

    def _rename_avatar(self, a: Dict[str, Any]) -> Dict[str, Any]:
        avatar_id, name = _str(a['avatar_id']), _str(a['name'])
        try:
            result = self._client.rename_avatar(avatar_id, name)
        except MaskyError as e:
            if e.status == 403 and 'lock' in str(e).lower():
                raise MaskyError(NAME_LOCKED_MESSAGE, status=403) from None
            raise
        avatar = (
            result.get('avatar')
            if isinstance(result, dict) and isinstance(result.get('avatar'), dict)
            else (result if isinstance(result, dict) else {})
        )
        return {'avatar_id': avatar.get('avatarId') or avatar_id, 'name': avatar.get('displayName') or name}

    def _set_avatar_public(self, a: Dict[str, Any]) -> Dict[str, Any]:
        public = require_bool(a, 'public')
        self._client.set_avatar_public(_str(a['avatar_id']), public)
        return {'avatar_id': _str(a['avatar_id']), 'public': public}

    def _train_avatar(self, a: Dict[str, Any]) -> Dict[str, Any]:
        self._client.train_avatar(_str(a['avatar_id']))
        return {
            'avatar_id': _str(a['avatar_id']),
            'status': 'requested',
            'note': 'Masky reports only "trained or queued"; progress cannot be polled.',
        }

    def _shape_identity(self, identity: Any) -> Optional[Dict[str, Any]]:  # noqa: ANN401
        if not isinstance(identity, dict):
            return None
        image = _str_or_none(identity.get('imageUrl'))
        return {
            'avatar_id': identity.get('avatarId'),
            'look_id': self._look_id_of(_str_or_none(identity.get('avatarId')), image),
            'display_name': identity.get('displayName'),
            'voice_id': identity.get('voiceId'),
            'updated_at': identity.get('updatedAt'),
            **self._url_field(image),
        }

    def _get_stream_identity(self, a: Dict[str, Any]) -> Dict[str, Any]:
        return {'stream_identity': self._shape_identity(self._client.get_stream_identity().get('streamIdentity'))}

    def _set_stream_identity(self, a: Dict[str, Any]) -> Dict[str, Any]:
        if optional_bool(a, 'clear', default=False):
            result = self._client.set_stream_identity(None)
            return {'stream_identity': self._shape_identity(result.get('streamIdentity'))}
        avatar_id = _str(a['avatar_id'])
        image = self._look_url(avatar_id, a, use_default=False)
        result = self._client.set_stream_identity(avatar_id, image)
        return {'stream_identity': self._shape_identity(result.get('streamIdentity'))}

    def _list_voices(self, a: Dict[str, Any]) -> Dict[str, Any]:
        query = _str(a.get('query')).lower()
        include_custom = optional_bool(a, 'include_custom', default=True)
        voices = []
        for v in self._client.list_voices():
            voice_id = _str_or_none(v.get('id')) or _str_or_none(v.get('voiceId'))
            if not voice_id:
                continue
            name = _str_or_none(v.get('name')) or voice_id
            kind = 'custom' if v.get('source') == 'custom' else 'preset'
            if (kind == 'custom' and not include_custom) or (query and query not in name.lower()):
                continue
            voices.append({'voice_id': voice_id, 'name': name, 'kind': kind})
        return {'voices': voices, 'count': len(voices)}

    def _set_avatar_voice(self, a: Dict[str, Any]) -> Dict[str, Any]:
        self._client.set_avatar_voice(_str(a['avatar_id']), _str(a['voice_id']))
        return {'ok': True, 'avatar_id': _str(a['avatar_id']), 'voice_id': _str(a['voice_id'])}

    def _list_looks(self, a: Dict[str, Any]) -> Dict[str, Any]:
        avatar_id, owner = self._resolve_avatar(a)
        looks = self._shape_looks(self._looks(avatar_id, owner))
        return {'avatar_id': avatar_id, 'looks': looks, 'count': len(looks)}

    def _add_look(self, a: Dict[str, Any]) -> Dict[str, Any]:
        result = self._client.add_image(_str(a['avatar_id']), _str(a['image_url']))
        url = _str_or_none(result.get('url'))
        return {
            'avatar_id': _str(a['avatar_id']),
            'look_id': look_id_for(url or '', result.get('assetId')),
            **self._url_field(url),
        }

    # ------------------------------------------------------------------
    # Renders
    # ------------------------------------------------------------------

    def _speak(self, a: Dict[str, Any]) -> Dict[str, Any]:
        receipt = self.speak_job(
            text=_str(a['text']),
            output=_str(a.get('output')) or 'video',
            avatar=_str(a.get('avatar_id')),
            look=_str(a.get('look_url')) or _str(a.get('look_id')),
            language=_str(a.get('language')),
            text_mode=_str(a.get('text_mode')),
            wait=optional_bool(a, 'wait_for_completion', default=False),
        )
        return self._finish(receipt)

    def speak_job(
        self,
        *,
        text: str,
        output: str,
        avatar: str = '',
        look: str = '',
        language: str = '',
        text_mode: str = '',
        wait: bool,
    ) -> Dict[str, Any]:
        """Estimate, guard, submit and optionally wait for a speak render. Returns the full receipt (URLs kept)."""
        text_mode = text_mode or TOOL_DEFAULTS['text_mode']
        estimate = estimate_speak(text, output, text_mode)
        check_budget(estimate, self._settings.get('max_credits_per_call', 1.0))

        avatar_id, owner = self._resolve_avatar({'avatar_id': avatar})
        if not avatar_id:
            raise MaskyError('No avatar to speak with. Set a Default Avatar on the node or pass avatar_id.')
        body: Dict[str, Any] = {
            'text': text,
            'output': output,
            'textMode': text_mode,
            'language': language or self._settings.get('language', 'en'),
        }
        look_arg = {'look_url': look} if _is_http(look) else {'look_id': look}
        look_url = self._look_url(avatar_id, look_arg, owner)
        if look_url:
            body['avatarImageUrl'] = look_url
        if owner:
            body['avatarOwnerUserId'] = owner

        started = time.monotonic()
        status_code, result = self._paid(estimate, lambda: self._client.speak(avatar_id, body))
        raw_id = str(result.get('generationId') or (result.get('generation') or {}).get('generationId') or '')
        _remember(self._jobs, f'speak:{raw_id}', {'output': output, 'estimate': estimate, 'started': started})

        inline = status_code == 200 and not result.get('async')
        if not inline and wait:
            result, finished, poll_error = self._wait_after_paid(
                lambda: self._client.get_speak(raw_id),
                lambda b: speak_status(b.get('generation') or b, output) in ('done', 'failed'),
                result,
                f'job {encode_job_id("speak", raw_id)}',
            )
            receipt = speak_receipt(result, output=output, estimate=estimate, elapsed_sec=time.monotonic() - started)
            if poll_error:
                self._poll_failed(receipt, f'job {receipt["generation_id"]}', poll_error)
            elif not finished:
                timeout_warning(receipt, self._settings.get('timeout_sec', 300))
        else:
            receipt = speak_receipt(result, output=output, estimate=estimate, elapsed_sec=time.monotonic() - started)
            if not inline:
                receipt['status'] = 'queued'
        return receipt

    def _video_params(self, a: Dict[str, Any]) -> Tuple[str, bool]:
        resolution = _str(a.get('resolution')) or TOOL_DEFAULTS['resolution']
        draft = optional_bool(a, 'draft', default=TOOL_DEFAULTS['draft'])
        return resolution, draft

    def _generate_video(self, a: Dict[str, Any]) -> Dict[str, Any]:
        resolution, draft = self._video_params(a)
        receipt = self.video_job(
            prompt=_str(a['prompt']),
            resolution=resolution,
            draft=draft,
            duration_sec=a.get('duration_sec'),
            fps=a.get('fps'),
            aspect_ratio=_str(a.get('aspect_ratio')),
            seed=a.get('seed'),
            silent=optional_bool(a, 'silent'),
            expand_prompt=optional_bool(a, 'expand_prompt'),
            share=_str(a.get('share')),
            image_url=_str(a.get('image_url')),
            look=_str(a.get('look_url')) or _str(a.get('look_id')),
            avatar=_str(a.get('avatar_id')),
            speech_text=_str(a.get('speech_text')),
            audio_url=_str(a.get('audio_url')),
            last_frame_image=_str(a.get('last_frame_image_url')),
            wait=optional_bool(a, 'wait_for_completion', default=False),
        )
        return self._finish(receipt)

    def video_job(
        self,
        *,
        prompt: str,
        resolution: str,
        draft: bool,
        duration_sec: Optional[int] = None,
        fps: Optional[int] = None,
        aspect_ratio: str = '',
        seed: Optional[int] = None,
        silent: Optional[bool] = None,
        expand_prompt: Optional[bool] = None,
        share: str = '',
        image_url: str = '',
        look: str = '',
        avatar: str = '',
        speech_text: str = '',
        audio_url: str = '',
        last_frame_image: str = '',
        wait: bool,
    ) -> Dict[str, Any]:
        """Estimate, guard, submit and optionally wait for a scene video. Returns the full receipt (URLs kept)."""
        duration = duration_sec or TOOL_DEFAULTS['duration_sec']
        estimate = estimate_video(
            resolution=resolution,
            draft=draft,
            duration_sec=duration,
            speech_text=speech_text,
            audio_url=audio_url,
            live_rates=self.load_pricing(),
        )
        check_budget(estimate, self._settings.get('max_credits_per_call', 1.0))

        body: Dict[str, Any] = {
            'prompt': prompt,
            'resolution': resolution,
            'draft': draft,
            'fps': fps or TOOL_DEFAULTS['fps'],
            'aspectRatio': aspect_ratio or TOOL_DEFAULTS['aspect_ratio'],
            'saveAudio': not (TOOL_DEFAULTS['silent'] if silent is None else silent),
            'promptUpsampling': TOOL_DEFAULTS['expand_prompt'] if expand_prompt is None else expand_prompt,
            'visibility': share or TOOL_DEFAULTS['share'],
        }
        if seed is not None:
            body['seed'] = seed
        if avatar or speech_text or look:
            avatar_id, owner = self._resolve_avatar({'avatar_id': avatar})
            if not avatar_id:
                raise MaskyError(
                    'A speech line or look needs an avatar. Set a Default Avatar on the node or pass avatar_id.'
                )
            body['avatarId'] = avatar_id
            if look:
                body['image'] = self._look_url(
                    avatar_id, {'look_url': look} if _is_http(look) else {'look_id': look}, owner, use_default=False
                )
        if image_url:
            body['image'] = image_url
        if last_frame_image:
            body['lastFrameImage'] = last_frame_image
        if speech_text:
            body['speechText'] = speech_text
        elif audio_url:
            body['audio'] = audio_url
        else:
            body['duration'] = duration

        started = time.monotonic()
        result = self._paid(estimate, lambda: self._client.generate_video(body))
        raw_id = str(result.get('generationId') or '')
        _remember(self._jobs, f'video:{raw_id}', {'estimate': estimate, 'started': started})
        if wait:
            result, finished, poll_error = self._wait_after_paid(
                lambda: self._client.get_video(raw_id),
                lambda b: (b.get('status') or '').lower() in ('ready', 'error'),
                result,
                f'job {encode_job_id("video", raw_id)}',
            )
            receipt = video_receipt(result, estimate=estimate, elapsed_sec=time.monotonic() - started)
            if poll_error:
                self._poll_failed(receipt, f'job {receipt["generation_id"]}', poll_error)
            elif not finished:
                timeout_warning(receipt, self._settings.get('timeout_sec', 300))
        else:
            receipt = video_receipt(result, estimate=estimate, elapsed_sec=time.monotonic() - started)
        return receipt

    def image_job(
        self,
        *,
        prompt: str,
        source_url: str = '',
        source_urls: Optional[List[str]] = None,
        engine: str = '',
        aspect_ratio: str = '',
    ) -> Dict[str, Any]:
        """Estimate, guard and run a generate (no sources) or an edit of one to five images. Returns the full receipt (URLs kept)."""
        sources = list(source_urls or ([source_url] if source_url else []))
        edit = bool(sources)
        engine = engine or TOOL_DEFAULTS['edit_engine' if edit else 'engine']
        if edit and engine == 'qwen' and len(sources) > MAX_QWEN_IMAGES:
            raise ValueError(
                f'The qwen edit engine takes at most {MAX_QWEN_IMAGES} images; got {len(sources)}. Use engine=default for up to {MAX_EDIT_IMAGES}.'
            )
        body: Dict[str, Any] = {'prompt': prompt, 'model': engine}
        if len(sources) == 1:
            body['imageUrl'] = sources[0]
        elif sources:
            body['images'] = sources
        if aspect_ratio:
            body['aspectRatio'] = aspect_ratio
        estimate = estimate_image(edit=edit, engine=engine)
        check_budget(estimate, self._settings.get('max_credits_per_call', 1.0))
        started = time.monotonic()
        call = (lambda: self._client.edit_image(body)) if edit else (lambda: self._client.generate_image(body))
        result = self._paid(estimate, call)
        receipt = image_receipt(result, estimate=estimate, elapsed_sec=time.monotonic() - started)
        _remember(self._images, receipt['generation_id'], dict(receipt, media=dict(receipt['media'])))
        return receipt

    def _generate_image(self, a: Dict[str, Any]) -> Dict[str, Any]:
        return self._finish(
            self.image_job(
                prompt=_str(a['prompt']), engine=_str(a.get('engine')), aspect_ratio=_str(a.get('aspect_ratio'))
            )
        )

    def _edit_image(self, a: Dict[str, Any]) -> Dict[str, Any]:
        return self._finish(
            self.image_job(
                prompt=_str(a['prompt']),
                source_urls=_edit_sources(a),
                engine=_str(a.get('engine')),
                aspect_ratio=_str(a.get('aspect_ratio')),
            )
        )

    def _get_generation(self, a: Dict[str, Any]) -> Dict[str, Any]:
        kind, raw_id = decode_job_id(a['generation_id'], _str(a.get('kind')) or None)
        job = self._jobs.get(f'{kind}:{raw_id}', {})
        estimate = job.get('estimate') or {}
        started = job.get('started')
        wait = optional_bool(a, 'wait_for_completion', default=False)

        if kind == 'image':
            cached = self._images.get(f'image:{raw_id}')
            if not cached:
                raise MaskyError(
                    'Image results are returned immediately and cannot be looked up later; this image id is not from the current run.'
                )
            return self._finish(dict(cached, media=dict(cached['media'])))

        if kind == 'speak':

            def fetch() -> Any:  # noqa: ANN401
                return self._client.get_speak(raw_id)

            def output_of(b: Dict[str, Any]) -> str:
                return job.get('output') or (b.get('generation') or b).get('output') or 'audio'

            def done(b: Dict[str, Any]) -> bool:
                return speak_status(b.get('generation') or b, output_of(b)) in ('done', 'failed')

            result, finished = self._wait(fetch, done) if wait else (fetch(), True)
            gen = result.get('generation') or result
            if started is None and gen.get('createdAt') and gen.get('updatedAt'):
                elapsed = (gen['updatedAt'] - gen['createdAt']) / 1000
            else:
                elapsed = time.monotonic() - started if started else 0.0
            receipt = speak_receipt(result, output=output_of(result), estimate=estimate, elapsed_sec=elapsed)
        else:
            result, finished = (
                self._wait(
                    lambda: self._client.get_video(raw_id),
                    lambda b: (b.get('status') or '').lower() in ('ready', 'error'),
                )
                if wait
                else (self._client.get_video(raw_id), True)
            )
            receipt = video_receipt(
                result, estimate=estimate, elapsed_sec=time.monotonic() - started if started else 0.0
            )
        if wait and not finished:
            timeout_warning(receipt, self._settings.get('timeout_sec', 300))
        return self._finish(receipt)

    def _estimate_cost(self, a: Dict[str, Any]) -> Dict[str, Any]:
        kind = a['kind']
        if kind == 'speak':
            est = estimate_speak(
                _str(a['text']),
                _str(a.get('output')) or 'video',
                _str(a.get('text_mode')) or TOOL_DEFAULTS['text_mode'],
            )
        elif kind == 'video':
            resolution, draft = self._video_params(a)
            est = estimate_video(
                resolution=resolution,
                draft=draft,
                duration_sec=a.get('duration_sec') or TOOL_DEFAULTS['duration_sec'],
                speech_text=_str(a.get('speech_text')),
                audio_url=_str(a.get('audio_url')),
                live_rates=self.load_pricing(),
            )
        elif kind == 'image':
            edit = bool(_str(a.get('image_url')))
            engine = _str(a.get('engine')) or TOOL_DEFAULTS['edit_engine' if edit else 'engine']
            est = estimate_image(edit=edit, engine=engine)
        else:
            est = estimate_turn(
                _str(a['text']),
                mode=_str(a.get('mode')) or 'chat',
                output=_str(a.get('output')) or 'audio',
                reinterpret=optional_bool(a, 'reinterpret', default=False),
            )
        cap = self._settings.get('max_credits_per_call', 1.0)
        return {
            'kind': kind,
            'estimated_credits': est['credits'],
            'basis': est['basis'],
            'price_table_date': est['price_table_date'],
            'verified': est['verified'],
            'cap': cap,
            'within_cap': not cap or est['credits'] <= cap,
        }

    # ------------------------------------------------------------------
    # Live conversations
    # ------------------------------------------------------------------

    def _create_conversation(self, a: Dict[str, Any]) -> Dict[str, Any]:
        shaped = self.conversation_job(
            avatar=_str(a.get('avatar_id')), look=_str(a.get('look_url')) or _str(a.get('look_id'))
        )
        if not self._include_media_urls:
            shaped.pop('live_url', None)
        return shaped

    def conversation_job(self, *, avatar: str = '', look: str = '') -> Dict[str, Any]:
        """Create a live conversation (free). Returns slug, id, share_url and live_url."""
        avatar_id, owner = self._resolve_avatar({'avatar_id': avatar})
        if not avatar_id:
            raise MaskyError('A live conversation needs an avatar. Set a Default Avatar on the node or pass avatar_id.')
        owner = owner or self._owner_of(avatar_id)
        look_arg = {'look_url': look} if _is_http(look) else {'look_id': look}
        look_url = self._look_url(avatar_id, look_arg, owner)
        result = self._client.create_conversation(owner, avatar_id)
        slug, conversation_id = result.get('shareSlug'), result.get('conversationId')
        self._conversations[slug] = {
            'conversation_id': conversation_id,
            'avatar_id': avatar_id,
            'owner': owner,
            'share_url': result.get('shareUrl'),
            'live_url': result.get('liveUrl'),
        }
        if look_url:
            self._client.set_conversation_image(conversation_id, look_url)
        return {
            'conversation_slug': slug,
            'conversation_id': conversation_id,
            'share_url': result.get('shareUrl'),
            'live_url': result.get('liveUrl'),
        }

    def live_conversation(self, slug: str = '') -> Dict[str, Any]:
        """The pipeline's conversation: the configured slug, or one created on first use and reused for the run."""
        with self._lock:
            if self._pipeline_conversation is None:
                if slug:
                    conversation_id, slug, info = self._conversation({'slug': slug})
                    self._pipeline_conversation = {
                        'conversation_slug': slug,
                        'conversation_id': conversation_id,
                        'share_url': info.get('share_url'),
                        'live_url': info.get('live_url'),
                    }
                else:
                    self._pipeline_conversation = self.conversation_job(look=self._settings.get('default_look', ''))
            return dict(self._pipeline_conversation)

    def _set_conversation_visibility(self, a: Dict[str, Any]) -> Dict[str, Any]:
        public = require_bool(a, 'public')
        conversation_id, slug, _ = self._conversation(a)
        self._client.set_conversation_visibility(conversation_id, public)
        return {'conversation_slug': slug, 'conversation_id': conversation_id, 'public': public}

    def _conversation(self, a: Dict[str, Any]) -> Tuple[str, Optional[str], Dict[str, Any]]:
        """Return (conversation_id, slug, cached info) for a slug or id argument."""
        slug = _str_or_none(a.get('slug'))
        conversation_id = _str_or_none(a.get('conversation_id'))
        if conversation_id:
            known = next(
                ((s, v) for s, v in list(self._conversations.items()) if v.get('conversation_id') == conversation_id),
                (None, {}),
            )
            return conversation_id, slug or known[0], known[1]
        if slug in self._conversations:
            return self._conversations[slug]['conversation_id'], slug, self._conversations[slug]
        body = self._client.get_conversation(slug)
        nested = body.get('conversation') if isinstance(body.get('conversation'), dict) else {}
        conversation_id = (
            _str_or_none(body.get('conversationId'))
            or _str_or_none(body.get('id'))
            or _str_or_none(nested.get('conversationId'))
            or _str_or_none(nested.get('id'))
        )
        if not conversation_id:
            raise MaskyError(f'Masky did not return an id for conversation {slug}. Pass conversation_id instead.')
        info = {
            'conversation_id': conversation_id,
            'avatar_id': body.get('avatarId') or nested.get('avatarId'),
            'share_url': body.get('shareUrl') or nested.get('shareUrl'),
            'live_url': body.get('liveUrl') or nested.get('liveUrl'),
        }
        self._conversations[slug] = info
        return conversation_id, slug, info

    @staticmethod
    def _turns_of(body: Dict[str, Any]) -> List[Dict[str, Any]]:
        turns = body.get('turns')
        if turns is None and isinstance(body.get('conversation'), dict):
            turns = body['conversation'].get('turns')
        return [t for t in (turns or []) if isinstance(t, dict)]

    def _turn_status(self, turn: Dict[str, Any], output: str) -> str:
        status = (turn.get('status') or 'pending').lower()
        if status in ('video', 'ready') or (status == 'audio' and output == 'audio'):
            return 'done'
        if status == 'error':
            return 'done' if (output == 'audio' and turn.get('audioUrl')) else 'failed'
        return 'running'

    def _shape_turn(
        self, turn: Dict[str, Any], output: Optional[str] = None, include_urls: Optional[bool] = None
    ) -> Dict[str, Any]:
        output = output or turn.get('output') or 'audio'
        url = turn.get('videoUrl') if output == 'video' and turn.get('videoUrl') else turn.get('audioUrl')
        media: Dict[str, Any] = {'mime': 'video/mp4' if (output == 'video' and turn.get('videoUrl')) else 'audio/mpeg'}
        if (self._include_media_urls if include_urls is None else include_urls) and url:
            media['url'] = url
            expires = url_expires_at(url)
            if expires:
                media['url_expires_at'] = expires
        return {
            'turn_id': turn.get('id'),
            'role': turn.get('role'),
            'status': self._turn_status(turn, output),
            'user_text': turn.get('userText'),
            'avatar_text': turn.get('avatarText'),
            'media': media,
            'share_url': turn.get('shareUrl'),
            'created_at': turn.get('createdAt'),
            # Masky's turn record shows creditCost 0 even after the turn is charged (a Masky
            # bug); the real charge is only in the account's credit ledger. Never pass on a 0.
            'credits_charged': turn.get('creditCost') or None,
        }

    def _send_turn(self, a: Dict[str, Any]) -> Dict[str, Any]:
        # The cost guard runs before any request, including the slug lookup.
        mode, output = _str(a.get('mode')) or 'chat', _str(a.get('output')) or 'audio'
        reinterpret = optional_bool(a, 'reinterpret', default=False)
        check_budget(
            estimate_turn(_str(a['text']), mode=mode, output=output, reinterpret=reinterpret),
            self._settings.get('max_credits_per_call', 1.0),
        )
        conversation_id, slug, _ = self._conversation(a)
        return self.turn_job(
            conversation_id=conversation_id,
            slug=slug,
            text=_str(a['text']),
            mode=mode,
            output=output,
            wait=optional_bool(a, 'wait_for_agent', default=False),
            include_urls=self._include_media_urls,
            reinterpret=reinterpret,
        )

    def turn_job(
        self,
        *,
        conversation_id: str,
        slug: Optional[str],
        text: str,
        mode: str,
        output: str,
        wait: bool,
        include_urls: bool = True,
        reinterpret: bool = False,
    ) -> Dict[str, Any]:
        """Estimate, guard and send one live turn; optionally wait for it to render."""
        estimate = estimate_turn(text, mode=mode, output=output, reinterpret=reinterpret)
        check_budget(estimate, self._settings.get('max_credits_per_call', 1.0))
        body: Dict[str, Any] = {'userText': text, 'mode': mode, 'output': output}
        if reinterpret and mode == 'speak':
            body['reinterpret'] = True
        result = self._paid(estimate, lambda: self._client.send_turn(conversation_id, body))
        turn = result.get('turn') if isinstance(result.get('turn'), dict) else {}
        shaped: Dict[str, Any]
        if wait and slug and turn.get('id'):

            def fetch() -> Any:  # noqa: ANN401
                return next(
                    (x for x in self._turns_of(self._client.get_conversation(slug)) if x.get('id') == turn['id']), turn
                )

            turn, finished, poll_error = self._wait_after_paid(
                fetch, lambda x: self._turn_status(x, output) in ('done', 'failed'), turn, f'turn {turn["id"]}'
            )
            shaped = self._shape_turn(turn, output, include_urls)
            if poll_error:
                # Sent, but its progress could not be read: report it like a turn that cannot be polled.
                shaped['unconfirmed'] = True
                shaped['poll_error'] = poll_error
                shaped['warnings'] = [
                    f'Could not check on turn {turn.get("id")} after Masky accepted it ({poll_error}). '
                    'Check it later with get_turns instead of sending it again.'
                ]
            elif not finished:
                shaped['warnings'] = [
                    f'Still rendering after {self._settings.get("timeout_sec", 300):g} s (turn {turn.get("id")}). Check again with get_turns.'
                ]
        else:
            shaped = self._shape_turn(turn, output, include_urls)
            if wait:
                # Sent, but the node could not poll it: callers must not treat this as a timeout.
                shaped['unconfirmed'] = True
            if wait and not slug:
                shaped['warnings'] = [
                    'Not waited for: pass the conversation slug (not only conversation_id) so the node can poll the turn. Check it later with get_turns.'
                ]
            elif wait:
                shaped['warnings'] = [
                    'Not waited for: Masky did not return a turn id to poll. Check the conversation with get_turns.'
                ]
        shaped['estimated_credits'] = estimate['credits']
        shaped['conversation_slug'] = slug
        return shaped

    def _get_turns(self, a: Dict[str, Any]) -> Dict[str, Any]:
        slug = _str(a['slug'])
        turns = sorted(self._turns_of(self._client.get_conversation(slug)), key=lambda t: t.get('createdAt') or 0)
        since = a.get('since')
        if isinstance(since, str) and since.strip().isdigit():
            since = int(since.strip())
        if isinstance(since, int):
            turns = [t for t in turns if (t.get('createdAt') or 0) > since]
        elif isinstance(since, str) and since.strip():
            ids = [t.get('id') for t in turns]
            turns = turns[ids.index(since.strip()) + 1 :] if since.strip() in ids else turns
        limit = a.get('limit') or 20
        shaped = [self._shape_turn(t) for t in turns[-limit:]]
        return {'conversation_slug': slug, 'turns': shaped, 'count': len(shaped)}

    def _set_conversation_look(self, a: Dict[str, Any]) -> Dict[str, Any]:
        conversation_id, _, info = self._conversation(a)
        avatar_id = _str(a.get('avatar_id')) or info.get('avatar_id') or self._settings.get('default_avatar') or ''
        if not avatar_id:
            raise MaskyError('Could not tell which avatar this conversation uses. Pass avatar_id.')
        if avatar_id.startswith('@'):
            avatar_id, _ = self._resolve_avatar({'avatar_id': avatar_id})
        url = self._look_url(avatar_id, a, info.get('owner'), use_default=False)
        self._client.set_conversation_image(conversation_id, url)
        return {'ok': True, 'look_id': self._look_id_of(avatar_id, url, info.get('owner'))}

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    def _delete_conversation(self, a: Dict[str, Any]) -> Dict[str, Any]:
        conversation_id = _str(a['conversation_id'])
        self._client.delete_conversation(conversation_id)
        # Forget the deleted conversation so a later call never reuses it.
        with self._lock:
            for slug in [
                s for s, info in self._conversations.items() if info.get('conversation_id') == conversation_id
            ]:
                self._conversations.pop(slug, None)
            if self._pipeline_conversation and self._pipeline_conversation.get('conversation_id') == conversation_id:
                self._pipeline_conversation = None
        return {'conversation_id': conversation_id, 'deleted': True}

    def _delete_turn(self, a: Dict[str, Any]) -> Dict[str, Any]:
        conversation_id, turn_id = _str(a['conversation_id']), _str(a['turn_id'])
        self._client.delete_turn(conversation_id, turn_id)
        return {'conversation_id': conversation_id, 'turn_id': turn_id, 'deleted': True, 'restorable': True}

    def _restore_turn(self, a: Dict[str, Any]) -> Dict[str, Any]:
        conversation_id, turn_id = _str(a['conversation_id']), _str(a['turn_id'])
        self._client.restore_turn(conversation_id, turn_id)
        return {'conversation_id': conversation_id, 'turn_id': turn_id, 'restored': True}

    # ------------------------------------------------------------------
    # Agent binding
    # ------------------------------------------------------------------

    def _bind_agent(self, a: Dict[str, Any]) -> Dict[str, Any]:
        body: Dict[str, Any] = {'pubkey': _str(a['pubkey']), 'relay': _str(a['relay'])}
        if a.get('timeout_sec') is not None:
            body['timeoutSec'] = a['timeout_sec']
        if _str(a.get('fallback')):
            body['fallback'] = _str(a['fallback'])
        if a.get('enabled') is not None:
            body['enabled'] = a['enabled']
        if a.get('kind') is not None:
            body['kind'] = a['kind']
        if a.get('extra_tags'):
            body['extraTags'] = a['extra_tags']
        result = self._client.put_binding(_str(a['avatar_id']), body)
        return {'avatar_id': result.get('avatarId', _str(a['avatar_id'])), 'agent_binding': result.get('agentBinding')}

    def _get_binding(self, a: Dict[str, Any]) -> Dict[str, Any]:
        result = self._client.get_binding(_str(a['avatar_id']))
        return {'avatar_id': result.get('avatarId', _str(a['avatar_id'])), 'agent_binding': result.get('agentBinding')}

    def _unbind_agent(self, a: Dict[str, Any]) -> Dict[str, Any]:
        result = self._client.delete_binding(_str(a['avatar_id']))
        return {'avatar_id': result.get('avatarId', _str(a['avatar_id'])), 'agent_binding': result.get('agentBinding')}
