"""A loopback-only webhook receiver for the README's local demo; not for production."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


class Handler(BaseHTTPRequestHandler):
    def respond(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 65536:
            self.send_error(413)
            return
        self.rfile.read(length)
        path = urlsplit(self.path).path
        attempt = int(self.headers.get("X-Scheduled-Attempt", "1"))
        run_id = self.headers.get("X-Scheduled-Run-Id", "unknown")
        if path == "/flaky":
            status = 503 if attempt <= 2 else 200
        elif path == "/fail":
            status = 503
        elif path == "/ok":
            status = 200
        else:
            status = 404
        message = f"run={run_id} attempt={attempt} status={status}\n".encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(message)))
        self.end_headers()
        self.wfile.write(message)
        print(message.decode().strip(), flush=True)

    do_GET = respond
    do_POST = respond
    do_PUT = respond
    do_PATCH = respond
    do_DELETE = respond

    def log_message(self, format, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description="Local-only demo webhook receiver")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9001)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Demo receiver listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
