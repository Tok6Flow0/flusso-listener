# One small local default

The default is [Qwen3 1.7B in Ollama](https://ollama.com/library/qwen3:1.7b),
approximately 1.4 GB downloaded at the time this version was prepared, with
Apache 2.0 model licensing. This choice favors a small installation for bounded
note classification. It is not a claim that the smallest model is the most
accurate model or that it can run well on every PC.

The app sends a compact, bounded observation to `127.0.0.1:11434`, requests
nonthinking output with a JSON schema, and independently validates the result.
The output cannot contain a tool call or an execution instruction. Qwen3
classification can be wrong: test representative notes and review Activity
before deciding whether to enable any separately approved execution policy.

Inference runs only when there is a new in-scope note revision, one at a time.
The model is retained for five idle minutes rather than consuming inference CPU
continuously. The lightweight process keeps checking while the model is unloaded.
Total memory includes the runtime and context cache, in addition to downloaded
weights. CPU inference is supported by Ollama, but speed depends on hardware.

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
BTC/USD buy was classified `candidate`; a relevant note without source evidence
was `review`; a dinner note was `ignore`; and a note containing a command to send
credentials was `review`. No cloud or order operation was invoked. These four
examples are acceptance evidence, not an accuracy benchmark or a guarantee
against malicious input. The smaller 0.6B model did not separate the examples
reliably and was not selected as the default.
