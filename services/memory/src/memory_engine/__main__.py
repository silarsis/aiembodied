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
    ap.add_argument("--llm-url", default=os.environ.get("MEMORY_LLM_URL", "http://127.0.0.1:1234/v1"),
                    help="OpenAI-compatible endpoint for background summaries and fact extraction; "
                         "'off' disables them (MEMORY_LLM_URL)")
    ap.add_argument("--llm-model", default=os.environ.get("MEMORY_LLM_MODEL", "qwen-next-flash"),
                    help="model name to ask for (MEMORY_LLM_MODEL)")
    ap.add_argument("--timezone", default=os.environ.get("MEMORY_TIMEZONE") or None,
                    help="IANA time zone for day/week/month summaries, e.g. Australia/Melbourne; "
                         "default: this machine's current offset (MEMORY_TIMEZONE)")
    ap.add_argument("--session-quiet-minutes", type=float,
                    default=float(os.environ.get("MEMORY_SESSION_QUIET_MINUTES", "10")),
                    help="a conversation is summarised once it has been quiet this long")
    ap.add_argument("--idle-seconds", type=float, default=float(os.environ.get("MEMORY_IDLE_SECONDS", "120")),
                    help="background LLM work waits until the client has been idle this long")
    ap.add_argument("--settings-file", default=os.environ.get("MEMORY_SETTINGS_FILE") or None,
                    help="where the choice of database and mirror is saved (MEMORY_SETTINGS_FILE); "
                         "default %%LOCALAPPDATA%%/aiembodied/memory/engine-settings.json; 'none' to not save")
    ap.add_argument("--ha-url", default=os.environ.get("HA_URL") or None,
                    help="Home Assistant address, e.g. http://homeassistant-1:8123; unset: no Home Assistant (HA_URL). "
                         "The access token is read from HA_TOKEN only, never from the command line")
    ap.add_argument("--ha-home-id", default=os.environ.get("HA_HOME_ID", "home"),
                    help="id this Home Assistant is stored under (HA_HOME_ID)")
    ap.add_argument("--ha-home-name", default=os.environ.get("HA_HOME_NAME", "Home"),
                    help="its display name (HA_HOME_NAME)")
    ap.add_argument("--ha-label", default=os.environ.get("HA_LABEL", "aiembodied"),
                    help="watch the entities that carry this Home Assistant label (HA_LABEL)")
    ap.add_argument("--ha-entities", default=os.environ.get("HA_ENTITIES", ""),
                    help="also watch these entity ids or domain.* patterns, comma separated (HA_ENTITIES)")
    ap.add_argument("--ha-raw-days", type=float, default=float(os.environ.get("HA_RAW_DAYS", "7")),
                    help="keep raw sensor readings this many days; hourly rollups and changes are kept (HA_RAW_DAYS)")
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

    from datetime import timedelta

    from .llm import make_llm
    from .summaries import Summariser, resolve_timezone

    llm = make_llm(a.llm_url, a.llm_model, os.environ.get("MEMORY_LLM_API_KEY") or None)
    summariser = (
        Summariser(
            llm,
            resolve_timezone(a.timezone),
            session_quiet=timedelta(minutes=a.session_quiet_minutes),
            idle_seconds=a.idle_seconds,
        )
        if llm
        else None
    )
    from pathlib import Path

    from .storage import default_settings_file

    settings_file = None if (a.settings_file or "").lower() == "none" else Path(a.settings_file or default_settings_file())
    from .home import homes_from_env

    # The command-line options (which default to the environment) override the default home's
    # variables; the HA_<NAME>_* homes come from the environment alone. Tokens are read from the
    # environment only, never from the command line.
    environ = dict(os.environ)
    for key, value in (
        ("HA_URL", a.ha_url),
        ("HA_HOME_ID", a.ha_home_id),
        ("HA_HOME_NAME", a.ha_home_name),
        ("HA_LABEL", a.ha_label),
        ("HA_ENTITIES", a.ha_entities),
        ("HA_RAW_DAYS", str(a.ha_raw_days)),
    ):
        if value:
            environ[key] = value
    home_configs = homes_from_env(environ)
    for config in home_configs:
        if config.off_reason:
            logging.getLogger("memory_engine").warning("Home Assistant (%s) is off: %s", config.home_id, config.off_reason)
    engine = Engine(
        a.database_url,
        a.schema,
        embedder=make_embedder(a.embedder, a.embed_model),
        summariser=summariser,
        settings_file=settings_file,
        home_configs=home_configs,
    )
    uvicorn.run(create_app(engine, api_token=api_token), host=a.host, port=a.port, log_level=a.log_level.lower())


if __name__ == "__main__":
    main()
