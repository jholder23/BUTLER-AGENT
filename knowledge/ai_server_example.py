"""
Example server for PEEPEEDEE. Run your AI here.
Replace the placeholder with your actual model inference.

  python ai_server_example.py   # Listens on http://localhost:5000

PEEPEEDEE will POST to /chat with:
  { "messages": [{"role":"system","content":"..."},{"role":"user","content":"..."}], "model": "pepee" }

Return JSON: { "content": "..." } or { "message": { "content": "..." } }
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json

PORT = 5000


class ChatHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/chat":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            data = json.loads(body)
            messages = data.get("messages", [])
            # TODO: Replace with your model inference
            # output = your_model.generate(messages)
            output = "Replace this with your model's output. Connect your trained model here."
        except Exception as e:
            output = f"Error: {e}"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"content": output}).encode())

    def log_message(self, format, *args):
        print(f"[{self.address_string()}] {args[0]}")


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), ChatHandler)
    print(f"PEEPEEDEE AI server at http://localhost:{PORT}/chat")
    print("Replace the placeholder in ChatHandler with your model.")
    server.serve_forever()
