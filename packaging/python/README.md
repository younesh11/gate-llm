# GATE — Python launcher

A self-hosted LLM gateway with virtual keys, budgets, combined token limits, provider routing, input guardrails, and a dashboard.

This Python distribution launches the TypeScript/Node application. **Python 3.10+ and Node.js 22.13+ are required; Node.js 24 LTS is recommended.** The compiled server, dashboard and runtime dependencies are bundled. It does not install Node, use npm at startup, or download application code at runtime. Docker is the alternative if you do not want Node installed locally.

After this release is published:

```sh
python -m pip install gate-llm
gate-llm serve --port 4310
```

For an unpublished local build, install its `.whl` file instead. Open http://127.0.0.1:4310 and create your owner account. Use `gate-llm --help` for configuration flags. The same command is also provided by the npm package; choose one launcher per environment.

Persistent data defaults to `~/.gate-llm`. Set `--data-dir` or `DATA_DIR` explicitly when upgrading an existing installation. The bundled runtime is extracted into `~/.cache/gate-llm`; `GATE_RUNTIME_DIR` changes that location. Never use the runtime cache as your data directory.

The application uses one SQLite database writer per data directory. Back up the entire data directory, including `encryption.key`, with the gateway stopped. Configure HTTPS before sharing access beyond your own machine.

MIT licensed. Bedrock's native Converse/IAM adapter is not included in this release.
