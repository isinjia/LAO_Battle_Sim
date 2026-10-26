"""Tiny local receiver: the browser POSTs JSON to http://127.0.0.1:8799/<name>.json and it is saved to tools/out/<name>.json.
Used to hand crawled guide data from a Chrome tab to the simulator. Only listens on 127.0.0.1.
Usage: python -I tools/receive.py"""
import http.server, os, re

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')


class H(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        # relay page: another tab postMessage()s {name, data}; this page POSTs it back to this server (same origin)
        page = (b"<!doctype html><meta charset=utf-8><title>receiver</title><pre id=o>ready</pre><script>"
                b"addEventListener('message',async e=>{try{const m=e.data;const r=await fetch('/'+m.name,{method:'POST',headers:{'Content-Type':'application/json'},body:m.data});"
                b"document.getElementById('o').textContent+='\n'+m.name+' '+r.status+' '+m.data.length;e.source&&e.source.postMessage({ok:m.name,status:r.status},'*');}catch(x){document.getElementById('o').textContent+='\nERR '+x;}});"
                b"</script>")
        self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.end_headers(); self.wfile.write(page)

    def do_POST(self):
        name = os.path.basename(self.path.split('?')[0]) or 'data.json'
        if not re.match(r'^[\w.-]+\.json$', name):
            self.send_response(400); self._cors(); self.end_headers(); return
        n = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(n)
        with open(os.path.join(OUT, name), 'wb') as f:
            f.write(body)
        self.send_response(200); self._cors(); self.end_headers(); self.wfile.write(b'ok')
        print('saved', name, len(body), flush=True)


http.server.HTTPServer(('127.0.0.1', 8799), H).serve_forever()
