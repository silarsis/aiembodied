"""python -m memory_engine [serve|migrate] [--database-url ...] [--host 127.0.0.1] [--port 8194]"""

from __future__ import annotations

import argparse
import logging
import os

DEFAULT_DATABASE_URL = "postgresql://memory@127.0.0.1:5433/memory"


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="memory_engine", description=__doc__)
    ap.add_argument("command", nargs="?", choices=["serve", "migrate"], default="serve",
                    help="serve the HTTP API (default), or only apply database migrations and exit")
    ap.add_argument("--database-url", default=os.environ.get("MEMORY_DATABASE_URL", DEFAULT_DATABASE_URL),
                    help="PostgreSQL connection string: the local container, or a Supabase project's "
                         "direct or session-pooler connection (MEMORY_DATABASE_URL)")
    ap.add_argument("--schema", default=os.environ.get("MEMORY_SCHEMA", "memory"),
                    help="schema that holds the engine's tables (MEMORY_SCHEMA)")
    ap.add_argument("--host", default=os.environ.get("MEMORY_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("MEMORY_PORT", "8194")))
    ap.add_argument("--embedder", choices=["fastembed", "fake", "off"],
                    default=os.environ.get("MEMORY_EMBEDDER", "fastembed"),
                    help="fastembed: a local model on the CPU (default); fake: hashed words, for wiring; "
                         "off: full-text search only (MEMORY_EMBEDDER)")
    ap.add_argument("--embed-model", default=os.environ.get("MEMORY_EMBED_MODEL", "BAAI/bge-small-en-v1.5"),
                    help="fastembed model; must make 384-dimension vectors (MEMORY_EMBED_MODEL)")
    ap.add_argument("--log-level", default="info")
    a = ap.parse_args(argv)

    logging.basicConfig(level=a.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # Keep the password out of the logs.
    logging.getLogger("psycopg.pool").setLevel(logging.WARNING)

    if a.command == "migrate":
        import psycopg

        from . import db

        with psycopg.connect(a.database_url, autocommit=True) as conn:
            applied = db.migrate(conn, a.schema)
            print(f"schema {a.schema} at version {db.schema_version(conn)}; applied {applied or 'nothing'}")
        return

    import uvicorn

    from .app import Engine, create_app

    api_token = os.environ.get("MEMORY_API_TOKEN") or None
    if a.host not in ("127.0.0.1", "localhost", "::1") and not api_token:
        logging.getLogger("memory_engine").warning(
            "Listening on %s without MEMORY_API_TOKEN: anyone who can reach this port can read memory.", a.host
        )
    from .embed import make_embedder

    engine = Engine(a.database_url, a.schema, embedder=make_embedder(a.embedder, a.embed_model))
    uvicorn.run(create_app(engine, api_token=api_token), host=a.host, port=a.port, log_level=a.log_level.lower())


if __name__ == "__main__":
    main()
