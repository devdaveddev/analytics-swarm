# Analytics Swarm

A multi-agent business analytics dashboard. Enter company data (metrics, reviews, documents, optional live
source URLs) or run the built-in test data. Up to eight agents run in an order you control: collector, parser,
analyzer, refiner, lead generation, forecaster, consultant and visualizer. The result is an interactive dashboard
with KPIs, a revenue outlook, a relationship graph, sentiment, insights, prioritised recommendations, an
"Ask your data" panel, and a feedback loop that learns from corrections.

## Pages

| Page | What it does |
|---|---|
| **Analysis Demo** (`/new`) | Opens with test data pre-filled. Edit it or paste your own, then run the swarm. |
| **API Key** (`/settings`) | Choose the model provider. Ollama is the default and needs no key. OpenAI-compatible and Anthropic are available with a key. |
| **Agents** (`/agents`) | n8n-style editor: drag agents to change the order, remove optional ones, add them back. The order is validated against each agent's dependencies. |

### Custom agents and guidance

On the Agents page you can create up to five **custom agents**. Each has a name and the instructions (prompt) it runs with, and the
dashboard shows its answer in a "Custom agents" section. A custom agent sees the KPIs, insights, sentiment, recommendations, forecast and
document summaries from the agents before it, plus notes from earlier custom agents. Your instructions are passed as trusted text; the
analysis data is passed separately and marked untrusted, so text inside reviews or documents cannot act as instructions. Custom agents need a
model (Ollama or an API key); without one they are skipped and the dashboard says so. A **guidance** box adds your own instructions to the
Consultant's written summary. Custom agents and guidance are stored in the browser and sent with each analysis.

API keys are stored in the browser only and sent with each analysis. The server keeps them in memory for that job,
never writes them to disk, and never returns them. A saved workflow order is also kept in the browser.

## Run locally

```
npm start            # http://localhost:3000
npm test
```

Optional local AI narrative and Q&A via [Ollama](https://ollama.com):

```
ollama serve
ollama pull qwen2.5:3b
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server |
| `OLLAMA_MODEL` | `qwen2.5:3b` | Model for narrative and Ask |
| `OLLAMA_TIMEOUT_MS` | `90000` | Model call timeout |
| `OLLAMA_DISABLED` | unset | Set to `1` for rule-based answers only |
| `MAX_CONCURRENT` | `3` | Parallel analyses |

## Deploy on Render

`render.yaml` is a Render Blueprint. In the Render dashboard choose **New > Blueprint**, select this repository,
and deploy. The health check is `/api/health`. The free plan has no persistent disk, so feedback and jobs reset
on redeploy and the instance sleeps when idle.

## Notes

- There is no login. Anyone who can reach the server can run analyses and submit feedback.
- Live source fetching blocks private and loopback addresses and honours robots.txt.
- The revenue outlook is a straight-line trend, not a seasonal forecast.
