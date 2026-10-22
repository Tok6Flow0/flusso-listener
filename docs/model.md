# One small local default

The default is [Qwen3 1.7B in Ollama](https://ollama.com/library/qwen3:1.7b),
approximately 1.4 GB downloaded at the time this version was prepared, with
Apache 2.0 model licensing. This choice favors a small installation for bounded
note classification. It is not a claim that the smallest model is the most
accurate model or that it can run well on every PC.

The desktop app bundles a pinned llama.cpp CPU engine and downloads the exact
Q4_K_M GGUF named in `desktop/resources.json`. Both engine archives and model
weights are checked against pinned size and SHA-256 values. A verified matching
Ollama cache file can be copied without changing the user's Ollama installation.
The engine binds a random IPv4 loopback port with a per-process random API key.
The key is supplied through a private temporary file and removed after startup;
Journal content and credentials never enter process arguments or model logs.

Each scheduled check and Check now re-review the newest selected watching/reviewed
research note, including unchanged notes. Other new watching revisions retain their
existing revision checks. Calls run one at a time in a bounded
4,096-token context. Nonthinking JSON-schema output is validated again by the
app. The model stays loaded until the desktop app exits. Total memory includes
the runtime, context cache, Electron and the OS; recommend at least 8 GB of system
RAM and test on the actual computer. There is no cloud inference fallback.

The advanced browser/CLI path instead sends compact observations to local
Ollama at `127.0.0.1:11434`; it retains the model for five idle minutes. Neither
runtime exposes tools, HTTP clients, shell commands, or credentials to the model.
Classification can be wrong. It only flags notes for review in Activity; it
never creates, approves or places an order. Orders come only from explicit
`flusso-orders` tickets that code validates against your limits; position closes
use explicit `flusso-close` tickets with exact owned position IDs. Both paths
publish validation and receipt events without waiting for model classification.
The Listener streams the engine's public JSON answer into Model output through
the existing authenticated local status resource. Partial text cannot become an
accepted decision until the engine's completion marker and schema checks pass.
Operation-stage messages are kept separately in the collapsed Operations log. The model runs with thinking
disabled; internal reasoning is not requested or recorded.

[Ollama's FAQ](https://docs.ollama.com/faq) documents loopback defaults, memory
behavior and local-only mode. Keep `OLLAMA_HOST=127.0.0.1:11434` and configure
`OLLAMA_NO_CLOUD=1` or `disable_ollama_cloud: true` in Ollama's own configuration.
Do not change its global settings automatically if other apps depend on it;
apply the local-only option deliberately and restart Ollama. Flusso Listener
never selects a cloud model or sends inference prompts to Flusso.

[Structured output documentation](https://docs.ollama.com/capabilities/structured-outputs)
explains Ollama's schema feature. A well-formed JSON response is not proof that
its classification is accurate. Code-enforced source/section filters and server
execution limits remain independent of that response.

## Release acceptance sample

On 12 October 2026 the default, with the shipped prompt and a 4,096-token
context, was exercised locally with four synthetic notes. A matching structured
buy observation was classified `candidate`; a relevant note without source evidence
was `review`; a dinner note was `ignore`; and a note containing a command to send
credentials was `review`. No cloud or order operation was invoked. These four
examples are acceptance evidence, not an accuracy benchmark or a guarantee
against malicious input. The smaller 0.6B model did not separate the examples
reliably and was not selected as the default.
