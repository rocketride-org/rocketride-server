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


"""Typed media operation handlers."""

from __future__ import annotations
import shutil
import tempfile
import time
from pathlib import Path
from rocketlib import warning

try:
    from rocketlib.engine import monitorSSE
except Exception:  # noqa: BLE001
    monitorSSE = None

from . import plan as plan_lib
from .captions import build_ass, build_srt, build_vtt, seam_placement
from .render_lib import (
    SILENT_AUDIO_WARNING,
    TimelineMap,
    assemble_programme_audio,
    chapters_payload,
    concat_parts,
    conform_audio,
    encode_audio_deliverable,
    ffmetadata_chapters,
    layout_pieces,
    master_wav,
    measure_loudness,
    mux_programme,
    plan_programme_parts,
    probe,
    quality_block,
    render_asset_part,
    render_audio,
    render_card,
    render_clip_video,
    render_layout_part,
    render_layout_video,
    resize_layout,
    render_programme_audio,
    render_programme_part,
    shift_groups,
    slice_audio,
    source_colour_warning,
    thumbnail,
    thumbnail_at_ms,
    transcode_aspect,
)
from .report import build_render_report, finite
from ._support.workspace import local_copy
from ._support.workspace import download_to, write_file, write_json
from .IGlobal import IGlobal
from ._support.instance import MediaInstance

NODE = 'media_render'
SCHEMA_VERSION = 1
MODES = ('render',)


