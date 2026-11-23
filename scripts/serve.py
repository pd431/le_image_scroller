#!/usr/bin/env python3
"""Serve the project folder and open the start page in the browser.

    python3 scripts/serve.py            # port 8000, or the next free one
    python3 scripts/serve.py --port 9000 --no-browser

The server is read-only: it answers GET and HEAD and nothing else. Image
stacks you choose on the start page are kept in the browser, not sent
here. Stop it with Ctrl-C.
"""

import argparse
import functools
import http.server
import os
import socket
import sys
import threading
import webbrowser

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PORT_TRIES = 20


class ReadOnlyHandler(http.server.SimpleHTTPRequestHandler):
    """Static files only. Caching is off so an edited file or a freshly
    installed package shows up on reload."""

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _refuse(self):
        self.send_error(405, "This server is read-only")

    do_POST = do_PUT = do_DELETE = do_PATCH = _refuse

    def log_message(self, fmt, *args):  # keep the terminal quiet
        if args and str(args[1] if len(args) > 1 else "").startswith(("4", "5")):
            super().log_message(fmt, *args)


class Server(http.server.ThreadingHTTPServer):
    # Without this, Windows lets two servers share a port and the "next
    # free port" fallback would never trigger there.
    allow_reuse_address = False
    daemon_threads = True


def make_server(port, root=ROOT, host="127.0.0.1", tries=PORT_TRIES):
    """Bind `port`, or the next free port after it. Returns the server."""
    handler = functools.partial(ReadOnlyHandler, directory=root)
    last_error = None
    for candidate in range(port, port + tries):
        try:
            return Server((host, candidate), handler)
        except OSError as err:
            last_error = err
    raise OSError(f"No free port between {port} and {port + tries - 1}: {last_error}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--port", type=int, default=8000, help="first port to try (default 8000)")
    parser.add_argument("--host", default="127.0.0.1",
                        help="address to listen on (default 127.0.0.1; use 0.0.0.0 to share on your network)")
    parser.add_argument("--no-browser", action="store_true", help="don't open the browser")
    args = parser.parse_args(argv)

    try:
        server = make_server(args.port, host=args.host)
    except OSError as err:
        print(err, file=sys.stderr)
        return 1

    port = server.server_address[1]
    shown_host = "localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host
    url = f"http://{shown_host}:{port}/"
    if port != args.port:
        print(f"Port {args.port} is in use; using {port} instead.")
    print(f"Serving {ROOT}")
    print(f"Open {url}   (Ctrl-C to stop)")
    if args.host == "0.0.0.0":
        try:
            print(f"On your network: http://{socket.gethostbyname(socket.gethostname())}:{port}/")
        except OSError:
            pass
    if not args.no_browser:
        threading.Timer(0.3, webbrowser.open, args=(url,)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
