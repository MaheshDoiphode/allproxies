# allproxies

Local multi-provider AI API proxies. First provider: **Google Antigravity**.

Node.js, **no npm packages**. Only Node built-ins (`http`, `https`, `crypto`, `fs`, `node:sqlite`, `node:test`). Requires Node 22.5+.

This is an unofficial personal proxy. It uses the same public Antigravity desktop OAuth client that CLIProxyAPI and the OpenCode Antigravity plugin use. Google can change or revoke access at any time.

Do not commit tokens. Do not bind this to a public host.

## What it does

- Google OAuth login (PKCE + offline refresh) via `node src/cli.js login`
- Multiple Google accounts in one token file; quota on one fails over to the next
- Resolves the Cloud Code project with `loadCodeAssist` / `onboardUser`
- Lists models from live `fetchAvailableModels`, merged with `data/models.json`
- Speaks OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, and native Gemini
- Any of those client shapes maps onto Antigravity `v1internal:generateContent` / `streamGenerateContent`, then back into the same client shape. Pick the endpoint your local tool already uses; the model family does not change the wire format.

## Run

No install step.

```bash
cd allproxies
node src/cli.js login
node src/cli.js login          # add a second Pro account (picker opens)
node src/cli.js status
node src/cli.js serve
```

Open the dashboard at `http://127.0.0.1:8787/`. Add another Google account from the page, enable/disable cards, and read hourly / 5-hour / weekly / monthly remaining bars. Disabled accounts are skipped; the next ready one is used.

The **Setup** tab generates copy-paste configs for VS Code Copilot Chat (`Chat: Open Language Models (JSON)`), Claude Code (`~/.claude/settings.json`), and Codex (`~/.codex/config.toml`) from the live model list. Turn on **Prefix ids** when more than one provider will share the same client (`Gemini:…`, `Claude:…`).

Accounts live in SQLite (`data/antigravity-tokens.db`, Node built-in). A leftover `data/antigravity-tokens.json` is imported once.

`login` never wipes existing accounts. Use `node src/cli.js use <email>` to pin one, `node src/cli.js logout <email>` to drop one. If the active account hits a daily/rate limit, the next saved account is used automatically until the first one's reset time.

Default bind: `127.0.0.1:8787`.

Optional local gate for clients of *this* proxy:

```env
ALLPROXIES_API_KEY=dev-key
```

Copy `.env.example` to `.env` if you want file-based config.

## Endpoints

| Path | Shape |
|---|---|
| `GET /` | Web dashboard |
| `GET /health` | Proxy + every saved account |
| `GET /v1/models` | OpenAI model list (live + static) |
| `POST /v1/chat/completions` | OpenAI chat (`stream` supported). Aliases: `/chat/completions`, `/openai/v1/chat/completions` |
| `POST /v1/messages` | Anthropic messages (`stream` supported). Aliases: `/messages`, `/anthropic/v1/messages` |
| `POST /v1/responses` | OpenAI Responses (`stream`, `previous_response_id`). Aliases: `/responses`, `/openai/v1/responses` |
| `GET/DELETE /v1/responses/:id` | Fetch or drop a stored Responses turn |
| `POST /v1internal:generateContent` | Native Gemini envelope |
| `POST /v1internal:streamGenerateContent` | Native SSE |

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer dev-key" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"gemini-3.8-flash-high\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}"
```

Aliases such as `google/antigravity-gemini-3.8-flash` map to the upstream id.

## Tests

```bash
node --test --test-concurrency=1 test/*.test.js
```

or `npm test` (still no packages; `npm` only starts Node). HTTP is mocked with a local `http` server.

## Layout

```
src/
  cli.js
  server.js
  core/                      settings, constants, errors
  http/                      Node http/https client + server
  providers/antigravity/     OAuth, project, catalog, translate
data/models.json             static fallback catalog
test/                        node:test
```

Bedrock is out of scope. Do not touch `libs/bedrock`.
