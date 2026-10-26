"""Markdown (the reports written by tools/make_*_report.py) -> DokuWiki syntax.
Usage: python -I tools/md2doku.py <in.md> [out.txt]"""
import re, sys

def conv(md):
    out, header_next = [], False
    lines = md.split('\n')
    for i, ln in enumerate(lines):
        m = re.match(r'^(#{1,5})\s+(.*)$', ln)
        if m:
            n = 7 - len(m.group(1))                     # # -> ======, ## -> =====, ...
            out.append('=' * n + ' ' + m.group(2).strip() + ' ' + '=' * n)
            continue
        if re.match(r'^\|\s*-{3,}', ln):                 # table separator row
            continue
        if ln.startswith('|'):
            cells = [c.strip() for c in ln.strip().strip('|').split('|')]
            nxt = lines[i + 1] if i + 1 < len(lines) else ''
            if re.match(r'^\|\s*-{3,}', nxt):           # header row
                out.append('^ ' + ' ^ '.join(cells) + ' ^')
            else:
                out.append('| ' + ' | '.join(c if c else ' ' for c in cells) + ' |')
            continue
        m = re.match(r'^(\s*)[-*]\s+(.*)$', ln)
        if m:
            depth = len(m.group(1)) // 2 + 1
            out.append('  ' * depth + '* ' + m.group(2))
            continue
        m = re.match(r'^(\s*)\d+\.\s+(.*)$', ln)
        if m:
            depth = len(m.group(1)) // 2 + 1
            out.append('  ' * depth + '- ' + m.group(2))
            continue
        out.append(ln)
    s = '\n'.join(out)
    s = re.sub(r'`([^`]+)`', r"''\1''", s)              # inline code
    return s

src = sys.argv[1]
dst = sys.argv[2] if len(sys.argv) > 2 else re.sub(r'\.md$', '', src) + '.dokuwiki.txt'
open(dst, 'w', encoding='utf-8').write(conv(open(src, encoding='utf-8').read()))
print(dst)
