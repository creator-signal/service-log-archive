#!/usr/bin/env bash
# Existing public CI only: consume the pinned public release in its disposable
# local Docker daemon. No production identity, network, source or data is used.
set -euo pipefail
mkdir -p .tmp
fixture="$(mktemp -d "$PWD/.tmp/released.XXXXXX")"
name="log-archive-released-${GITHUB_RUN_ID:?Native CI run required}"
cleanup() {
  result=$?
  trap - EXIT
  if ! docker rm -fv "$name" >/dev/null 2>&1; then
    if docker inspect "$name" >/dev/null 2>&1; then result=1; fi
  fi
  case "$fixture" in "$PWD"/.tmp/released.*) rm -rf -- "$fixture" ;; *) result=1 ;; esac
  exit "$result"
}
trap cleanup EXIT
image="$(docker compose config --format json | node --input-type=module -e '
  import {readFileSync} from "node:fs";
  const image=JSON.parse(readFileSync(0,"utf8")).services["log-archive"].image;
  if(!/^ghcr\.io\/creator-signal\/service-log-archive@sha256:[a-f0-9]{64}$/.test(image))throw new Error("Pinned release required");
  process.stdout.write(image);
')"
node --input-type=module -e '
  import {writeFileSync} from "node:fs";import {createHash} from "node:crypto";
  writeFileSync(process.argv[1],JSON.stringify({tokens:[{id:"release-fixture",role:"administrator",sha256:createHash("sha256").update("synthetic-release-fixture-token").digest("hex")}]}),{mode:0o644});
' "$fixture/tokens.json"
docker pull "$image" >/dev/null
docker run -d --name "$name" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m -p 127.0.0.1::8080 \
  --volume /var/lib/log-archive/state --volume /var/lib/log-archive/spool \
  --volume /var/lib/log-archive/archive --volume /logs \
  --mount "type=bind,source=$fixture/tokens.json,target=/run/secrets/log-archive-api-tokens.json,readonly" \
  "$image" >/dev/null
address="$(docker port "$name" 8080/tcp)"
[[ "$address" =~ ^127\.0\.0\.1:[1-9][0-9]*$ ]]
base="http://$address"
for attempt in $(seq 1 30); do
  curl --fail --silent "$base/readyz" >/dev/null && break
  test "$attempt" -lt 30
  sleep 2
done
docker exec "$name" node --input-type=module -e '
  import assert from "node:assert/strict";import {writeFile} from "node:fs/promises";
  assert.equal(process.getuid(),10001);assert.equal(process.getgid(),10001);
  await writeFile("/logs/released.jsonl","{\"sequence\":0}\n{\"sequence\":1}\n");
'
curl --fail --silent --show-error "$base/api/v1/sources" \
  -H 'authorization: Bearer synthetic-release-fixture-token' -H 'content-type: application/json' \
  --data '{"id":"released-fixture","path":"/logs/released.jsonl","strategy":"rename-create","maxBytes":1,"intervalSeconds":0,"format":"jsonl","enabled":false}' > "$fixture/source.json"
curl --fail --silent --show-error -X POST "$base/api/v1/sources/released-fixture/rotate" \
  -H 'authorization: Bearer synthetic-release-fixture-token' > "$fixture/segment.json"
segment="$(node --input-type=module -e '
  import {readFileSync} from "node:fs";
  const id=JSON.parse(readFileSync(process.argv[1],"utf8")).segmentId;
  if(!/^[a-f0-9-]{36}$/.test(id))throw new Error("Segment identity denied");process.stdout.write(id);
' "$fixture/segment.json")"
curl --fail --silent --show-error "$base/api/v1/restore-verifications" \
  -H 'authorization: Bearer synthetic-release-fixture-token' -H 'content-type: application/json' \
  --data "{\"segmentId\":\"$segment\"}" > "$fixture/restore.json"
node --input-type=module -e '
  import assert from "node:assert/strict";import {readFileSync} from "node:fs";
  const value=JSON.parse(readFileSync(process.argv[1],"utf8"));assert.equal(value.result,"passed");assert.equal(value.restoredRecords,2);
' "$fixture/restore.json"
before="$(docker exec "$name" node -e 'const fs=require("node:fs"),crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync("/var/lib/log-archive/state/state.json")).digest("hex"))')"
set +e
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --volumes-from "$name" "$image" > "$fixture/contender.log" 2>&1
contender_status=$?
set -e
test "$contender_status" -eq 75
grep -q 'service.ownership_denied' "$fixture/contender.log"
after="$(docker exec "$name" node -e 'const fs=require("node:fs"),crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync("/var/lib/log-archive/state/state.json")).digest("hex"))')"
test "$before" = "$after"
printf '%s\n' '{"schema":"log-archive.published-consumption/v1","immutableImage":true,"nonRoot":true,"rotation":true,"restore":true,"competingOwnerDenied":true,"stateUnchangedByContender":true}'
