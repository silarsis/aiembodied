# SearXNG for web search

The assistant's `web_search` tool can use a local [SearXNG](https://docs.searxng.org/) instance,
the Brave Search API, or both. SearXNG is free and needs no key, but it relies on upstream
engines (DuckDuckGo, Brave, Wikipedia and so on) that sometimes throttle a home IP. Brave has its
own index and a $5 monthly free credit (about 1,000 searches), so it makes a good fallback.

## Setup

1. Install Docker Desktop. SearXNG does not run natively on Windows.
2. Add to `.env` in the repo root:

   ```ini
   WEB_SEARCH_PROVIDER=searxng,brave   # tried in order; use just one if you like
   SEARXNG_URL=http://127.0.0.1:8888   # the default
   BRAVE_SEARCH_API_KEY=...            # from https://api-dashboard.search.brave.com
   ```

3. `pnpm dev:run` starts the container when `WEB_SEARCH_PROVIDER` includes `searxng` and nothing
   answers at `SEARXNG_URL`. To start it by hand: `services\searxng\scripts\start.ps1`.

Check it with `curl "http://127.0.0.1:8888/search?q=test&format=json"`.

## Notes

- `settings.yml` here is copied to `%LOCALAPPDATA%\aiembodied\searxng` on each start, because the
  container writes into its config folder. Run `start.ps1 -Recreate` after changing it.
- JSON output and a disabled limiter are the two settings the tool needs. Without JSON, SearXNG
  answers 403 and the tool says so.
- The container listens on 127.0.0.1 only.
- With `searxng,brave`, SearXNG gets 4 s and Brave is tried when SearXNG fails, times out or
  returns nothing. Brave's key stays in the main process and never reaches the renderer.
