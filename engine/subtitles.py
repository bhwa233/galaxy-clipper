"""Platform subtitle fetching, timeline composition and ASS burn-in layout.

Ported from Galaxy Downloader 0.8.0 (engine/subtitles.py), where subtitle
processing lived before it moved to Galaxy Clipper. Every path is chosen and
authorized by Electron main; yt-dlp is only imported for the fetch operation.
"""
import html
import re
import subprocess
import unicodedata
from pathlib import Path


def milliseconds(value):
    hours, minutes, seconds, fraction = re.split(r'[:,.]', value)
    return ((int(hours) * 60 + int(minutes)) * 60 + int(seconds)) * 1000 + int(fraction.ljust(3, '0')[:3])


def timestamp(value, ass=False):
    hours, remainder = divmod(value, 3600000)
    minutes, remainder = divmod(remainder, 60000)
    seconds, fraction = divmod(remainder, 1000)
    return f'{hours}:{minutes:02}:{seconds:02}.{fraction // 10:02}' if ass else f'{hours:02}:{minutes:02}:{seconds:02},{fraction:03}'


def read_cues(filename, normalize):
    text = Path(filename).read_text(encoding='utf-8-sig')
    cues = []
    for block in re.split(r'\r?\n\s*\r?\n', text.strip()):
        lines = block.splitlines()
        timing = next((index for index, line in enumerate(lines) if '-->' in line), None)
        if timing is None:
            continue
        match = re.match(r'(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)', lines[timing])
        if not match:
            continue
        body = html.unescape(re.sub(r'<[^>]*>', '', '\n'.join(lines[timing + 1:]))).strip()
        start, end = map(milliseconds, match.groups())
        if body and end > start:
            cues.append((start, end, body))
    cues.sort(key=lambda cue: cue[0])
    if normalize:
        cues = [(start, min(end, cues[index + 1][0]) if index + 1 < len(cues) else end, body)
                for index, (start, end, body) in enumerate(cues)]
    return [cue for cue in cues if cue[1] > cue[0]]


def write_srt(filename, cues):
    Path(filename).write_text(''.join(f'{index}\n{timestamp(start)} --> {timestamp(end)}\n{body}\n\n'
                                      for index, (start, end, body) in enumerate(cues, 1)), encoding='utf-8')


def subtitle_intervals(tracks):
    # Sweep cue boundaries rather than pairing lines: translations often split a
    # sentence differently. Active Chinese lines always precede active English.
    events = {}
    for language, cues in enumerate(tracks):
        for index, (start, end, body) in enumerate(cues):
            events.setdefault(start, []).append((language, index, body))
            events.setdefault(end, []).append((language, index, None))
    points = sorted(events)
    active = [{} for _ in tracks]
    result = []
    for index, start in enumerate(points[:-1]):
        for language, key, body in events[start]:
            if body is None:
                active[language].pop(key, None)
            else:
                active[language][key] = body
        bodies = ['\n'.join(dict.fromkeys(track.values())) for track in active]
        if not any(bodies):
            continue
        end = points[index + 1]
        if result and result[-1][1] == start and result[-1][2] == bodies:
            result[-1] = (result[-1][0], end, bodies)
        else:
            result.append((start, end, bodies))
    return result


def compose_bilingual(chinese, english):
    return [(start, end, '\n'.join(body for body in bodies if body))
            for start, end, bodies in subtitle_intervals((chinese, english))]


def wrap_caption(body, size, width):
    # The bundled libass may lack Unicode line breaking. Supply safe CJK breaks
    # explicitly and keep Latin words together; libass can refine Latin wrapping.
    # Noto's ASS em is about 0.67 of the requested size; use a little spare width.
    limit = max(1, (width - 144) / (size * 0.75))
    tokens = re.findall(r"[A-Za-z0-9_]+(?:['’\-][A-Za-z0-9_]+)*|\s+|.", body)

    def units(text):
        return sum(1 if unicodedata.east_asian_width(char) in ('W', 'F') or char in 'MW@'
                   else 0.3 if char in " ilI'.,!:;|"
                   else 0.4 if char in 'fjrt()[]'
                   else 0.65 for char in text)
    lines, line, used = [], '', 0
    for token in tokens:
        # Split unusually long words/URLs as well, instead of clipping them.
        pieces = list(token) if units(token) > limit else [token]
        for piece in pieces:
            length = units(piece)
            if line and used + length > limit and piece not in '，。！？；：、,.!?;:)]}”’':
                lines.append(line.strip())
                line, used = '', 0
            if not line and piece.isspace():
                continue
            line += piece
            used += length
    if line.strip():
        lines.append(line.strip())
    return r'\N'.join(lines)


