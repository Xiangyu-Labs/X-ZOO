#!/usr/bin/env bash
# Publish one commit's image without ever overwriting a different one.
#
#   .github/scripts/publish-release.sh tags <image> <sha> <arch-image>...
#
# Publishes each <arch-image> under its own tag in <image>, then joins them
# under `<image>:sha-<sha>`, and prints that manifest's digest on the last line.
# The images job in `ci.yml` calls it once per role.
#
# The rules live here, not inline in the workflow, so they can be exercised
# against a real registry (`publish-release.test.sh`, next to this file)
# instead of being trusted by reading YAML:
#
#   * an existing tag whose digest differs aborts BEFORE the tag is written;
#   * an authentication or network error while asking whether a tag exists is
#     never read as "the tag is absent";
#   * republishing the same candidate reproduces the same digest and is a no-op.
#
# It never moves a deployment tag: a release is deployed by digest, and a
# commit-scoped tag, once written, never changes.
set -Eeuo pipefail

mode="${1:?usage: publish-release.sh tags <image> <sha> <arch-image>...}"
shift || true

err_file="$(mktemp)"
trap 'rm -f "$err_file"' EXIT

# Echo the digest of a ref, or nothing when the ref is genuinely absent. A query
# that failed for authentication or network reasons aborts: guessing "absent"
# would republish over a release that is actually there.
resolve_digest() {
    local ref="$1" out
    if out="$(docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$ref" 2>"$err_file")"; then
        printf '%s\n' "$out"
        return 0
    fi
    if grep -qiE 'not found|no such manifest|manifest unknown|404 not found' "$err_file"; then
        return 0
    fi
    cat "$err_file" >&2
    echo "Could not determine whether $ref exists; refusing to guess" >&2
    return 1
}

# Echo the digest of a ref this run just wrote. The registry can answer "not
# found" for a few seconds after the write, so an empty answer is retried
# before it is believed.
resolve_written_digest() {
    local ref="$1" out attempt
    for attempt in 1 2 3 4 5 6; do
        out="$(resolve_digest "$ref")" || return 1
        if [ -n "$out" ]; then
            printf '%s\n' "$out"
            return 0
        fi
        sleep $((attempt * 2))
    done
    return 0
}

# Publish a commit-scoped tag and refuse to let it change value.
#
# Build into a temporary registry reference first. A conflict is rejected while
# the formal immutable tag is still untouched; a temporary reference may remain
# after a failed run and is safe to garbage-collect by the registry policy.
publish_tag() {
    local target="$1"
    shift
    local before after candidate candidate_digest repo tag
    before="$(resolve_digest "$target")"
    repo="${target%:*}"
    tag="${target##*:}"
    candidate="$repo:__publish_${tag}_${BASHPID}_${RANDOM}"
    docker buildx imagetools create -t "$candidate" "$@"
    candidate_digest="$(resolve_written_digest "$candidate")"
    if [ -z "$candidate_digest" ]; then
        echo "Published temporary candidate $candidate but could not resolve its digest" >&2
        return 1
    fi
    if [ -n "$before" ] && [ "$before" != "$candidate_digest" ]; then
        echo "refusing a conflicting release for $target: it already held $before but the candidate is $candidate_digest" >&2
        return 1
    fi
    if [ -n "$before" ]; then
        printf '%s already held %s; resumed without change\n' "$target" "$before"
        return 0
    fi
    # Recheck immediately before the first write to catch a concurrent publish.
    before="$(resolve_digest "$target")"
    if [ -n "$before" ] && [ "$before" != "$candidate_digest" ]; then
        echo "refusing a conflicting release for $target: it appeared with $before while publishing" >&2
        return 1
    fi
    docker buildx imagetools create -t "$target" "$candidate"
    after="$(resolve_written_digest "$target")"
    if [ -z "$after" ]; then
        echo "Published $target but could not read its digest back; refusing to continue" >&2
        return 1
    fi
    [ "$after" = "$candidate_digest" ] || {
        echo "Published $target as $after, expected $candidate_digest; refusing to continue" >&2
        return 1
    }
    printf '%s published as %s\n' "$target" "$after"
}

case "$mode" in
tags)
    image="${1:?usage: publish-release.sh tags <image> <sha> <arch-image>...}"
    sha="${2:?usage: publish-release.sh tags <image> <sha> <arch-image>...}"
    shift 2
    arch_images=("$@")
    if [ "${#arch_images[@]}" -eq 0 ]; then
        echo 'no arch images given' >&2
        exit 1
    fi
    # Per-arch tags first, then the multi-arch manifest that joins them. These
    # tags are commit-scoped and immutable: they are published through the same
    # conflict guard as the joined manifest, so a rerun of one commit with
    # different arch content is refused instead of silently mixing two builds.
    arch_tags=()
    for arch_image in "${arch_images[@]}"; do
        tag="${arch_image##*:}"
        publish_tag "$image:$tag" "$arch_image"
        arch_tags+=("$image:$tag")
    done
    publish_tag "$image:sha-$sha" "${arch_tags[@]}"
    digest="$(resolve_written_digest "$image:sha-$sha")"
    test -n "$digest" || { echo "could not resolve the published digest for $sha" >&2; exit 1; }
    printf '%s\n' "$digest"
    ;;
*)
    echo "unknown mode: $mode" >&2
    exit 1
    ;;
esac
