# SearXNG for web search

The assistant's `web_search` tool can use a local [SearXNG](https://docs.searxng.org/) instance,
the Brave Search API, or both. SearXNG is free and needs no key, but it relies on upstream
engines (DuckDuckGo, Brave, Wikipedia and so on) that sometimes throttle a home IP. Brave has its
own index and a $5 monthly free credit (about 1,000 searches), so it makes a good fallback.

## Setup

1. SearXNG runs in a Linux container. The start script uses `wslc`, the container runtime built
   into WSL 2.9.3 and later (`wsl --update`), and falls back to Docker Desktop when `wslc` is
   missing. Set `SEARXNG_RUNTIME=docker` (or `wslc`) to choose.
2. Nothing else is needed for SearXNG alone: `WEB_SEARCH_PROVIDER` defaults to `searxng`, and
   `pnpm dev:run` starts the container when nothing answers at `SEARXNG_URL`. To start it by
   hand: `services\searxng\scripts\start.ps1`. If SearXNG is down, the tool reports that search
   is unavailable and the assistant says it could not look it up.
3. Optional settings in `.env` in the repo root:

   ```ini
   WEB_SEARCH_PROVIDER=searxng,brave   # tried in order; "off" disables web search
   SEARXNG_URL=http://127.0.0.1:8888   # the default
   BRAVE_SEARCH_API_KEY=...            # from https://api-dashboard.search.brave.com
   ```

Check it with `curl "http://127.0.0.1:8888/search?q=test&format=json"`.

## Notes

- `settings.yml` here is copied to `%LOCALAPPDATA%\aiembodied\searxng` on each start, because the
  container writes into its config folder. The container is recreated on each start, so a changed
  port or settings file applies the next time it starts.
- The first `wslc run` in a new WSL container session can take a minute or two while the image
  downloads and the VM boots; the app picks SearXNG up once it answers.
- JSON output and a disabled limiter are the two settings the tool needs. Without JSON, SearXNG
  answers 403 and the tool says so.
- The container listens on 127.0.0.1 only.
- With `searxng,brave`, SearXNG gets 4 s and Brave is tried when SearXNG fails, times out or
  returns nothing. Brave's key stays in the main process and never reaches the renderer.
