# Contributing

Contributions are welcome through pull requests.

1. Open or reference an issue that defines the provider-neutral behavior and acceptance boundary.
2. Branch from `develop` and keep the change focused.
3. Add synthetic tests for success, failure, restart/idempotency, authorization, and content/secret non-disclosure where relevant.
4. Run `npm ci`, `npm run check`, `docker compose config --quiet`, and `docker build .`.
5. Update `openapi.yaml`, documentation, migrations, and `CHANGELOG.md` for contract changes.

Do not add consumer domains, paths, resource identifiers, credentials, real logs, Docker-socket access, privileged execution, or dynamic host mounts. Public CI must remain fork-safe and independent of production secrets.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

