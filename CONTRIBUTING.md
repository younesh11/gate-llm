# Contributing

Use Node.js 24 LTS and Python 3.10+ for the Python launcher. Keep changes focused and document externally visible behavior in CHANGELOG.md.

```sh
npm ci
npm run dev
# In another terminal:
npm run dev:ui
```

The backend defaults to http://127.0.0.1:4310 and Vite to http://127.0.0.1:5173. Set `DATA_DIR=./data/development` to keep development state explicit. Use `npm run demo` only for simulated local testing; its credentials are public.

Before proposing a change:

```sh
npm test
npm run test:python
npm run pack:release
npm run check:package
npm run test:package
npm run check:version
```

Run Docker checks when deployment behavior changes. `npm run build` type-checks and compiles the server and frontend. Package smoke tests use temporary state and execute from a directory outside the source checkout. They must never use a real provider key.

Keep provider credentials, databases, encryption keys and .env files out of commits, fixtures, logs and packages. Use mock providers in tests. If authentication, streaming or accounting behavior changes, test failures and cancellations as well as success. Runtime dependencies are bundled in releases, so rebuild artifacts after updating package-lock.json.

A maintainer reviews changes before merging. No remote repository is configured by default; add the repository URL and issue/security contact when hosting this project. Contributions are provided under the project's MIT license.
