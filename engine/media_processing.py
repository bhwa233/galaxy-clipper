"""Offline media operations. Every input path is resolved and authorized by Electron main."""
import math
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from fractions import Fraction
from pathlib import Path

from subtitles import compose_bilingual, copy_fonts, read_cues, write_ass, write_srt


def inspect(ffmpeg, source, details=False):
    process = subprocess.run([ffmpeg, '-hide_banner', '-i', source], capture_output=True, timeout=120)
    text = process.stderr.decode('utf-8', 'replace')
    match = re.search(r'Duration: (\d+):(\d+):(\d+(?:\.\d+)?)', text)
    duration = int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3]) if match else 0
    metadata = {'durationSeconds': duration, 'video': bool(re.search(r'Stream .*Video:', text)),
                'subtitles': [{'index': int(found[1]), 'language': found[2] or 'und'}
                              for found in re.finditer(r'Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([^)]+)\))?: Subtitle:', text)]}
    # Downloaders that embed metadata (yt-dlp, Galaxy Downloader) record the page URL.
    page = re.search(r'^\s*(?:purl|comment|description)\s*:\s*(https?://\S+)\s*$', text, re.MULTILINE | re.IGNORECASE)
    if page:
        metadata['sourceUrl'] = page[1]
    if details:
        # Reuse the bundled FFmpeg's structured frame-checksum stream headers.
        streams = subprocess.run([ffmpeg, '-v', 'error', '-i', source, '-map', '0:v:0?', '-map', '0:a:0?',
                                  '-frames:v', '1', '-frames:a', '1', '-f', 'framemd5', 'pipe:1'],
                                 capture_output=True, timeout=120)
        if streams.returncode:
            raise ValueError('Could not inspect media streams')
        headers = {(key, int(index)): value.strip() for key, index, value in
                   re.findall(r'^#(\w+)\s+(\d+):\s*(.+)$', streams.stdout.decode('utf-8', 'replace'), re.MULTILINE)}
        try:
            video = next(index for (key, index), value in headers.items() if key == 'media_type' and value == 'video')
            width, height = map(int, headers['dimensions', video].split('x'))
            time_base = Fraction(headers['tb', video])
            sar = Fraction(headers['sar', video])
            if width <= 0 or height <= 0 or time_base <= 0 or sar < 0:
                raise ValueError('Invalid stream dimensions or time base')
        except (StopIteration, KeyError, ValueError, ZeroDivisionError) as error:
            raise ValueError('Media stream information is incomplete') from error
        metadata.update(width=width, height=height, frameRate=float(1 / time_base),
                        sampleAspectRatio=f'{sar.numerator}/{sar.denominator}',
                        audio=any(key == 'media_type' and value == 'audio' for (key, _), value in headers.items()))
    return metadata