def paginate_caption(start, end, body, max_lines=2):
    lines = body.split(r'\N')
    pages = [r'\N'.join(lines[index:index + max_lines]) for index in range(0, len(lines), max_lines)]
    if len(pages) == 1:
        return [(start, end, body)]
    # Keep every word inside the source cue's time range, with longer pages
    # receiving proportionally more time. ASS has centisecond precision.
    if end - start < len(pages) * 10:
        raise ValueError('Subtitle text is too long for its timing; cannot split it without losing text')
    weights = [max(1, len(page.replace(r'\N', '').replace(' ', ''))) for page in pages]
    total, used, cursor = sum(weights), 0, start
    result = []
    for index, (page, weight) in enumerate(zip(pages, weights)):
        used += weight
        boundary = end if index == len(pages) - 1 else min(end - (len(pages) - index - 1) * 10,
                                                         max(cursor + 10, start + round((end - start) * used / total)))
        result.append((cursor, boundary, page))
        cursor = boundary
    return result


def write_ass(filename, tracks, source_width, source_height):
    """Bottom-centred Noto Sans CJK SC Bold, zh 64 / other 60 on a 1080p short edge."""
    source_width, source_height = source_width or 1920, source_height or 1080
    scale = 1080 / min(source_width, source_height)
    width, height = max(320, round(source_width * scale)), max(320, round(source_height * scale))
    header = f'''[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK SC,64,&H00FFFFFF,&H00FFFFFF,&H00251B12,&H60251B12,-1,0,0,0,100,100,0,0,1,3,1.5,2,72,72,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
    lines = []
    languages = list(tracks)
    prepared = []
    for language, cues in tracks.items():
        pages = []
        for start, end, body in cues:
            body = ' '.join(body.split())
            body = body.replace('\\', '＼').replace('{', '｛').replace('}', '｝')
            size = 64 if language == 'zh' else 60
            pages.extend(paginate_caption(start, end, wrap_caption(body, size, width)))
        prepared.append(pages)
    # Split each source language before sweeping boundaries, so another
    # language's cue changes cannot restart a long sentence's pagination.
    for start, end, bodies in subtitle_intervals(prepared):
        # Overlapping source cues can exceed the cap even after each cue was
        # split. Cap their combined display as well without discarding text.
        pages = [paginate_caption(start, end, body.replace('\n', r'\N')) for body in bodies]
        for page_start, page_end, page_bodies in subtitle_intervals(pages):
            rows = []
            for language, body in zip(languages, page_bodies):
                size = 64 if language == 'zh' else 60
                # Reserve the missing row during temporary bilingual gaps.
                rows.append(f'{{\\fs{size}}}' + (body or r'\h'))
            body = r'\N'.join(rows)
            lines.append(f'Dialogue: 0,{timestamp(page_start, True)},{timestamp(page_end, True)},Default,,0,0,0,,{body}\n')
    Path(filename).write_text(header + ''.join(lines), encoding='utf-8')


def downloader_class():
    from yt_dlp import YoutubeDL

    class SubtitleDownloader(YoutubeDL):
        """Per requested language: manual captions first, automatic only when allowed."""

        def __init__(self, options, languages):
            self.languages = languages
            self.automatic_keys = set()
            super().__init__(options)

        def process_subtitles(self, video_id, normal_subtitles, automatic_captions):
            manual = normal_subtitles or {}
            automatic = (automatic_captions or {}) if self.params.get('writeautomaticsub') else {}
            available = {**automatic, **manual}
            chosen = []
            for prefix in self.languages[:5]:
                preferences = ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'zh-TW'] if prefix == 'zh' else ['en', 'en-orig', 'en-US', 'en-GB'] if prefix == 'en' else [prefix]
                candidates = [key for key in available if key.lower() == prefix.lower() or key.lower().startswith(prefix.lower() + '-') or key.removeprefix('ai-').lower() == prefix.lower()]
                candidates.sort(key=lambda key: (key not in manual, preferences.index(key) if key in preferences else len(preferences), key))
                if candidates and candidates[0] not in chosen:
                    chosen.append(candidates[0])
            self.automatic_keys = {key for key in chosen if key not in manual}
            previous = self.params.get('subtitleslangs')
            self.params['subtitleslangs'] = [re.escape(key) for key in chosen] or ['(?!)']
            try:
                return super().process_subtitles(video_id, manual, automatic)
            finally:
                self.params['subtitleslangs'] = previous

        def _write_subtitles(self, info_dict, filename):
            # One caption CDN refusal must not lose the other languages. The
            # caller reports an error only when no track could be saved.
            previous = self.params.get('ignoreerrors')
            self.params['ignoreerrors'] = True
            try:
                return super()._write_subtitles(info_dict, filename)
            finally:
                self.params['ignoreerrors'] = previous

    return SubtitleDownloader


class Logger:
    def __init__(self, emit):
        self.emit = emit

    def debug(self, message):
        if not message.startswith('[debug]'):
            self.emit('log', message=message)

    def info(self, message):
        self.emit('log', message=message)

    def warning(self, message):
        self.emit('log', message=message)

    def error(self, message):
        self.emit('log', message=message)


def fetch(request, emit):
    """Save the chosen platform subtitle tracks as normalised SRT files."""
    url = request['url']
    if not re.match(r'^https?://', url, re.IGNORECASE):
        raise ValueError('Enter an http or https video URL')
    destination = Path(request['output'])
    destination.mkdir(parents=True, exist_ok=True)
    languages = request.get('captionLanguages') or ['zh', 'en']
    options = {
        'logger': Logger(emit), 'quiet': True, 'no_warnings': False, 'cachedir': False,
        'socket_timeout': 30, 'retries': 3, 'noplaylist': True,
        # Only caption files are fetched, so missing or PO-token-gated media
        # formats must not abort extraction.
        'skip_download': True, 'ignore_no_formats_error': True, 'writesubtitles': True,
        'writeautomaticsub': bool(request.get('subtitleAutoGenerated', True)),
        'subtitleslangs': languages, 'subtitlesformat': 'srt/vtt/best',
        'outtmpl': str(destination / 'platform.%(ext)s'),
        'ffmpeg_location': request.get('ffmpeg'),
        'js_runtimes': {'node': {'path': request['node']}} if request.get('node') else {},
    }
    youtube_language = {'zh': 'zh-CN', 'en': 'en'}.get(request.get('locale', ''))
    if youtube_language:
        options['extractor_args'] = {'youtube': {'lang': [youtube_language]}}
    emit('processing', status='platform-captions', progress=0)
    with downloader_class()(options, languages) as ydl:
        info = ydl.extract_info(url, download=True)
        if info.get('_type') == 'playlist' or info.get('entries') is not None:
            raise ValueError('Enter the URL of a single video, not a playlist')
        tracks = []
        for language, track in (info.get('requested_subtitles') or {}).items():
            filename = track.get('filepath')
            if not filename or not Path(filename).is_file():
                continue
            srt = destination / f'platform.{len(tracks)}.srt'
            if track.get('ext') == 'srt':
                Path(filename).replace(srt)
            else:
                converted = subprocess.run([request['ffmpeg'], '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
                                            '-i', filename, str(srt)], capture_output=True)
                Path(filename).unlink(missing_ok=True)
                if converted.returncode or not srt.is_file():
                    continue
            cues = read_cues(srt, bool(request.get('subtitleNormalizeOverlaps', True)))
            if not cues:
                srt.unlink(missing_ok=True)
                continue
            write_srt(srt, cues)
            tracks.append({'language': language, 'file': str(srt), 'automatic': language in ydl.automatic_keys})
    emit('result', result={'tracks': tracks, 'title': info.get('title'), 'url': info.get('webpage_url') or url})
