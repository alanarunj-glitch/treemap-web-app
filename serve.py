from __future__ import annotations

import argparse
import functools
import http.server
import socketserver
import webbrowser
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the treemap web app locally.")
    parser.add_argument("--host", default="127.0.0.01", help="Host to bind to. Default: 127.0.0.01")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind to. Default: 8000")
    parser.add_argument(
        "--open",
        action="store_true",
        help="Open the app in your default browser after the server starts.",
    )
    args = parser.parse_args()

    app_dir = Path(__file__).resolve().parent
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(app_dir))

    with socketserver.TCPServer((args.host, args.port), handler) as httpd:
        url = f"http://{args.host}:{args.port}/index.html"
        print(f"Serving treemap web app at {url}")
        if args.open:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")


if __name__ == "__main__":
    main()
