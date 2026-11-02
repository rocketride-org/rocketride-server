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
Masky node instance.

As a tool, ``invoke`` hands the call to the ``MaskyDriver`` created by
``IGlobal``. As a pipeline step, each text record runs the configured action:
the node renders it, waits, downloads the finished file, streams it on the
matching media lane with its byte count declared on BEGIN, and writes a JSON
receipt on ``text``. Downloading keeps the output once Masky's signed URL
expires.
"""

from __future__ import annotations

import json
from typing import Any, Dict

from rocketlib import IInstanceBase, warning

from .IGlobal import IGlobal
from .masky_core import LIMITS, MaskyError, check_budget, estimate_turn, media_details, speech_over_limit, split_turns

_EXTENSIONS = {
    'audio/mpeg': 'mp3',
    'video/mp4': 'mp4',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
}


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def invoke(self, param: Any) -> Any:  # noqa: ANN401
        driver = getattr(self.IGlobal, 'driver', None)
        if driver is None:
            raise RuntimeError(
                'tool_masky: driver not initialized. Set the API key on the node or in ROCKETRIDE_MASKY_KEY'
            )
        return driver.handle_invoke(param)

    # ------------------------------------------------------------------
    # Lanes in
    # ------------------------------------------------------------------

    def writeQuestions(self, question: Any) -> None:  # noqa: ANN401
        text = ' '.join(q.text for q in question.questions) if question.questions else ''
        self.writeText(text)

    def writeAnswers(self, answer: Any) -> None:  # noqa: ANN401
        text = answer.getText() if hasattr(answer, 'getText') else str(answer)
        self.writeText(text)

    def writeText(self, text: str) -> None:
        value = (text or '').strip()
        if value:
            settings = getattr(self.IGlobal, 'settings', None) or {}
            if settings.get('action') == 'live':
                self._live(value)
            else:
                self._deliver(self._render(value))
        # The text lane carries receipts, never the incoming text.
        self.preventDefault()

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def _render(self, text: str) -> Dict[str, Any]:
        driver = getattr(self.IGlobal, 'driver', None)
        settings = getattr(self.IGlobal, 'settings', None) or {}
        if driver is None:
            raise RuntimeError(
                'tool_masky: driver not initialized. Set the API key on the node or in ROCKETRIDE_MASKY_KEY'
            )
        action = settings.get('action', 'talking_head')

        if action == 'talking_head':
            over = speech_over_limit(text)
            if over:
                raise ValueError(over)
            return driver.speak_job(
                text=text,
                output=settings.get('output', 'video'),
                look=settings.get('default_look', ''),
                text_mode=settings.get('text_mode', 'literal'),
                wait=True,
            )

        if action == 'image':
            limit = LIMITS['image_prompt_chars']
            if len(text) > limit:
                raise ValueError(
                    f'Masky accepts {limit} characters per image prompt and this record has {len(text)}. '
                    'Shorten it upstream with a summarization node.'
                )
            source = settings.get('source_image_url', '')
            if source and not source.lower().startswith(('http://', 'https://')):
                raise ValueError(
                    'Source Image URL must be a public http(s) URL; Masky cannot read uploaded or local files.'
                )
            engine = settings.get('edit_engine', 'default') if source else settings.get('engine', 'default')
            return driver.image_job(prompt=text, source_url=source, engine=engine)

        if action == 'scene_video':
            limit = LIMITS['video_prompt_chars']
            if len(text) > limit:
                raise ValueError(
                    f'Masky accepts {limit} characters per scene-video prompt and this record has {len(text)}. '
                    'Shorten it upstream with a summarization node.'
                )
            source = settings.get('source_image_url', '')
            if source and not source.lower().startswith(('http://', 'https://')):
                raise ValueError(
                    'Source Image URL must be a public http(s) URL; Masky cannot read uploaded or local files.'
                )
            speech = settings.get('speech_line', '')
            if len(speech) > LIMITS['video_speech_chars']:
                raise ValueError(
                    f'Speech Line is {len(speech)} characters; Masky accepts {LIMITS["video_speech_chars"]}. Shorten it in the node settings.'
                )
            if settings.get('share') == 'public' and not settings.get('allow_public_sharing'):
                raise ValueError(
                    "Scene video with Share Page Public is gated by 'allowPublicSharing', which is off by default. "
                    "Enable 'allowPublicSharing' in the node config, or set Share Page to Private."
                )
            quality = settings.get('quality', '720p-draft')
            return driver.video_job(
                prompt=text,
                resolution=quality.split('-')[0],
                draft=quality.endswith('-draft'),
                duration_sec=settings.get('duration_sec'),
                fps=settings.get('fps'),
                aspect_ratio=settings.get('aspect_ratio', ''),
                seed=settings.get('seed'),
                silent=settings.get('silent'),
                expand_prompt=settings.get('expand_prompt'),
                share=settings.get('share', ''),
                image_url=settings.get('source_image_url', ''),
                speech_text=settings.get('speech_line', ''),
                wait=True,
            )

        raise MaskyError(f'Unknown pipeline action {action!r}.')

    def _live(self, text: str) -> None:
        """Send the record as one or more turns of a live conversation; write one receipt on text."""
        driver = self.IGlobal.driver
        settings = getattr(self.IGlobal, 'settings', None) or {}
        chunks = split_turns(text)
        mode, output = settings.get('turn_mode', 'chat'), settings.get('turn_output', 'audio')
        # The cap applies to the whole record: one long record must not slip past
        # it as many turns that are each under the cap.
        total = sum(estimate_turn(chunk, mode=mode, output=output)['credits'] for chunk in chunks)
        check_budget(
            {'credits': round(total, 3), 'basis': f'{len(chunks)} live turn(s) for this record'},
            settings.get('max_credits_per_call', 1.0),
        )
        conversation = driver.live_conversation(settings.get('conversation', ''))
        wait = bool(settings.get('wait_for_turn', True))
        turn_ids, statuses, estimated, charged, warnings = [], [], 0.0, None, []
        for index, chunk in enumerate(chunks, 1):
            try:
                turn = driver.turn_job(
                    conversation_id=conversation['conversation_id'],
                    slug=conversation['conversation_slug'],
                    text=chunk,
                    mode=mode,
                    output=output,
                    wait=wait,
                )
            except MaskyError as e:
                if not turn_ids:
                    raise
                sent = ', '.join(str(x) for x in turn_ids)
                # Keep the error's class (cancellation stays cancellation) and add what was already sent.
                error = type(e)(f'{e} Turns sent from this record before the failure: {sent}.')
                error.status, error.credit_detail = e.status, e.credit_detail
                raise error from None
            turn_ids.append(turn.get('turn_id'))
            statuses.append(turn.get('status'))
            estimated += turn.get('estimated_credits') or 0
            if turn.get('credits_charged') is not None:
                charged = (charged or 0.0) + turn['credits_charged']
            sent = ', '.join(str(x) for x in turn_ids)
            if turn.get('status') == 'failed':
                raise MaskyError(
                    f'Live turn {turn.get("turn_id")} failed in conversation {conversation["conversation_slug"]}. '
                    f'Turns sent from this record so far: {sent}.'
                )
            if turn.get('unconfirmed'):
                # The turn was sent (and may be charged) but could not be polled. Record it
                # as sent and carry on, so the rest of the record is not dropped.
                statuses[-1] = 'sent'
                reason = '; '.join(turn.get('warnings') or ['Masky gave no way to poll it'])
                label = turn.get('turn_id') or f'{index} of {len(chunks)}'
                warnings.append(f'Turn {label} was sent but could not be confirmed: {reason}')
                continue
            if wait and turn.get('status') != 'done':
                timeout = settings.get('timeout_sec', 300)
                raise MaskyError(
                    f'Still rendering after {timeout:g} s (turn {turn.get("turn_id")}). Turns sent from this record so far: {sent}. '
                    'Raise the Render Timeout or turn off Wait for Each Turn.'
                )
        receipt = {
            'conversation_slug': conversation['conversation_slug'],
            'share_url': conversation.get('share_url'),
            'live_url': conversation.get('live_url'),
            'turn_ids': turn_ids,
            'status': 'done' if wait and not warnings else 'sent',
            'turn_statuses': statuses,
            'estimated_credits': round(estimated, 3),
            'credits_charged': None if charged is None else round(charged, 4),
        }
        if charged is None:
            receipt['credits_note'] = (
                'Masky charges each rendered turn, but its turn record does not report the charge yet; '
                'see the credit ledger on masky.ai.'
            )
        if warnings:
            receipt['warnings'] = warnings
            for message in warnings:
                warning(f'Masky ({conversation["conversation_slug"]}): {message}')
        self.instance.writeText(json.dumps(receipt))

    def _deliver(self, receipt: Dict[str, Any]) -> None:
        job = receipt.get('generation_id')
        if receipt.get('poll_error'):
            raise MaskyError(
                f'Could not check on job {job} after Masky accepted it ({receipt["poll_error"]}). It may still render '
                'and be charged; check it with get_generation before sending the record again.'
            )
        if receipt.get('status') == 'failed':
            raise MaskyError(receipt.get('error') or f'Render failed (job {job}).')
        if receipt.get('status') != 'done':
            timeout = (getattr(self.IGlobal, 'settings', None) or {}).get('timeout_sec', 300)
            raise MaskyError(
                f'Still rendering after {timeout:g} s (job {job}). Raise the Render Timeout or check later with get_generation.'
            )
        for message in receipt.get('warnings') or []:
            warning(f'Masky ({job}): {message}')

        media = receipt.get('media') or {}
        url, mime = media.get('url'), media.get('mime', '')
        if not url:
            raise MaskyError(f'Masky finished job {job} but returned no media URL.')
        data = self.IGlobal.driver.download(url)
        details = media_details(mime, data)
        media.update(details)
        name = f'{str(job).replace(":", "-")}.{_EXTENSIONS.get(mime, "bin")}'

        from ai.common.avi.descriptor import forward_enriched_audio, forward_enriched_image, forward_enriched_video

        if mime.startswith('audio/'):
            forward_enriched_audio(
                self.instance, None, mime, data, duration=details.get('duration_sec'), format='mp3', name=name
            )
        elif mime.startswith('video/'):
            forward_enriched_video(
                self.instance,
                None,
                mime,
                data,
                duration=details.get('duration_sec'),
                width=details.get('width'),
                height=details.get('height'),
                name=name,
            )
        else:
            forward_enriched_image(
                self.instance,
                None,
                mime,
                data,
                width=details.get('width'),
                height=details.get('height'),
                origin='generated',
            )

        self.instance.writeText(json.dumps(receipt))
