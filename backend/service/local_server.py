"""Minimal local HTTP server for exercising the 7 per-service Lambda
handlers without deploying to AWS. Never used in production -- API Gateway
invokes each Lambda directly there (see backend/terraform/api.tf's
local.api_routes, which this file's routing table mirrors). This exists
purely so the frontend dev server (or curl) can talk to a real backend
during local development/testing.

Usage:
    cd backend/service
    python3 local_server.py [port]   # defaults to 8787

Then set frontend/.env.local's VITE_API_BASE_URL=http://localhost:8787
(see frontend/.env.example) and `npm run dev`.
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, urlsplit

_CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
}


def _load_handler(service_dir: str):
    """Loads {service_dir}/handler.py's `handler` function by file path --
    needed because "decision-generator-worker" has a hyphen and isn't a
    valid Python package/module name for a normal `import`."""
    module_name = f"_local_server_{service_dir.replace('-', '_')}_handler"
    if module_name in sys.modules:
        return sys.modules[module_name].handler
    path = f"{service_dir}/handler.py"
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module.handler


# Mirrors backend/terraform/api.tf's local.api_routes -- (method, regex) ->
# service directory. Named capture groups become event["pathParameters"].
_ROUTES: list[tuple[str, re.Pattern, str]] = [
    ("GET", re.compile(r"^/api/city-state$"), "city_state"),
    ("POST", re.compile(r"^/api/incidents$"), "incident"),
    ("GET", re.compile(r"^/api/incidents/(?P<eventId>[^/]+)/report$"), "report"),
    ("GET", re.compile(r"^/api/decisions$"), "decision"),
    ("POST", re.compile(r"^/api/chat/messages$"), "chat"),
    ("POST", re.compile(r"^/api/publication$"), "publication"),
]


class _Handler(BaseHTTPRequestHandler):
    def _dispatch(self, method: str) -> None:
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length).decode("utf-8") if length else None

        split = urlsplit(self.path)
        query = dict(parse_qsl(split.query)) or None

        # Not a production route (not in api.tf) -- real callers never read
        # either bucket this way (citizens go through CloudFront for the
        # public one; the internal one is never exposed to a browser at
        # all, only read by the Lambdas themselves). This exists purely so
        # data/api-test.html can inspect what actually landed in S3 during
        # local dev -- incidents/, decisions/ (internal) or manifest.json/
        # notices/ (public) -- without needing real AWS credentials in the
        # browser or a deployed CloudFront distribution yet. s3-list is the
        # same idea but for listing keys under a prefix (list_objects_v2)
        # instead of fetching one known key.
        if method == "GET" and split.path == "/_dev/s3-object":
            self._serve_dev_s3_object(query)
            return
        if method == "GET" and split.path == "/_dev/s3-list":
            self._serve_dev_s3_list(query)
            return

        for route_method, pattern, service_dir in _ROUTES:
            if method != route_method:
                continue
            match = pattern.match(split.path)
            if not match:
                continue
            event = {
                "rawPath": split.path,
                "requestContext": {"http": {"method": method}},
                "body": body,
                "queryStringParameters": query,
                "pathParameters": match.groupdict() or None,
            }
            result = _load_handler(service_dir)(event, None)
            self._write(result)
            return

        self._write({"statusCode": 404, "body": '{"error": "not found"}'})

    def _serve_dev_s3_object(self, query: dict | None) -> None:
        key = (query or {}).get("key")
        bucket_choice = (query or {}).get("bucket", "internal")
        if not key:
            self._write({"statusCode": 400, "body": json.dumps({"error": "missing query param: 'key'"})})
            return
        if bucket_choice not in ("internal", "public"):
            self._write({"statusCode": 400, "body": json.dumps({"error": "query param 'bucket' must be 'internal' or 'public'"})})
            return
        try:
            import s3_common

            bucket = s3_common.internal_bucket() if bucket_choice == "internal" else s3_common.public_bucket()
            obj = s3_common.client().get_object(Bucket=bucket, Key=key)
            self._write({
                "statusCode": 200,
                "headers": {"content-type": "application/json; charset=utf-8"},
                "body": obj["Body"].read().decode("utf-8"),
            })
        except Exception as exc:  # noqa: BLE001 - report as 404, not a server crash
            self._write({"statusCode": 404, "body": json.dumps({"error": str(exc)})})

    def _serve_dev_s3_list(self, query: dict | None) -> None:
        bucket_choice = (query or {}).get("bucket", "internal")
        prefix = (query or {}).get("prefix", "")
        if bucket_choice not in ("internal", "public"):
            self._write({"statusCode": 400, "body": json.dumps({"error": "query param 'bucket' must be 'internal' or 'public'"})})
            return
        try:
            import s3_common

            bucket = s3_common.internal_bucket() if bucket_choice == "internal" else s3_common.public_bucket()
            s3 = s3_common.client()
            keys: list[dict] = []
            continuation = None
            while True:
                kwargs = {"Bucket": bucket, "Prefix": prefix}
                if continuation:
                    kwargs["ContinuationToken"] = continuation
                page = s3.list_objects_v2(**kwargs)
                for obj in page.get("Contents", []):
                    keys.append({
                        "key": obj["Key"],
                        "size": obj["Size"],
                        "lastModified": obj["LastModified"].isoformat(),
                    })
                if not page.get("IsTruncated"):
                    break
                continuation = page.get("NextContinuationToken")
            keys.sort(key=lambda item: item["key"])
            self._write({
                "statusCode": 200,
                "headers": {"content-type": "application/json; charset=utf-8"},
                "body": json.dumps({"bucket": bucket, "prefix": prefix, "keys": keys}),
            })
        except Exception as exc:  # noqa: BLE001 - report as 404, not a server crash
            self._write({"statusCode": 404, "body": json.dumps({"error": str(exc)})})

    def _write(self, result: dict) -> None:
        self.send_response(result["statusCode"])
        for key, value in {**result.get("headers", {}), **_CORS_HEADERS}.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(result.get("body", "").encode("utf-8"))

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
