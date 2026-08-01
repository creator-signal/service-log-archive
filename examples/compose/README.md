# Local synthetic example

The committed credential is deliberately non-secret and is accepted only for this local example:

```text
local-development-only
```

Create a synthetic log and start the service:

```sh
printf 'event-1\nevent-2\n' > examples/compose/logs/application.log
docker compose pull
docker compose up -d
```

Open <http://127.0.0.1:8080>, connect using the local token, and register `/logs/application.log`. The service has no Docker socket, host discovery, cloud credentials, or consumer-specific configuration.

The default Compose file consumes the public `v0.2.0` image by immutable multi-architecture digest. Contributors can instead build the checkout with:

```sh
docker compose -f compose.yaml -f compose.build.yaml up --build -d
```

For a real deployment, replace the token file with a read-only runtime secret containing SHA-256 token digests and place TLS at the ingress boundary. Do not reuse the synthetic credential.
