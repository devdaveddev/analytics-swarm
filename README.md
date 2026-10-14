# Analytics Swarm

A multi-agent business analytics dashboard. Enter company data (metrics, reviews, documents, optional live
source URLs) or run the built-in test data. Up to eight agents run in an order you control: collector, parser,
analyzer, refiner, lead generation, forecaster, consultant and visualizer. The result is an interactive dashboard
with KPIs, a revenue outlook, a relationship graph, sentiment, insights, prioritised recommendations, an
"Ask your data" panel, and a feedback loop that learns from corrections.

## Pages

| Page | What it does |
|---|---|
| **Analysis Demo** (`/new`) | Opens with test data pre-filled. Edit it, paste your own, or upload files, then run the swarm. |
| **API Key** (`/settings`) | Choose the model provider. Ollama is the default and needs no key. OpenAI-compatible and Anthropic are available with a key. |
| **Agents** (`/agents`) | n8n-style editor: drag agents to change the order, remove optional ones, add them back. The order is validated against each agent's dependencies. |

### Uploading files

The Analysis Demo form accepts **.csv, .tsv, .xlsx, .docx, .txt and .md** files (up to 4 MB each). A sheet with a month column and a revenue
column fills the monthly metrics (customers, marketing spend, leads, conversions and churn are picked up when present, and common
alternative column names are recognised). A sheet with a review, comment or feedback column adds reviews, with a rating column if there is one.
Each sheet of an Excel workbook is classified on its own, and Excel date values are converted to months. Word, text and Markdown files are
added as documents. Uploaded reviews and documents replace the sample text on the first upload and are added to it after that. PDF and the old
.xls and .doc formats are refused with a message saying what to export instead. Files are parsed on the server with no extra dependencies, and
the same validation and personal-data redaction apply as for typed data.

### Model answers and temperature

The written summary, custom agents and **Ask your data** all use the model you chose on the API Key page. There is no rule-based fallback: if no
model is available, Ask says how to enable one. The **temperature** setting (0 to 1) controls how closely the model sticks to the figures. Lower
values, around 0.1 to 0.3, are consistent and factual. Higher values are more varied. It is set on the API Key page and can be changed for a
single question on the dashboard. Ask is given the monthly series, KPI definitions, industry benchmarks, insights, feature-area sentiment and a
few short review excerpts, and it keeps the last few questions so follow-ups work. A small local model on a CPU can still be slow or inaccurate, and Ollama
needs free memory to load it; the dashboard shows the reason when a call fails.

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
ollama pull qwen2.5:1.5b
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server |
| `OLLAMA_MODEL` | `qwen2.5:1.5b` | Model for narrative and Ask |
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
