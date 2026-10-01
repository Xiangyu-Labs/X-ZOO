# syntax=docker/dockerfile:1.7
#
# A second release of an image that behaves identically to the first.
#
#   docker build -f deploy/rehearsal/relabel.Dockerfile \
#     --build-arg BASE=<image> --build-arg DRILL_VERSION=v2 -t <image>-v2 .
#
# The drill needs two *different* releases to prove anything about rolling
# back: an "upgrade" from a digest to itself makes "it ended on the previous
# digest" true no matter what the script did. A label is the smallest change
# that produces a new digest without changing a single byte of behaviour, so a
# rollback that lands on the wrong one is a rollback that is genuinely wrong
# rather than one that merely looks different.

ARG BASE
FROM ${BASE}
ARG DRILL_VERSION=v2
LABEL vip.x-zoo.drill="${DRILL_VERSION}"
