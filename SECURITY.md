# Security policy

## Supported versions

Only the latest released minor version receives security fixes until a stable support policy is published.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for this repository. Do not open a public issue containing exploit details, credentials, raw logs, or affected deployment identifiers.

Include the affected image digest/version, reproduction using synthetic data, impact, and any proposed mitigation. Maintainers will acknowledge a report within five business days, coordinate validation and remediation privately, and publish an advisory when a fix is available.

## Deployment expectations

Run the image by immutable digest, non-root, with a read-only root filesystem, all capabilities dropped, narrow explicit mounts, runtime-injected authentication material, TLS at ingress, and no Docker socket. Treat state, spool, archive, and producer mounts as sensitive.

