"""Galaxy Clipper's local media engine. No network extractors or download operations."""
import json
import sys
import errno

for stream in (sys.stdin, sys.stdout, sys.stderr):
    stream.reconfigure(encoding='utf-8', errors='strict' if stream is sys.stdin else 'backslashreplace')

def emit(kind, **data):
    print(json.dumps({'kind': kind, **data}, ensure_ascii=False), flush=True)

def main():
    request = json.load(sys.stdin)
    operation = request.get('operation')
    if operation == 'version':
        emit('result', result={'version': 'clipper-1'})
    elif operation == 'clip-render':
        from clipping import run
        run(request, emit)
    elif operation in ('unpack', 'inspect', 'audio', 'audio-chunk', 'embedded-captions', 'render'):
        from media_processing import run
        run(request, emit)
    else:
        raise ValueError('Unsupported clipper operation')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        details = {'code': errno.errorcode[error.errno]} if isinstance(error, OSError) and error.filename and error.errno in errno.errorcode else {}
        emit('error', message=str(error), **details)
        sys.exit(1)
