"""Local server for the simulator: serves _BattleSim with UTF-8 charsets (sim.html has no <meta charset>,
because the claude.ai artifact skeleton adds one; a plain http.server would make browsers guess EUC-KR).
Usage: python tools/serve.py [port]"""
import http.server, os, sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map, **{
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
    })

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f'LO Battle Simulator: http://localhost:{port}  (Ctrl+C or close this window to stop)')
    # Windows: SO_REUSEADDR lets a second server bind a busy port and steal requests; refuse instead.
    http.server.ThreadingHTTPServer.allow_reuse_address = False
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