def run(request, emit):
    operation = request['operation']
    if operation == 'unpack':
        destination = Path(request['output']).resolve()
        wanted = set(request['archiveFiles'])
        with tarfile.open(request['input']) as archive:
            for member in archive:
                name = member.name.removeprefix('./')
                if name not in wanted:
                    continue
                target = (destination / name).resolve()
                if not member.isfile() or not target.is_relative_to(destination):
                    raise ValueError('Unsafe model archive member')
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open('wb') as output:
                    shutil.copyfileobj(source, output)
                wanted.remove(name)
        if wanted:
            raise ValueError('Model archive missing required files: ' + ', '.join(sorted(wanted)))
        emit('result', result={'ok': True})
        return
    ffmpeg, source = request['ffmpeg'], request['input']
    metadata = inspect(ffmpeg, source)
    if operation == 'inspect':
        emit('result', result=metadata)
        return
    if operation in ('audio', 'audio-chunk'):
        seek = ['-ss', str(request.get('startMs', 0) / 1000)] if operation == 'audio-chunk' else []
        limit = ['-t', str(request['durationMs'] / 1000)] if operation == 'audio-chunk' else []
        subprocess.run([ffmpeg, '-hide_banner', '-nostdin', '-y', *seek, '-i', source, *limit, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', request['output']], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        emit('result', result={'durationSeconds': inspect(ffmpeg, request['output'])['durationSeconds']})
        return
    if operation == 'embedded-captions':
        destination = Path(request['output'])
        destination.mkdir(parents=True, exist_ok=True)
        tracks = []
        for track in metadata['subtitles'][:20]:
            output = destination / f"embedded-{track['index']}.srt"
            process = subprocess.run([ffmpeg, '-hide_banner', '-nostdin', '-y', '-i', source, '-map', f"0:{track['index']}", '-c:s', 'srt', str(output)], capture_output=True)
            if process.returncode == 0 and output.stat().st_size:
                tracks.append({**track, 'file': str(output)})
        emit('result', result={'tracks': tracks})
        return
    if operation == 'caption-frame':
        caption_frame(request, emit, ffmpeg, source)
        return
    if operation != 'render':
        raise ValueError('Unknown local media operation')
    render(request, emit, ffmpeg, source, metadata)


def bundled_fonts(ffmpeg):
    for folder in (Path(getattr(sys, '_MEIPASS', Path(__file__).parent)) / 'fonts', Path(sys.executable).parent / 'fonts', Path(ffmpeg).parent / 'fonts'):
        if (folder / 'NotoSansCJKsc-Bold.otf').is_file():
            return folder
    raise ValueError('Subtitle font is missing; reinstall the client')


def run_ffmpeg(args, directory, emit, duration):
    """Run FFmpeg with progress and an ETA smoothed from measured encode speed."""
    started, rate = time.monotonic(), None
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(args, cwd=directory, stdout=subprocess.PIPE, stderr=errors, text=True, encoding='utf-8')
        for line in process.stdout:
            if line.startswith('out_time_us=') and duration:
                try:
                    position = max(0, int(line.split('=')[1]) / 1_000_000)
                except ValueError:
                    continue
                elapsed = time.monotonic() - started
                # Wait for real work before estimating, then smooth changing
                # encode speeds instead of assuming a fixed ratio.
                if elapsed >= 3 and position > 0:
                    sample = position / elapsed
                    rate = sample if rate is None else rate * 0.8 + sample * 0.2
                eta = math.ceil(max(0, duration - position) / rate) if rate else None
                emit('processing', status='exporting', progress=min(.99, position / duration), eta=eta)
        if process.wait() != 0:
            errors.seek(0)
            raise RuntimeError(errors.read().decode('utf-8', 'replace')[-4000:])


def prepare_burn(request, ffmpeg, source, directory, mode, tracks):
    """Write captions.ass and fonts/ into the FFmpeg working directory."""
    zh = next((track for track in tracks if track['role'] == 'zh'), None)
    en = next((track for track in tracks if track['role'] == 'en'), None)
    if mode == 'burn-bilingual':
        if not (zh and en):
            raise ValueError('Bilingual burn-in needs a Chinese and an English subtitle track')
        chosen = {'zh': read_cues(zh['file'], False), 'en': read_cues(en['file'], False)}
    else:
        chosen = {tracks[0]['role']: read_cues(tracks[0]['file'], False)} if tracks else {}
    if not any(chosen.values()):
        raise ValueError('No subtitles to burn')
    size = inspect(ffmpeg, source, details=True)
    write_ass(Path(directory) / 'captions.ass', chosen, size['width'], size['height'], request.get('subtitleStyle'))
    copy_fonts(bundled_fonts(ffmpeg), directory)


def caption_frame(request, emit, ffmpeg, source):
    """One real burned frame at timeMs, rendered exactly like the export."""
    output, at = Path(request['output']), max(0, request.get('timeMs', 0)) / 1000
    with tempfile.TemporaryDirectory(prefix='galaxy-frame-') as directory:
        prepare_burn(request, ffmpeg, source, directory, request.get('renderMode', 'burn'), request.get('captionTracks') or [])
        # Input seeking restarts timestamps at zero; shift them back for the ASS timeline.
        process = subprocess.run([ffmpeg, '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-ss', str(at), '-i', source,
                                  '-vf', f"setpts=PTS+{at}/TB,ass=filename=captions.ass:fontsdir=fonts,scale=w='min(1280,iw)':h=-2",
                                  '-frames:v', '1', '-q:v', '3', str(output)], cwd=directory, capture_output=True, timeout=60)
        if process.returncode or not output.is_file():
            raise RuntimeError(process.stderr.decode('utf-8', 'replace')[-2000:] or 'Could not render a preview frame')
    emit('result', result={'file': str(output)})


def language_code(language):
    base = language.lower().split('-')[0]
    return {'zh': 'zho', 'en': 'eng'}.get(base, base if len(base) == 3 else 'und')


def render(request, emit, ffmpeg, source, metadata):
    output = Path(request['output'])
    if output.resolve() == Path(source).resolve() or output.exists():
        raise ValueError('Output must be a new file')
    mode = request.get('renderMode', 'video')
    if not metadata['video']:
        raise ValueError('The source has no video stream')
    mp4 = output.suffix.lower() in ('.mp4', '.m4v', '.mov')
    # Each track: {file, language, role: zh|en|other}. Roles decide bilingual pairing.
    tracks = request.get('captionTracks') or []
    zh = next((track for track in tracks if track['role'] == 'zh'), None)
    en = next((track for track in tracks if track['role'] == 'en'), None)
    with tempfile.TemporaryDirectory(prefix='galaxy-render-') as directory:
        temporary = str(output.with_name(output.stem + '.processing' + output.suffix))
        args = [ffmpeg, '-hide_banner', '-nostdin', '-y', '-i', source]
        filters = []
        encode_video = ['-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p']
        fallback = None
        if mode == 'soft':
            if not tracks:
                raise ValueError('No subtitles to embed')
            # zh, en, the composed zh+en track, then up to two other languages.
            embedded = [track for track in (zh, en) if track]
            if zh and en:
                combined = Path(directory) / 'zh-en.srt'
                write_srt(combined, compose_bilingual(read_cues(zh['file'], False), read_cues(en['file'], False)))
                embedded.append({'file': str(combined), 'language': 'zh', 'role': 'zh-en'})
            embedded += [track for track in tracks if track['role'] == 'other'][:2]
            for track in embedded:
                args += ['-i', track['file']]
            args += ['-map', '0:v:0', '-map', '0:a?']
            default = next((index for index, track in enumerate(embedded) if track['role'] == 'zh-en'), 0)
            for index, track in enumerate(embedded):
                label = {'zh-en': '中文 + English', 'zh': '中文', 'en': 'English'}.get(track['role'], track['language'])
                args += ['-map', f'{index + 1}:0', f'-metadata:s:s:{index}', f"language={language_code(track['language'])}",
                         f'-metadata:s:s:{index}', f'handler_name={label}', f'-metadata:s:s:{index}', f'title={label}',
                         f'-disposition:s:{index}', 'default' if index == default else '0']
            position = len(args)
            args += ['-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text' if mp4 else 'srt']
            # MP4 cannot carry every source codec; encode only when lossless muxing fails.
            fallback = (position, [*encode_video, '-c:a', 'aac', '-b:a', '192k'])
        else:
            args += ['-map', '0:v:0', '-map', '0:a?']
            if mode in ('burn', 'burn-bilingual'):
                prepare_burn(request, ffmpeg, source, directory, mode, tracks)
                # Fixed relative names keep drive colons and apostrophes out of FFmpeg's filter language.
                filters.append('ass=filename=captions.ass:fontsdir=fonts')
            resolution = request.get('outputResolution', 'original')
            if resolution != 'original':
                limit = int(resolution)
                factor = f'min(1,{limit}/min(iw,ih))'
                # Burn on the source canvas first, then scale the frame with its captions.
                filters.append(f"scale=w='max(2,trunc(iw*{factor}/2)*2)':h='max(2,trunc(ih*{factor}/2)*2)'")
            if filters:
                args += ['-vf', ','.join(filters)]
            args += [*encode_video, '-c:a', 'aac', '-b:a', '192k']
        if mp4:
            args += ['-movflags', '+faststart']
        tail = ['-progress', 'pipe:1', '-nostats', temporary]
        try:
            try:
                run_ffmpeg(args + tail, directory, emit, metadata['durationSeconds'])
            except RuntimeError:
                if not fallback:
                    raise
                # Replace "-c:v copy -c:a copy" with an encode; keep the subtitle codec.
                position, replacement = fallback
                run_ffmpeg(args[:position] + replacement + args[position + 4:] + tail, directory, emit, metadata['durationSeconds'])
            os.replace(temporary, output)
        finally:
            Path(temporary).unlink(missing_ok=True)
    emit('result', result={'file': str(output)})
