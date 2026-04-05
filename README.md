# Context Snake

Context Snake is a spatial research workspace where autonomous snake agents move through a 2D knowledge map, gather evidence, collaborate through sub-agents, and turn messy exploration into readable reports.

This version is **BYOK-first**:
- users bring their own OpenAI, Anthropic, or Google Gemini API key
- keys stay in the browser's local storage
- the app proxies requests through a lightweight Node server

## What It Does

- Turns questions into iterative research loops: plan, search, merge, reflect, synthesize
- Shows research as interactive bubbles on a canvas instead of a flat chat log
- Lets users run multiple agents side by side without broadcasting commands to all of them
- Generates markdown-style final reports with source links
- Auto-caches sessions in the browser like conversation history
- Supports OpenAI, Anthropic, and Gemini model selection per agent

## Why BYOK

Context Snake is designed so the app owner does **not** pay for user token usage.

Each user:
- selects a provider
- pastes their own API key
- runs research on their own account

The hosted server does **not** need your own provider API keys for this mode.

## Local Development

Install dependencies:

```bash
npm install
```

Run the proxy/server:

```bash
npm start
```

In another terminal, run the Vite dev server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Local behavior:
- the frontend runs on port `3000`
- the proxy runs on port `8010`
- provider calls go through `http://localhost:8010/openai`, `/anthropic`, `/google`, and `/preview`

## Production Build

Build the app:

```bash
npm run build
```

Run the production server:

```bash
npm start
```

Open [http://localhost:8010](http://localhost:8010).

Production behavior:
- the Node server serves `dist/`
- the frontend automatically uses same-origin `/openai`, `/anthropic`, `/google`, and `/preview`
- the server respects the platform `PORT` environment variable

For stricter browser access control in production, set:

```bash
ALLOWED_ORIGINS=https://your-domain.com
```

## Deployment

This repo is ready to deploy as a **single Node web service**.

### Render

A basic Render blueprint is included in [render.yaml](render.yaml).

Render setup:
- build command: `npm install && npm run build`
- start command: `npm start`
- runtime: Node 20

Recommended production setting:
- `ALLOWED_ORIGINS=https://your-domain.com`

## User Onboarding

When a new user opens the app:
- a setup bubble explains BYOK mode
- they pick OpenAI, Anthropic, or Google Gemini
- they paste a personal API key into Agent Config
- the onboarding bubble disappears once a key is saved

## Main Interactions

- Click a result bubble to open the final report
- Double-click a source bubble to open the source URL
- Select a snake before using the input box
- Use `+ Fresh` to create a clean agent with no hidden context
- Use `Clear ctx` to reset one snake without deleting map bubbles
- Hover bubbles to peek at richer previews

## Architecture

Frontend:
- React + Vite
- canvas-based spatial UI
- browser-local session persistence

Backend:
- lightweight Node server in [proxy.js](proxy.js)
- static asset serving for `dist/`
- provider proxy routes
- metadata preview route for links

Provider routes:
- `/openai/*`
- `/anthropic/*`
- `/google/*`
- `/preview?url=...`

## Repository Files

- [src/App.jsx](src/App.jsx): main app and agent logic
- [proxy.js](proxy.js): production server and provider proxy
- [render.yaml](render.yaml): Render deployment blueprint

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
