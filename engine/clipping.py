"""Galaxy's local clip renderer. Inputs are authorized by Electron main."""
import math
import os
import shutil
import subprocess
import tempfile
import textwrap
from pathlib import Path

from media_processing import inspect


def clock(ms):
    ms = max(0, round(ms))
    return f'{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}'


def execute(args, directory, emit, total, base, share):
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(args, cwd=directory, stdout=subprocess.PIPE, stderr=errors,
                                   text=True, encoding='utf-8')
        for line in process.stdout:
            if line.startswith('out_time_us='):
                try:
                    value = max(0, min(1, int(line.split('=')[1]) / 1000000 / max(total, .001)))
                    emit('processing', status='exporting', progress=min(.99, base + value * share))
                except ValueError:
                    pass
        if process.wait() != 0:
            errors.seek(0)
            raise RuntimeError(errors.read().decode('utf-8', 'replace')[-3000:])


def picture(settings, preview):
    aspect = settings['aspect']
    resolution = 360 if preview else int(settings['resolution']) if settings['resolution'] != 'original' else 1080
    if aspect == 'original':
        if preview or settings['resolution'] != 'original':
            factor = f'min(1,{resolution}/min(iw,ih))'
            return f"scale=w='max(2,trunc(iw*{factor}/2)*2)':h='max(2,trunc(ih*{factor}/2)*2)'"
        return 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
    width, height = (resolution, round(resolution * 16 / 9 / 2) * 2) if aspect == 'portrait' else (round(resolution * 16 / 9 / 2) * 2, resolution)
    if settings['layout'] == 'crop':
        x = float(settings['cropX'])
        return f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}:x='(iw-ow)*{x}':y='(ih-oh)/2'"
    if settings['layout'] == 'blur':
        return (f'split[back][front];[back]scale={width}:{height}:force_original_aspect_ratio=increase,'
                f'crop={width}:{height},boxblur=20:2[blur];'
                f'[front]scale={width}:{height}:force_original_aspect_ratio=decrease[fit];'
                '[blur][fit]overlay=(W-w)/2:(H-h)/2')
    return f'scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black'


