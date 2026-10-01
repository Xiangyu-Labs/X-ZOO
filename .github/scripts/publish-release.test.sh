#!/usr/bin/env bash
# Prove the publish rules of `publish-release.sh` against a real registry.
#
#   .github/scripts/publish-release.test.sh
#
# The images job publishes through that script, so the rules it claims are
# exercised here against a throwaway registry on loopback:
#
#   1. a first publish creates the tags and reports the digest;
#   2. republishing the same candidate is a no-op with the same digest;
#   3. a different candidate under the same commit aborts, and leaves every tag
#      it would have written exactly as it was;
#   4. a registry that cannot answer aborts instead of being read as "absent".
#
# Needs Docker with buildx. Nothing leaves the machine.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/publish-release.sh"
registry_port="${REGISTRY_PORT:-5569}"
registry_name="publish-release-test-$$"
registry="127.0.0.1:$registry_port"
image="$registry/shop"
tmp="$(mktemp -d)"
passed=0

cleanup() {
  docker rm -f "$registry_name" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

fail() {
  echo "publish rules verification failed: $1" >&2
  exit 1
}

pass() {
  passed=$((passed + 1))
  echo "ok - $1"
}

digest_of() { docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$1"; }

docker run -d --name "$registry_name" -p "$registry:5000" registry:2 >/dev/null
attempt=0
until curl -fsS "http://$registry/v2/" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || fail 'the local registry never answered'
  sleep 1
done

# Distinguishable images: different content, therefore different digests.
make_image() {
  local ref="$1" payload="$2" dir
  dir="$tmp/$(printf '%s' "$ref" | tr -c 'a-zA-Z0-9' '_')"
  mkdir -p "$dir"
  printf '%s\n' "$payload" >"$dir/payload.txt"
  printf 'FROM scratch\nCOPY payload.txt /payload.txt\n' >"$dir/Dockerfile"
  docker build -q -t "$ref" "$dir" >/dev/null
  docker push -q "$ref" >/dev/null
}

sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
amd64="$registry/candidate-amd64:sha-$sha-amd64"
arm64="$registry/candidate-arm64:sha-$sha-arm64"
make_image "$amd64" 'amd64-v1'
make_image "$arm64" 'arm64-v1'

# 1.
digest="$(bash "$script" tags "$image" "$sha" "$amd64" "$arm64" | tail -n1)"
[ -n "$digest" ] || fail 'the first publish reported no digest'
[ "$(digest_of "$image:sha-$sha")" = "$digest" ] || fail 'the reported digest is not what the tag holds'
pass "a first publish creates sha-$sha and reports its digest"

# 2.
again="$(bash "$script" tags "$image" "$sha" "$amd64" "$arm64")"
[ "$(printf '%s\n' "$again" | tail -n1)" = "$digest" ] || fail 'republishing the same candidate changed the digest'
printf '%s\n' "$again" | grep -q 'resumed without change' || fail 'republishing was not reported as a no-op'
pass 'republishing the same commit is a no-op with the same digest'

# 3. The conflicting sources carry the same tag names in other repositories, so
#    the script targets the same formal tags; none of them may move.
amd64_b="$registry/conflict-amd64:sha-$sha-amd64"
arm64_b="$registry/conflict-arm64:sha-$sha-arm64"
make_image "$amd64_b" 'amd64-v2'
make_image "$arm64_b" 'arm64-v2'
formal_amd64="$(digest_of "$image:sha-$sha-amd64")"
formal_arm64="$(digest_of "$image:sha-$sha-arm64")"
if bash "$script" tags "$image" "$sha" "$amd64_b" "$arm64_b" >"$tmp/conflict.log" 2>&1; then
  fail 'a different candidate was allowed to overwrite an existing tag'
fi
grep -q 'refusing a conflicting release' "$tmp/conflict.log" || fail 'the conflict refusal did not explain itself'
grep -q 'already held' "$tmp/conflict.log" || fail 'the conflict refusal did not name the digest it found'
[ "$(digest_of "$image:sha-$sha-amd64")" = "$formal_amd64" ] || fail 'the refused publish moved the amd64 tag'
[ "$(digest_of "$image:sha-$sha-arm64")" = "$formal_arm64" ] || fail 'the refused publish moved the arm64 tag'
[ "$(digest_of "$image:sha-$sha")" = "$digest" ] || fail 'the refused publish moved the commit tag'
pass 'a conflicting candidate fails the publish and moves no tag'

# 4.
dead="127.0.0.1:$((registry_port + 1))"
if curl -fsS "http://$dead/v2/" >/dev/null 2>&1; then
  fail "port $dead unexpectedly answered; set REGISTRY_PORT"
fi
if bash "$script" tags "$dead/shop" "$sha" "$amd64" >"$tmp/unreachable.log" 2>&1; then
  fail 'a publish to an unreachable registry reported success'
fi
grep -q 'refusing to guess' "$tmp/unreachable.log" || fail 'the unreachable case did not explain itself'
pass 'an unanswerable registry query aborts instead of guessing'

echo "publish rules verification passed ($passed checks)"
