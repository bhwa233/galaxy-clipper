import re
import unicodedata
from bisect import bisect_right


def _glyph_width(char):
    if unicodedata.combining(char):
        return 0
    if unicodedata.east_asian_width(char) in ('W', 'F') or char in 'MW@\\{}':
        return 1
    return .4 if char.isspace() or char in "ilI'.,!:;|" else .72


def _wrapped_lines(text, limit):
    for paragraph in text.splitlines():
        tokens = re.findall(r"[A-Za-z0-9_]+(?:['’\-][A-Za-z0-9_]+)*|.", ' '.join(paragraph.split()))
        tokens = [piece for token in tokens for piece in (
            list(token) if sum(map(_glyph_width, token)) > limit else [token])]
        line, used, suggested = [], 0, 0
        for token in tokens:
            if not line and token.isspace():
                continue
            width = sum(map(_glyph_width, token))
            if line and used + width > limit and not token.isspace():
                boundary = suggested if suggested and token[0] not in '，。！？；：、,.!?;:)]}”’' else len(line)
                if boundary == len(line) and token[0] in '，。！？；：、,.!?;:)]}”’' and len(line) > 1:
                    boundary -= 1
                yield ''.join(line[:boundary]).strip()
                line = line[boundary:]
                used, suggested = sum(_glyph_width(char) for piece in line for char in piece), 0
                if line and used + width > limit:
                    yield ''.join(line).strip()
                    line, used = [], 0
            line.append(token)
            used += width
            if used >= limit * .65 and (token.isspace() or token[-1] in '，。！？；：、,.!?;:'):
                suggested = len(line)
        if line and (body := ''.join(line).strip()):
            yield body


def _spoken(text):
    return ''.join(char for char in text.lower() if char.isalnum())


def _word_boundaries(cue):
    parts, positions, times = [], [], []
    offset = 0
    for word in cue.get('words') or []:
        part = _spoken(word['text'])
        if not part:
            continue
        if times and word['startMs'] < times[-1][0]:
            return [], []
        parts.append(part)
        positions.append(offset)
        times.append((word['startMs'], max(word['startMs'], word['endMs']), len(part)))
        offset += len(part)
    if not parts or ''.join(parts) != _spoken(cue['text']):
        return [], []
    return positions, times


def layout_clip_captions(cues, canvas_width, font_size, margin, max_lines=2):
    max_lines = max(1, min(2, max_lines))
    limit = max(2, (canvas_width - 2 * margin) / max(1, font_size))
    groups = []
    for cue in sorted(cues, key=lambda item: item['startMs']):
        start, end = cue['startMs'], cue['endMs']
        if end <= start or not cue['text'].strip():
            continue
        if groups and start < groups[-1][1]:
            previous_start, previous_end, members = groups[-1]
            members.append(cue)
            groups[-1] = (previous_start, max(previous_end, end), members)
        else:
            groups.append((start, end, [cue]))

    previous_end = 0
    for start, end, members in groups:
        body = '\n'.join(cue['text'] for cue in members)
        lines = list(_wrapped_lines(body, limit))
        pages = [lines[index:index + max_lines] for index in range(0, len(lines), max_lines)]
        if not pages:
            continue
        weights = [max(1, len(''.join(page).replace(' ', ''))) for page in pages]
        positions, times = _word_boundaries(members[0]) if len(members) == 1 else ([], [])
        start_tick = max(previous_end, start // 10)
        end_tick = end // 10
        if end_tick - start_tick < len(pages):
            raise ValueError('Subtitle text is too long for its timing; cannot split it without losing text')
        duration, total_weight = end_tick - start_tick, sum(weights)
        min_ticks = max(1, min(20, duration // (2 * len(pages))))
        cursor, consumed, spoken = start_tick, 0, 0
        for index, (page, weight) in enumerate(zip(pages, weights)):
            remaining = len(pages) - index - 1
            consumed += weight
            spoken += len(_spoken(''.join(page)))
            target = start_tick + round(duration * consumed / total_weight)
            if remaining and positions and 0 < spoken < positions[-1] + times[-1][2]:
                word_index = bisect_right(positions, spoken) - 1
                word_start, word_end, word_length = times[word_index]
                anchor = round((word_start + (word_end - word_start) * (spoken - positions[word_index]) / word_length) / 10)
                if start_tick < anchor < end_tick:
                    target = anchor
            boundary = min(end_tick - remaining * min_ticks, max(cursor + min_ticks, target)) if remaining else end_tick
            text = r'\N'.join(line.replace('\\', '＼').replace('{', '｛').replace('}', '｝') for line in page)
            yield cursor * 10, boundary * 10, text
            cursor = boundary
        previous_end = end_tick
