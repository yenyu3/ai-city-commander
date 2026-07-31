"""Minimal local HTTP server for exercising handler.py without deploying to
AWS. Never used in production -- API Gateway invokes handler.handler
directly there (see backend/terraform/lambda.tf). This exists purely so the
frontend dev server (or curl) can talk to a real backend during local
development/testing.

Usage:
    cd backend/service
    python3 local_server.py [port]   # defaults to 8787

Then set frontend/.env.local's VITE_API_BASE_URL=http://localhost:8787
(see frontend/.env.example) and `npm run dev`.
"""
from __future__ import annotations

import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, urlsplit

from handler import handler as lambda_handler

_CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
}


class _Handler(BaseHTTPRequestHandler):
    def _dispatch(self, method: str) -> None:
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length).decode("utf-8") if length else None

        split = urlsplit(self.path)
        query = dict(parse_qsl(split.query)) or None

        event = {
            "rawPath": split.path,
            "requestContext": {"http": {"method": method}},
            "body": body,
            "queryStringParameters": query,
        }
        result = lambda_handler(event, None)

        self.send_response(result["statusCode"])
        for key, value in {**result.get("headers", {}), **_CORS_HEADERS}.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(result["body"].encode("utf-8"))

    def do_GET(self) -> None:  # noqa: N802 - required BaseHTTPRequestHandler name
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def do_OPTIONS(self) -> None:  # noqa: N802 - CORS preflight
        self.send_response(204)
        for key, value in _CORS_HEADERS.items():
            self.send_header(key, value)
        self.end_headers()

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"[local_server] {self.address_string()} - {fmt % args}\n")


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    server = ThreadingHTTPServer(("127.0.0.1", port), _Handler)
    print(f"[local_server] listening on http://127.0.0.1:{port} (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