def run(request, emit):
    ffmpeg, source, target = request['ffmpeg'], request['input'], Path(request['output'])
    settings, scenes = request['clipSettings'], request['scenes']
    media = inspect(ffmpeg, source, details=True)
    if not media['video'] or not scenes or len(scenes) > 30:
        raise ValueError('Choose one to thirty video scenes')
    if target.exists() or target.resolve() == Path(source).resolve():
        raise ValueError('Output must be a new file')
    lengths = []
    for scene in scenes:
        start, end = scene['startMs'], scene['endMs']
        if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in (start, end)) or start < 0 or end - start < 100 or end > media['durationSeconds'] * 1000 + 1:
            raise ValueError('Invalid clip range')
        lengths.append(max(1, math.floor((end - start) * 30 / 1000 + .5)) / 30)
    total = sum(lengths)
    if total > 1800:
        raise ValueError('Output exceeds thirty minutes')
    has_audio = media['audio']
    preview = bool(request.get('preview'))
    partial = None
    try:
        with tempfile.TemporaryDirectory(prefix='galaxy-clips-', dir=request.get('workDirectory')) as directory:
            folder = Path(directory)
            base = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '2']
            offset = 0
            for index, (scene, length) in enumerate(zip(scenes, lengths)):
                # Normalize display pixels before layout; scale/pad rounding may
                # otherwise retain a non-square SAR and stretch the final canvas.
                square_pixels = "scale=w='max(2,trunc(iw*if(gt(sar,0),sar,1)/2)*2)':h='max(2,trunc(ih/2)*2)',setsar=1,"
                video = '[0:v:0]setpts=PTS-STARTPTS,' + square_pixels + picture(settings, preview) + ',setsar=1,fps=30,format=yuv420p[video]'
                if settings['originalAudio'] and has_audio:
                    audio = ('[0:a:0]aresample=48000:async=1:first_pts=0,aformat=channel_layouts=stereo[src];'
                             '[1:a:0][src]amix=inputs=2:duration=longest:normalize=0,'
                             f'atrim=duration={length},asetpts=PTS-STARTPTS[audio]')
                else:
                    audio = f'[1:a:0]atrim=duration={length},asetpts=PTS-STARTPTS[audio]'
                args = [*base, '-ss', str(scene['startMs'] / 1000), '-i', source,
                        '-f', 'lavfi', '-t', str(length), '-i', 'anullsrc=r=48000:cl=stereo',
                        '-filter_complex_threads', '1', '-filter_complex', video + ';' + audio,
                        '-map', '[video]', '-map', '[audio]', '-t', str(length),
                        '-c:v', 'libx264', '-preset', 'ultrafast' if preview else 'fast', '-crf', '25' if preview else '20',
                        '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
                        '-progress', 'pipe:1', '-nostats', str(folder / f'part-{index}.mkv')]
                execute(args, directory, emit, length, offset / total * .7, length / total * .7)
                offset += length
            (folder / 'parts.txt').write_text(''.join(f"file 'part-{index}.mkv'\nduration {length:.9f}\n" for index, length in enumerate(lengths)), encoding='utf-8')
            filters = []
            fonts = Path(ffmpeg).parent / 'fonts'
            if not fonts.exists():
                fonts = Path(getattr(__import__('sys'), '_MEIPASS', Path(__file__).parent)) / 'fonts'
            if fonts.exists():
                shutil.copytree(fonts, folder / 'fonts')
            if settings['subtitles'] and request.get('clipCaptions'):
                canvas = inspect(ffmpeg, str(folder / 'part-0.mkv'), details=True)
                width, height = canvas['width'], canvas['height']
                font_size = max(12, round(min(width, height) / 24))
                if settings['subtitleStyle'] == 'bold':
                    font_size = round(font_size * 26 / 22)
                margin_x, margin_y = max(8, round(width * .06)), max(8, round(height * .055))
                line_width = max(1, math.floor((width - 2 * margin_x) / (font_size * 1.15)))
                captions = []
                for cue in request['clipCaptions']:
                    if cue['endMs'] > cue['startMs']:
                        # Reuse stdlib wrapping and FFmpeg's SRT-to-ASS conversion:
                        # the SRT filter's implicit 384x288 canvas and optional
                        # Unicode wrapping cannot contain long unspaced CJK cues.
                        lines = [line for paragraph in cue['text'].splitlines() for line in
                                 (textwrap.wrap(paragraph, width=line_width, replace_whitespace=False,
                                                drop_whitespace=False) or [''])]
                        if len(lines) * font_size * 1.5 > height - 2 * margin_y:
                            raise ValueError('Subtitle is too long to fit the frame; split the cue in the subtitle editor')
                        text = '\n'.join(lines)
                        captions.append(f"{len(captions) + 1}\n{clock(cue['startMs'])} --> {clock(cue['endMs'])}\n{text}\n")
                (folder / 'captions.srt').write_text('\n'.join(captions), encoding='utf-8')
                execute([*base, '-i', 'captions.srt', 'captions.ass'], directory, emit, total, .7, 0)
                ass = folder / 'captions.ass'
                ass.write_text(ass.read_text(encoding='utf-8').replace('PlayResX: 384', f'PlayResX: {width}')
                               .replace('PlayResY: 288', f'PlayResY: {height}'), encoding='utf-8')
                style = (f'FontName=Noto Sans CJK SC,FontSize={font_size},Outline={max(1, round(min(width, height) / 360))},'
                         f'Shadow=0,MarginL={margin_x},MarginR={margin_x},MarginV={margin_y}')
                if settings['subtitleStyle'] == 'bold':
                    style += ',Bold=1'
                elif settings['subtitleStyle'] == 'box':
                    style += ',BorderStyle=3,BackColour=&H90000000'
                filters.append("subtitles=filename=captions.ass:fontsdir=fonts:force_style='" + style + "'")
            if settings['title'].strip():
                title = settings['title'].replace('\n', ' ').replace('\r', ' ')
                (folder / 'title.txt').write_text('\n'.join(textwrap.wrap(title, width=24)), encoding='utf-8')
                font = 'fonts/NotoSansCJKsc-Bold.otf'
                if not (folder / font).exists():
                    raise ValueError('Opening title requires the bundled CJK font')
                filters.append("drawtext=fontfile=" + font + ":textfile=title.txt:expansion=none:fontcolor=white:fontsize=h/24:borderw=2:x=(w-tw)/2:y=h/10:enable='lt(t,3)'")
            task_id = request.get('clipTaskId')
            if task_id:
                import uuid
                uuid.UUID(task_id)
                name = str(target.parent / ('.galaxy-clip-' + task_id + '.part.mp4'))
                descriptor = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            else:
                descriptor, name = tempfile.mkstemp(prefix='.galaxy-clip-', suffix='.part.mp4', dir=target.parent)
            os.close(descriptor)
            partial = Path(name)
            args = [*base, '-f', 'concat', '-safe', '1', '-i', str(folder / 'parts.txt'), '-map', '0:v:0']
            if settings['originalAudio']:
                args += ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k']
            else:
                args += ['-an']
            if filters:
                args += ['-vf', ','.join(filters), '-c:v', 'libx264', '-preset', 'ultrafast' if preview else 'fast', '-crf', '25' if preview else '20']
            else:
                args += ['-c:v', 'copy']
            args += ['-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', str(partial)]
            execute(args, directory, emit, total, .7, .28)
            result = inspect(ffmpeg, str(partial), details=True)
            if not result['video'] or abs(result['durationSeconds'] - total) > .15 or not partial.stat().st_size:
                raise ValueError('Rendered duration or video stream verification failed')
            if result['frameRate'] != 30 or result['sampleAspectRatio'] != '1/1' or result['audio'] != bool(settings['originalAudio']):
                raise ValueError('Rendered frame rate, pixels or audio verification failed')
            # Hard-link commit is atomic and fails if someone created the destination meanwhile.
            os.link(partial, target)
            emit('result', result={'durationMs': round(result['durationSeconds'] * 1000),
                                   'media': {key: result[key] for key in ('width', 'height', 'frameRate', 'audio')}})
    finally:
        if partial:
            partial.unlink(missing_ok=True)