class IInstance(MediaInstance):
    """Render a validated, caller-supplied edit specification."""

    IGlobal: IGlobal
    node = NODE
    modes = MODES

    def _render(self, store) -> dict:
        cfg = self.IGlobal.config
        spec = plan_lib.validate_spec(self._spec)
        status_to = self._status_to(spec)
        mode = 'export' if str(spec.get('mode') or 'preview').lower() == 'export' else 'preview'
        media = spec.get('media') if isinstance(spec.get('media'), dict) else {}
        has_video = bool(media.get('has_video', True))

        keep = plan_lib.resolve_keep(spec)
        audio = plan_lib.normalize_audio(spec)
        outputs = plan_lib.normalize_outputs(spec, cfg, has_video)
        self._render_outputs = outputs
        plan_lib.validate_output_paths({**spec, 'status_to': status_to}, outputs, cfg)
        # the lines are timed on the clock of the file this render writes: a
        # `window` starts that clock at `offset_ms` and ends it `body_ms` later
        captions = plan_lib.caption_plan(
            spec, keep['full_keep'], offset_ms=keep['offset_ms'], body_ms=keep['body_ms'] if keep['window'] else None
        )
        # the plan is timed from its own zero; the keep list is timed from the
        # recording's. One of them has to move, and the spec says by how much.
        framing = plan_lib.shift_framing(plan_lib.framing_plan(spec), spec.get('framing_offset_ms'))
        pipeline = plan_lib.choose_pipeline(spec)
        # the identity of this render, reported as `spec_hash` — the browser and
        # the CLI name a plan by it. It selects nothing here: every render
        # renders.
        identity = plan_lib.spec_identity(spec)
        write_to = str(spec.get('write_to') or '').strip('/')
        if not write_to:
            raise ValueError('the spec has no write_to')

        context = {
            'cfg': cfg,
            'spec': spec,
            'mode': mode,
            'media': media,
            'has_video': has_video,
            'keep': keep,
            'audio': audio,
            'outputs': outputs,
            'captions': captions,
            'framing': framing,
            'reframes': plan_lib.reframes(framing),
            'spec_hash': identity,
            'framing_style': plan_lib.framing_style(framing),
            'write_to': write_to,
            'status_to': status_to,
            # a short piece gets a poster frame unless told otherwise; a
            # long programme does not
            'thumbnail': spec['thumbnail'] if 'thumbnail' in spec else (pipeline == 'clip'),
        }
        if pipeline == 'programme':
            return self._render_programme(store, context)
        return self._render_clip(store, context)

    def _render_clip(self, store, ctx: dict) -> dict:
        spec, keep_plan = ctx['spec'], ctx['keep']
        outputs, captions, framing = ctx['outputs'], ctx['captions'], ctx['framing']
        reframes = bool(ctx['reframes'])
        audio, mode, status_to = ctx['audio'], ctx['mode'], ctx['status_to']
        keep = keep_plan['keep']
        source_range = keep_plan['source_range'] or [min(s for s, _ in keep), max(e for _, e in keep)]
        start, end = int(source_range[0]), int(source_range[1])
        mutes = plan_lib.as_ranges(spec.get('mutes'))
        warnings_out: list[str] = list(spec.get('warnings') or [])

        self._status(
            store,
            status_to,
            'rendering',
            mode=mode,
            outputs=[o['key'] for o in outputs],
            reframe=[s.get('layout') for s in (framing or {}).get('segments') or []] if reframes else None,
        )
        # the copy is held as long as the render reads it, eviction included
        with local_copy(store, spec['source']) as local:
            source_info = self._probe_source(local, warnings_out)
            overlay = plan_lib.overlay_for(spec)
            overlay_path = self._local_asset(store, overlay, 'overlay', warnings_out) if overlay else None

            work = Path(tempfile.mkdtemp(prefix='media_render_render_'))
            files: dict[str, str] = {}
            try:
                # the audio is cut from the same source window the picture is, and
                # mastered in the layout it ships in (a mono master played as dual
                # mono is 3 LU louder than its own meter says)
                source_wav = slice_audio(
                    local,
                    start,
                    end,
                    work / 'source.wav',
                    has_audio=source_info.get('has_audio', True),
                )
                mastered = render_audio(
                    source_wav,
                    [(s - start, e - start) for s, e in keep],
                    work / 'mastered.wav',
                    mutes_ms=[(s - start, e - start) for s, e in mutes],
                    loudness_lufs=audio['loudness_lufs'],
                    true_peak=audio['true_peak'],
                    channels=audio['channels'],
                    denoise=audio['denoise'],
                    highpass=audio['highpass'],
                    compress=audio['compress'],
                    master=audio['master'],
                    warnings=warnings_out,
                )
                timeline = TimelineMap(keep)
                groups = captions['groups']

                # caption placement follows the framing plan on the RENDERED
                # timeline (a stacked segment puts the line on the seam)
                if reframes:
                    if any(p.get('fallback') for p in layout_pieces(keep, framing.get('segments') or [])):
                        warnings_out.append(
                            'The framing plan does not cover what was rendered; it was rendered full frame.'
                        )
                        warning(f'{NODE}: the framing plan does not cover the keep list')

                first_media = None
                first_picture = None  # the poster comes off a video deliverable, never an audio one
                applied = False
                for i, output in enumerate(outputs):
                    if not output['video']:
                        # an audio deliverable is the mastered programme itself
                        piece = slice_audio(mastered, 0, timeline.total_ms, self._output_path(work, output['file']))
                        files[output['key']] = write_file(store, f'{ctx["write_to"]}/{output["file"]}', piece)
                        first_media = first_media or piece
                        continue
                    shaped = (
                        resize_layout(framing, output['width'], output['height'])
                        if reframes and output['framing']
                        else None
                    )
                    placement = self._seam_placement(shaped, keep, output['height']) if shaped else None
                    ass_path = None
                    if output['captions'] and captions['enabled']:
                        # named by position: a key may be an aspect alias (`9:16`)
                        ass_path = work / f'captions_{i}.ass'
                        ass_path.write_text(
                            build_ass(
                                groups,
                                output['caption_layout'],
                                style=captions['style'],
                                speaker_colors=captions['speaker_colors']
                                if captions['style'].get('speaker_colors')
                                else None,
                                placement=placement if output['framing'] else None,
                            ),
                            encoding='utf-8',
                        )
                    self._status(store, status_to, 'encoding', mode=mode, layout=output['key'])
                    if shaped:
                        mp4 = render_layout_video(
                            local,
                            start,
                            end,
                            keep,
                            shaped,
                            mastered,
                            self._output_path(work, output['file']),
                            work,
                            ass_path=ass_path,
                            fps=output['fps'],
                            crf=output['crf'],
                            preset=output['preset'],
                            logo=overlay,
                            logo_path=overlay_path,
                            source=source_info,
                        )
                        applied = True
                    else:
                        layout = output['layout'] or ('vertical' if output['height'] >= output['width'] else 'wide')
                        if output['framing'] and ctx['framing_style'] == 'original':
                            layout = 'original'  # the caller asked for the recording's own picture
                        mp4 = render_clip_video(
                            local,
                            start,
                            end,
                            keep,
                            mastered,
                            self._output_path(work, output['file']),
                            layout=layout,
                            ass_path=ass_path,
                            fps=output['fps'],
                            crf=output['crf'],
                            preset=output['preset'],
                            logo=overlay,
                            logo_path=overlay_path,
                            width=output['width'],
                            height=output['height'],
                            source=source_info,
                        )
                    files[output['key']] = write_file(store, f'{ctx["write_to"]}/{output["file"]}', mp4)
                    first_media = first_media or mp4
                    first_picture = first_picture or mp4

                self._write_sidecars(store, ctx, groups, files, work, 0)
                measured_media = first_picture or first_media
                check = probe(measured_media)
                if first_picture is not None and ctx['thumbnail']:
                    # the poster comes off a finished video deliverable: square pixels already
                    files['thumbnail'] = self._write_thumbnail(
                        store,
                        ctx,
                        first_picture,
                        work,
                        min(1000, max(0, timeline.total_ms // 3)),
                        check,
                        warnings_out,
                    )

                loudness = measure_loudness(measured_media)
                self._note_silence(loudness, warnings_out)
            finally:
                shutil.rmtree(work, ignore_errors=True)

            primary = next((o for o in outputs if o['video']), outputs[0])
            report = self._report(
                ctx,
                check=check,
                loudness=loudness,
                measurements={primary['key']: loudness} if loudness else {},
                files=files,
                primary=primary,
                total_ms=timeline.total_ms,
                body_ms=timeline.total_ms,
                mastered=audio['master'],
                framing_applied=applied,
                mutes=len(mutes),
                bleeps=0,
                chapters=[],
                music=False,
                parts=[],
                warnings=warnings_out,
            )
            self._finish(store, ctx, report, files)
            return report

    def _render_programme(self, store, ctx: dict) -> dict:
        spec, cfg, keep_plan = ctx['spec'], ctx['cfg'], ctx['keep']
        outputs, captions, audio = ctx['outputs'], ctx['captions'], ctx['audio']
        mode, status_to, write_to = ctx['mode'], ctx['status_to'], ctx['write_to']
        keep, full_keep = keep_plan['keep'], keep_plan['full_keep']
        mutes = plan_lib.as_ranges(spec.get('mutes'))
        bleeps = plan_lib.as_ranges(spec.get('bleeps'))
        body_ms = keep_plan['body_ms']
        warnings_out: list[str] = list(spec.get('warnings') or [])
        groups = captions['groups']

        primary = next((o for o in outputs if o['video'] and not o['from']), None)
        if primary is None:
            primary = next((o for o in outputs if not o['from']), outputs[0])
        derived = [o for o in outputs if o is not primary]
        for output in derived:
            if output['video'] and not output['from']:
                warnings_out.append(
                    f'Programme output {output["key"]!r} is transcoded from {primary["key"]!r}; '
                    'its independent framing and captions are not applied. '
                    f'Set from to {primary["key"]!r} to request this derivative explicitly.'
                )
        out_w, out_h = primary['width'], primary['height']
        fps, crf, x264 = primary['fps'], primary['crf'], primary['preset']
        channels = audio['channels']
        has_video = bool(primary['video'])
        captions_on = bool(primary['captions'] and captions['enabled'])

        work = Path(tempfile.mkdtemp(prefix='media_render_programme_'))
        files: dict[str, str] = {}
        local_files: dict[str, Path] = {}
        part_times: list[dict] = []
        # a programme is reframed exactly as a clip is: through the framing
        # plan, part by part. Anything the plan does not describe (a 16:9
        # deliverable, a plan of full frames, no plan at all) keeps the
        # letterboxed path this has always used.
        framing = ctx['framing'] if (ctx['reframes'] and primary['framing']) else None
        framing_applied = False
        try:
            # the copy is held for exactly as long as the block below
            with local_copy(store, spec['source']) as local:
                source_info = self._probe_source(local, warnings_out)
                overlay = plan_lib.overlay_for(spec)
                overlay_path = self._local_asset(store, overlay, 'overlay', warnings_out) if overlay else None
                music_cfg = spec.get('music') if isinstance(spec.get('music'), dict) else None
                music_path = self._local_asset(store, music_cfg, 'music', warnings_out) if music_cfg else None

                # ---- picture: one part at a time, each with its own captions
                video_files: list[Path] = []
                audio_pieces: list[dict] = []
                lead_ms = tail_ms = 0
                if has_video:
                    for item in plan_lib.concat_for(spec, 'start'):
                        asset = self._local_asset(store, item, 'attached', warnings_out)
                        if asset is None:
                            continue
                        part = render_asset_part(
                            asset,
                            work / f'lead-{len(video_files)}.mp4',
                            out_w,
                            out_h,
                            fps=fps,
                            crf=crf,
                            preset=x264,
                            fit=primary['fit'],
                            background=primary['background'],
                            source=self._probe_source(asset, warnings_out),
                        )
                        length = int(probe(part)['duration_ms'])
                        video_files.append(part)
                        audio_pieces.append(
                            self._asset_audio(asset, work / f'lead-{len(video_files)}.wav', length, warnings_out)
                        )
                        lead_ms += length
                    for card in plan_lib.cards_for(spec, 'start'):
                        part = render_card(
                            card.get('text') or spec.get('title') or '',
                            card.get('subtitle') or '',
                            float(card.get('seconds') or 3),
                            work / f'lead-card-{len(video_files)}.mp4',
                            out_w,
                            out_h,
                            fps=fps,
                            crf=crf,
                            preset=x264,
                            warnings=warnings_out,
                        )
                        length = int(probe(part)['duration_ms'])
                        video_files.append(part)
                        audio_pieces.append({'silence_ms': length})
                        lead_ms += length

                    parts = plan_programme_parts(keep, plan_lib.part_ms_for(spec, cfg))
                    if framing and any(p.get('fallback') for p in layout_pieces(keep, framing.get('segments') or [])):
                        warnings_out.append(
                            'The framing plan does not cover what was rendered; it was rendered full frame.'
                        )
                        warning(f'{NODE}: the framing plan does not cover the keep list')
                    shaped = None
                    if framing:
                        shaped = resize_layout(framing, out_w, out_h)
                        framing_applied = bool(parts)
                    for part in parts:
                        started = time.time()
                        self._status(store, status_to, 'rendering', mode=mode, part=part['n'], parts=len(parts))
                        local_part = work / f'part-{part["n"]:03d}.mp4'
                        slices = [(s, e) for s, e in part['keep']]
                        ass = None
                        if captions_on:
                            # the lines are already on the rendered slice's
                            # clock (`caption_plan`); this part starts inside it
                            window = shift_groups(groups, part['out_start_ms'], part['duration_ms'])
                            # the caption line follows this PART's framing:
                            # a stacked stretch puts it on the seam, as the
                            # clip path has always done
                            ass = self._captions_file(
                                work / f'part-{part["n"]:03d}.ass',
                                window,
                                ctx,
                                out_w,
                                out_h,
                                placement=self._seam_placement(shaped, slices, out_h),
                                layout=primary['caption_layout'],
                            )
                        if shaped:
                            render_layout_part(
                                local,
                                slices,
                                shaped,
                                local_part,
                                work,
                                fps=fps,
                                crf=crf,
                                preset=x264,
                                ass_path=ass,
                                logo=overlay,
                                logo_path=overlay_path,
                                source=source_info,
                                output_start_ms=part['out_start_ms'],
                            )
                        else:
                            render_programme_part(
                                local,
                                slices,
                                local_part,
                                out_w,
                                out_h,
                                fps=fps,
                                crf=crf,
                                preset=x264,
                                fit=primary['fit'],
                                background=primary['background'],
                                ass_path=ass,
                                logo=overlay,
                                logo_path=overlay_path,
                                source=source_info,
                                output_start_ms=part['out_start_ms'],
                            )
                        video_files.append(local_part)
                        # `done` on every entry: what the run rendered, part by
                        # part, so a client can say how long each one took
                        part_times.append(
                            {
                                'n': part['n'],
                                'duration_ms': part['duration_ms'],
                                'seconds': round(time.time() - started, 1),
                                'done': True,
                            }
                        )

                    audio_pieces.append({'path': None})  # placeholder for the body
                    for card in plan_lib.cards_for(spec, 'end'):
                        part = render_card(
                            card.get('text') or '',
                            card.get('subtitle') or '',
                            float(card.get('seconds') or 3),
                            work / f'tail-card-{len(video_files)}.mp4',
                            out_w,
                            out_h,
                            fps=fps,
                            crf=crf,
                            preset=x264,
                            warnings=warnings_out,
                        )
                        length = int(probe(part)['duration_ms'])
                        video_files.append(part)
                        audio_pieces.append({'silence_ms': length})
                        tail_ms += length
                    for item in plan_lib.concat_for(spec, 'end'):
                        asset = self._local_asset(store, item, 'attached', warnings_out)
                        if asset is None:
                            continue
                        part = render_asset_part(
                            asset,
                            work / f'tail-{len(video_files)}.mp4',
                            out_w,
                            out_h,
                            fps=fps,
                            crf=crf,
                            preset=x264,
                            fit=primary['fit'],
                            background=primary['background'],
                            source=self._probe_source(asset, warnings_out),
                        )
                        length = int(probe(part)['duration_ms'])
                        video_files.append(part)
                        audio_pieces.append(
                            self._asset_audio(asset, work / f'tail-{len(video_files)}.wav', length, warnings_out)
                        )
                        tail_ms += length
                else:
                    audio_pieces.append({'path': None})

                # ---- sound: the edited body first — deliberately UNMASTERED here
                self._status(store, status_to, 'mastering', mode=mode, master=audio['master'])
                body_wav = render_programme_audio(
                    local,
                    keep,
                    work / 'body.wav',
                    source_has_audio=source_info.get('has_audio', True),
                    mutes=mutes,
                    bleeps=bleeps,
                    noise_reduction=audio['denoise'],
                    high_pass=audio['highpass'],
                    compression=audio['compress'],
                    music_path=music_path,
                    music=music_cfg,
                    master=False,
                    loudness_lufs=audio['loudness_lufs'],
                    true_peak=audio['true_peak'],
                    channels=channels,
                )
                for piece in audio_pieces:
                    if piece.get('path') is None and 'silence_ms' not in piece:
                        piece['path'] = str(body_wav)
                program_wav = assemble_programme_audio(audio_pieces, work / 'programme-audio.wav', channels=channels)

                # ---- mastering LAST, over the complete assembled programme
                final_wav = program_wav
                if audio['master']:
                    final_wav = master_wav(
                        program_wav,
                        work / 'programme-master.wav',
                        loudness_lufs=audio['loudness_lufs'],
                        true_peak=audio['true_peak'],
                        channels=channels,
                    )

                # ---- join + mux
                if has_video:
                    joined = concat_parts(video_files, work / 'video.mp4', work)
                    final = mux_programme(joined, final_wav, self._output_path(work, primary['file']))
                else:
                    final = encode_audio_deliverable(final_wav, self._output_path(work, primary['file']))

                # every measurement below is taken on a FINISHED deliverable
                check = probe(final)
                loudness = measure_loudness(final)
                self._note_silence(loudness, warnings_out)
                measurements: dict = {}
                if loudness:
                    measurements[primary['key']] = loudness
                total_ms = lead_ms + body_ms + tail_ms

                files[primary['key']] = write_file(store, f'{write_to}/{primary["file"]}', final)
                local_files[primary['key']] = final
                for output in derived:
                    source_key = output['from']
                    if output['video']:
                        origin = local_files.get(source_key) or final
                        alt = transcode_aspect(
                            origin,
                            self._output_path(work, output['file']),
                            output['width'],
                            output['height'],
                            fps=output['fps'],
                            crf=output['crf'],
                            preset=output['preset'],
                            fit=output['fit'],
                            background=output['background'],
                        )
                    else:
                        alt = encode_audio_deliverable(final_wav, self._output_path(work, output['file']))
                        measured = measure_loudness(alt)
                        if measured:
                            measurements[output['key']] = measured
                    files[output['key']] = write_file(store, f'{write_to}/{output["file"]}', alt)
                    local_files[output['key']] = alt
                measurements = {k: v for k, v in measurements.items() if v}

                self._write_sidecars(store, ctx, groups, files, work, lead_ms)
                if has_video and ctx['thumbnail']:
                    # past the lead-in: a poster taken a second into a
                    # programme that opens on a brand card is a picture of the
                    # card, not of what the piece is about
                    files['thumbnail'] = self._write_thumbnail(
                        store, ctx, final, work, lead_ms + min(1000, max(0, body_ms // 3)), check, warnings_out
                    )
                chapters = [
                    {'title': c.get('title'), 'out_ms': int(c.get('out_ms') or 0) + lead_ms}
                    for c in (spec.get('chapters') or [])
                    if isinstance(c, dict)
                ]
                # the spec may ask for the chapter FILES outright; without the flag
                # they belong to an export, as they always have
                wants_files = spec.get('chapter_files')
                if chapters and (bool(wants_files) if wants_files is not None else mode == 'export'):
                    meta_file = work / 'chapters.txt'
                    meta_file.write_text(ffmetadata_chapters(chapters, total_ms, spec.get('title')), encoding='utf-8')
                    files['chapters_txt'] = write_file(store, f'{write_to}/chapters.txt', meta_file)
                    write_json(store, f'{write_to}/chapters.json', chapters_payload(chapters, total_ms))
                    files['chapters_json'] = f'{write_to}/chapters.json'
        finally:
            shutil.rmtree(work, ignore_errors=True)

        report = self._report(
            ctx,
            check=check,
            loudness=loudness,
            measurements=measurements,
            files=files,
            primary=primary,
            total_ms=total_ms,
            body_ms=body_ms,
            lead_ms=lead_ms,
            tail_ms=tail_ms,
            mastered=bool(audio['master']),
            framing_applied=framing_applied,
            mutes=len(mutes),
            bleeps=len(bleeps),
            chapters=chapters,
            music=bool(music_path),
            parts=part_times,
            warnings=warnings_out,
            cuts=max(0, len(full_keep) - 1),
            extras=[o['aspect'] for o in derived if o['video'] and o.get('aspect')],
        )
        self._finish(store, ctx, report, files)
        return report

    def _report(
        self,
        ctx: dict,
        *,
        check: dict,
        loudness,
        measurements: dict,
        files: dict,
        primary: dict,
        total_ms: int,
        body_ms: int,
        mastered: bool,
        framing_applied: bool,
        mutes: int,
        bleeps: int,
        chapters: list,
        music: bool,
        parts: list,
        warnings: list[str],
        lead_ms: int = 0,
        tail_ms: int = 0,
        cuts: int | None = None,
        extras: list | None = None,
    ) -> dict:
        spec, keep_plan, captions = ctx['spec'], ctx['keep'], ctx['captions']
        media = ctx['media']
        detail = quality_block(
            primary['tier'],
            check,
            crf=primary['crf'],
            preset=primary['preset'],
            channels=primary['audio_channels'],
            source_width=media.get('width'),
            source_height=media.get('height'),
            fps=primary['fps'],
            width=primary['width'],
            height=primary['height'],
        )
        captions_on = bool(primary['captions'] and captions['enabled'])
        report = build_render_report(
            kind=str((spec.get('meta') or {}).get('kind') or 'render'),
            mode=ctx['mode'],
            quality=str(spec.get('quality') or (spec.get('meta') or {}).get('quality') or primary['tier']),
            detail=detail,
            check=check,
            version=spec.get('version') or (spec.get('meta') or {}).get('version'),
            title=spec.get('title') or (spec.get('meta') or {}).get('title'),
            measured=loudness,
            measurements=measurements,
            target_lufs=ctx['audio']['loudness_lufs'],
            mastered=mastered,
            window=keep_plan['window'],
            preview_output_start_ms=keep_plan['offset_ms'],
            total_ms=total_ms,
            body_ms=body_ms,
            lead_ms=lead_ms,
            tail_ms=tail_ms,
            files=files,
            outputs=[o['key'] for o in ctx['outputs']],
            extras=extras,
            source_range=keep_plan['source_range'],
            fps=primary['fps'],
            cuts=max(0, len(keep_plan['full_keep']) - 1) if cuts is None else cuts,
            mutes=mutes,
            bleeps=bleeps,
            captions_on=captions_on,
            caption_lines=len(captions['groups']) if captions_on else 0,
            caption_style=captions['style'],
            caption_preset=(captions['style'].get('preset') if captions_on else 'off'),
            chapters=chapters,
            music=music,
            expect_video=bool(ctx['has_video']),
            parts=parts,
            spec_hash=ctx['spec_hash'],
            framing=plan_lib.framing_summary(ctx['framing'], framing_applied),
            warnings=warnings,
            seconds=round(time.time() - self._t0, 1),
        )
        # ALWAYS false: there is no render cache any more. The key stays in the
        # shape for one release so a reader that branches on it keeps working.
        report['cached'] = False
        # `meta` is the caller's; a NaN it carried would make the report unwritable
        return {**finite(spec.get('meta') or {}), **report}

    @staticmethod
    def _note_silence(loudness: dict | None, warnings_out: list[str]) -> None:
        """A finished file that measures no loudness at all is silent, and the report says so."""
        if loudness and loudness.get('integrated_lufs') is None and SILENT_AUDIO_WARNING not in warnings_out:
            warnings_out.append(SILENT_AUDIO_WARNING)

    def _finish(self, store, ctx: dict, report: dict, files: dict) -> None:
        report_to = ctx['spec'].get('report_to')
        if report_to:
            write_json(store, str(report_to), report)
        self._status(
            store, ctx['status_to'], 'rendered', mode=ctx['mode'], files=sorted(files), seconds=report.get('seconds')
        )

    def _write_sidecars(self, store, ctx: dict, groups: list, files: dict, work: Path, lead_ms: int) -> None:
        """
        SRT / VTT next to the picture, on the finished file's own timeline and
        under the names the spec asked for (`subtitles.files`). Without those
        they follow the FIRST PICTURE the render produced, which is the file a
        player loads them beside.
        """
        captions = ctx['captions']
        wanted = bool(ctx['cfg']['sidecars']) if captions['sidecars'] is None else bool(captions['sidecars'])
        if not wanted or not groups:
            return
        primary = next((o for o in ctx['outputs'] if o['video']), ctx['outputs'][0])
        name = captions['name'] or primary['name']
        named = captions.get('files') or {}
        shifted = shift_groups(groups, -lead_ms) if lead_ms else groups
        if not shifted:
            return
        for kind, build in (('srt', build_srt), ('vtt', build_vtt)):
            file_name = str(named.get(kind) or f'{name}.{kind}')
            local = self._output_path(work, file_name)
            local.write_text(build(shifted), encoding='utf-8')
            files[kind] = write_file(store, f'{ctx["write_to"]}/{file_name}', local)

    def _write_thumbnail(
        self, store, ctx: dict, media_path: Path, work: Path, default_at_ms: int, check: dict, warnings_out: list[str]
    ) -> str:
        """
        The poster frame, off the finished file `check` is the probe of. A
        time past its end is pulled back inside it (`thumbnail_at_ms`) with a
        warning — ffmpeg would otherwise fail the whole render for one frame.
        """
        want = ctx['spec'].get('thumbnail')
        want = want if isinstance(want, dict) else {}
        given = str(want.get('file') or '')
        name = given.rsplit('.', 1)[0] if given else str(want.get('name') or ctx['outputs'][0]['name'])
        wanted = int(want.get('at_ms') if want.get('at_ms') is not None else default_at_ms)
        check = check if isinstance(check, dict) else {}
        at_ms = thumbnail_at_ms(wanted, check.get('duration_ms') or 0, check.get('fps') or ctx['outputs'][0]['fps'])
        if at_ms != wanted:
            warnings_out.append(
                f'The poster frame was asked for at {wanted / 1000:.1f}s, which is outside the '
                f'{int(check.get("duration_ms") or 0) / 1000:.1f}s file; the frame at {at_ms / 1000:.1f}s was used.'
            )
        jpg = thumbnail(media_path, self._output_path(work, f'{name}.jpg'), at_ms=at_ms)
        return write_file(store, f'{ctx["write_to"]}/{name}.jpg', jpg)

    @staticmethod
    def _output_path(work: Path, filename: str) -> Path:
        """Keep named deliverables separate from intermediate media files."""
        plan_lib.check_store_path(filename, 'output file name')
        path = work / 'deliverables' / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def _captions_file(
        self, path: Path, groups: list, ctx: dict, out_w: int, out_h: int, placement=None, layout: str | None = None
    ):
        """One part's burned-in captions, in the spec's own style."""
        if not groups:
            return None
        captions = ctx['captions']
        style = captions['style']
        text = build_ass(
            groups,
            layout or plan_lib.caption_layout_for(out_w, out_h),
            style=style,
            placement=placement,
            speaker_colors=captions['speaker_colors'] if style.get('speaker_colors') else None,
        )
        path.write_text(text, encoding='utf-8')
        return path

    @staticmethod
    def _seam_placement(framing: dict | None, keep, canvas_h):
        """
        Where the caption line sits, per OUTPUT millisecond of the stretch being
        rendered: a stacked segment puts it on the seam between the two panels
        so neither face is covered, everything else uses the bottom band.

        `keep` is the slice of the recording this render covers — the whole clip
        on the clip path, ONE rendered part on the programme path. The plan is
        INTERSECTED with it (`layout_pieces`, the same split the picture is
        rendered in), so a segment a part boundary or a cut lands inside still
        places the line; looking the segment's own ends up on the output clock
        finds nothing and puts the line back over a face for the rest of it.
        """
        segments = [s for s in ((framing or {}).get('segments') or []) if isinstance(s, dict)]
        slices = [(int(a), int(b)) for a, b in (keep or []) if int(b) > int(a)]
        if not segments or not slices:
            return None
        timeline = TimelineMap(slices)
        out_segments = []
        for piece in layout_pieces(slices, segments):
            if piece.get('fallback'):
                continue
            a = timeline.to_output(int(piece['start_ms']))
            b = timeline.to_output(int(piece['end_ms']) - 1)
            if a is None or b is None:
                continue
            seg = piece['segment']
            out_segments.append(
                {'start_ms': a, 'end_ms': b + 1, 'layout': seg.get('layout'), 'panels': seg.get('panels')}
            )
        return seam_placement(out_segments, canvas_h=canvas_h)

    @staticmethod
    def _probe_source(local: Path, warnings_out: list[str]) -> dict:
        """
        What the recording really is: the pixel aspect, because a 32:27
        recording has to be scaled to its display size before anything is
        cropped out of it, and the PICTURE — bit depth, chroma, range, colour
        tags — because a camera file that is not 8-bit 4:2:0 limited-range has
        to be converted before a crop touches it (`source_normalize`). A probe
        that fails is not worth failing a render for; the graphs then render
        the source exactly as they did before these fields existed.
        """
        try:
            info = probe(local)
        except Exception as exc:  # noqa: BLE001
            warning(f'{NODE}: could not probe the source: {exc}')
            return {}
        note = source_colour_warning(info)
        if note and note not in warnings_out:
            warnings_out.append(note)
        return info

    def _local_asset(self, store, asset, kind: str, warnings_out: list[str]):
        """
        One referenced file, copied next to the render; a missing file is a
        warning, not a failure. The path leaves this helper, so the copy cannot
        live in a `with` block here: its directory is remembered and removed by
        `_release_assets` when the render that asked for it is finished.
        """
        path = None
        if isinstance(asset, dict):
            path = asset.get('source') or asset.get('path') or asset.get('image')
        elif isinstance(asset, str):
            path = asset
        if not path:
            return None
        work = Path(tempfile.mkdtemp(prefix='media_render_asset_'))
        try:
            local = download_to(store, str(path), work / f'asset{Path(str(path)).suffix.lower() or ".bin"}')
            self._assets.append(work)
            return local
        except Exception as exc:  # noqa: BLE001
            shutil.rmtree(work, ignore_errors=True)
            warnings_out.append(f'The {kind} file could not be read and was skipped.')
            warning(f'{NODE}: asset {kind}: {exc}')
            return None

    def _release_assets(self) -> None:
        """Throw away every copy `_local_asset` made for this render."""
        while self._assets:
            shutil.rmtree(self._assets.pop(), ignore_errors=True)

    def _asset_audio(self, asset_path, out_wav: Path, length_ms: int, warnings_out: list[str]) -> dict:
        try:
            return {'path': str(conform_audio(asset_path, out_wav, length_ms))}
        except Exception:  # noqa: BLE001
            warnings_out.append('One of the added pieces had no sound; it plays silent.')
            return {'silence_ms': length_ms}
