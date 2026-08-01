# Threat model

## Protected assets

- active and rotated log bytes;
- source ownership and mode;
- token/OIDC credentials;
- durable configuration, audit, and segment state;
- archive integrity and bounded storage capacity.

## Threats and controls

| Threat | Control |
| --- | --- |
| Traversal, symlink escape, malicious filename | Resolve canonical path, require regular non-symlink files, and enforce configured canonical roots. Segment filenames use service-generated UUIDs and UTC timestamps. |
| Arbitrary host control | No Docker socket, privileged mode, dynamic mounts, host PID by default, shell hooks, or broad discovery. Reopen callbacks are loopback-only; signal mode accepts only a fixed positive PID and three reopen signals in an explicitly shared namespace. |
| Credential disclosure | Runtime read-only digest file; no plaintext persistence; bounded error model; structured logs omit headers/bodies; UI keeps token within the tab. |
| Raw-log disclosure | No content/search/download endpoint; metrics and UI expose only sizes, state, time, identifiers, and bounded errors. |
| Browser request forgery | No cookie authentication; bearer header required for every mutation; restrictive CSP, frame denial, no third-party scripts. |
| Manifest or archive tampering | SHA-256 manifest, exclusive destination creation, independent read-back verification, immutable naming, non-destructive restore verification. |
| Malicious archive response | The local adapter rejects mismatched existing data. The S3 adapter requires signed requests, exclusive creation, checksum metadata and length verification, then re-downloads for restore proof. Failures retain retryable spool work. |
| Compromised producer directory | Narrow mounts, service UID/GID, canonical path policy, no recursive discovery, no log execution. A producer with write access can still corrupt its own bytes; checksums detect change only after rotation. |
| Spool exhaustion | Hard byte limit checked before rotation; warning/critical operational state; retry does not discard failures. Reserve filesystem capacity outside the service. |
| Token brute force | High-entropy tokens, constant-time digest comparison, request-size limits, and per-address rate limiting. Put TLS and network policy at ingress. |
| Compromised browser | Token lifetime is controlled by the issuer/operator and stored only in session storage. XSS surface is reduced by static same-origin assets and CSP. |

## Residual risks

- `copytruncate` has inherent write-window loss/duplication risk and requires explicit acknowledgement.
- A rename/create producer that ignores a failed reopen callback may continue writing the renamed inode; the service preserves the segment and reports a warning but cannot control that producer.
- One instance owns each state/spool set; sharing writable volumes across replicas is unsupported.
- Local archive storage is not off-site durability. Consumers must back it up or add a separately accepted remote adapter.
