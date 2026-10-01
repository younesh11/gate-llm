# Versioning and releases

Application version is defined in package.json. Semantic Versioning uses MAJOR.MINOR.PATCH. During 0.x development, MINOR may introduce breaking changes; PATCH preserves documented behavior. Git tags are `vX.Y.Z`; npm, PyPI and image tags use the same X.Y.Z. SQLite's PRAGMA user_version is a separate migration number.

## Prepare

```sh
npm version patch --no-git-tag-version
node scripts/sync-version.mjs
# Add the new version's CHANGELOG.md entry and update installation version examples. Docker/Python versions sync automatically.
npm ci
npm test
npm run test:python
npm run check:version
npm run pack:release
npm run check:package
npm run test:package
npm run package:python
python -m build packaging/python --outdir artifacts/python
python -m twine check artifacts/python/*
docker build --build-arg VERSION=X.Y.Z -t gate-llm:X.Y.Z .
```

Use `python -m venv .venv-release` and install `build twine` inside it when those tools are unavailable. Inspect the npm manifest, wheel/sdist contents, checksums and release notes before publication. Artifact packaging includes no data directory, .env file, provider credential or encryption key. The Python wheel bundles runtime dependencies, so regenerate it after every npm dependency change.

Commit the reviewed source and tag the commit: `git tag -a vX.Y.Z -m 'GATE X.Y.Z'`. Do not tag an unreviewed or dirty tree. The configured repository is https://github.com/younesh11/gate-llm; create it before publication.

## Publish

These commands publish publicly and require ownership/access to the chosen names. Package-name availability checks do not reserve names.

```sh
npm login
npm publish artifacts/npm/gate-llm-X.Y.Z.tgz --access public
python -m twine upload artifacts/python/gate_llm-X.Y.Z*
# Selected container registry namespace:
docker tag gate-llm:X.Y.Z ghcr.io/younesh11/gate-llm:X.Y.Z
docker push ghcr.io/younesh11/gate-llm:X.Y.Z
```

Use npm/PyPI trusted publishing from CI where possible. Do not put publishing tokens in source or paste them into issue threads. Configure the actual registry namespace and credentials using the registry's login or repository secrets/settings.

## GitHub workflows

`ci.yml` checks tests, packaging and the Python distribution, and builds the container on pull requests and main. `release.yml` runs only through manual workflow dispatch, verifies the selected `vX.Y.Z` tag against package.json, and uploads artifacts. Publishing npm, PyPI and GHCR is separately opt-in through boolean inputs; all default to false.

Before enabling publication:

- Create `younesh11/gate-llm` on GitHub and configure its remote.
- Create a protected `release` environment with appropriate reviewers.
- For npm, provide an authorized NPM_TOKEN repository/environment secret or migrate that step to configured trusted publishing.
- For PyPI, register a trusted publisher with the repository, release.yml workflow and `release` environment.
- For GHCR, the workflow uses GITHUB_TOKEN with packages:write and publishes to the repository's lowercase owner/name. Configure package visibility deliberately.

The workflow produces version and major.minor container tags only when container publication is explicitly enabled. No public registry release is implied by a local Git tag, wheel, tarball or image.
