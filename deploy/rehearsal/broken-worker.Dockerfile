# syntax=docker/dockerfile:1.7
#
# A deliberately broken release candidate, for rehearsing the failure path of
# `shop upgrade`. It is never published and never deployed anywhere real.
#
#   docker build -f deploy/rehearsal/broken-worker.Dockerfile \
#     --build-arg BASE=<a real worker image> -t x-zoo-worker:broken .
#
# The fault is the one a container healthcheck is *supposed* to catch and the
# easiest one to get wrong: a process that starts, stays up, logs nothing
# alarming — and does no work. It writes no heartbeat, so `worker:heartbeat`
# never appears, the container healthcheck fails, and `compose up --wait` and
# the readiness gate both refuse the release.
#
# A candidate that crashed outright would be a weaker drill: Docker reports a
# restarting container without any healthcheck at all, so it would prove
# nothing about the probe.

ARG BASE
FROM ${BASE}

# Up, idle, and useless.
CMD ["node", "-e", "setInterval(() => {}, 60000)"]
