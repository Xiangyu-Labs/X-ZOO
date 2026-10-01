#!/usr/bin/env bash
# The three images CI published for a commit, as digests.
#
#   shop resolve <40-hex commit>
#
# CI's `images` job publishes every master commit it built as
# `<repository>:sha-<commit>` (REL-001), a tag it never moves. This pulls the
# three tags and prints what each one resolved to, one `role=repo@sha256:…`
# line per role, which is what `shop upgrade` takes: an upgrade is always given
# digests, never the tag.
#
# The repositories are the ones `deployment.env` already pins, so a host knows
# where its images come from without a second setting. Pulling is the one way
# of reading a digest that needs nothing a Docker host does not already have,
# and it is what the upgrade would do next anyway.
#
# Exit codes: 0 all three resolved · 1 one could not be pulled or read · 2 misuse.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
. "$here/../common.sh"

commit=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help)
      sed -n '2,17p' "$0"
      exit 0
      ;;
    -*)
      warn "unknown argument: $1"
      exit 2
      ;;
    *)
      [ -z "$commit" ] || {
        warn 'give one commit'
        exit 2
      }
      commit="$1"
      ;;
  esac
  shift
done

[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || {
  warn "a full 40-character commit is required, got: ${commit:-nothing}"
  exit 2
}

require_settings

for role in web worker edge; do
  key="NEXT_$(printf '%s' "$role" | tr '[:lower:]' '[:upper:]')_IMAGE"
  repo="$(setting "$key")"
  repo="${repo%%@*}"
  # Only a colon after the last `/` is a tag; one before it is a registry port.
  case "${repo##*/}" in *:*) repo="${repo%:*}" ;; esac
  [ -n "$repo" ] || die "$key names no repository"
  tag="$repo:sha-$commit"
  # `docker pull` prints the digest of exactly the manifest the tag named.
  # RepoDigests would not do: an image pulled through two manifests carries
  # both, and nothing says which one this tag is.
  if ! output="$(docker pull "$tag" 2>&1)"; then
    warn "$output"
    die "could not pull $tag: CI has not published this commit, or this host cannot read the registry"
  fi
  digest="$(printf '%s\n' "$output" | sed -n 's/^Digest: //p' | tail -n1)"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || die "pulled $tag but could not read its digest"
  printf '%s=%s@%s\n' "$role" "$repo" "$digest"
done
