# syntax=docker/dockerfile:1.7
#
# A candidate that carries one migration the drill's database has not applied.
# Never published anywhere real.
#
#   docker build -f deploy/rehearsal/pending-migration.Dockerfile \
#     --build-arg BASE=<a real worker image> \
#     --build-arg MIGRATION_TAG=9000_drill_marker \
#     --build-arg MIGRATION_SQL='CREATE TABLE "drill_marker" ("id" integer);' \
#     -t x-zoo-worker:pending .
#
# The migration is appended to the image's own journal, one second after the
# newest entry, which is exactly how drizzle sees a release that adds one: the
# read-only check (`db/src/pending.mjs`) reports it, and `shop upgrade` has to
# take the path that stops the writers.
#
# The drill builds it twice: with a harmless `CREATE TABLE`, and with a
# statement that fails, which is what a real migration failure looks like — a
# failed DDL and exit 1, not a crash. The worker itself is untouched in both,
# so each isolates one question.

ARG BASE
FROM ${BASE}
ARG MIGRATION_TAG
ARG MIGRATION_SQL

USER root
RUN node -e ' \
      const fs = require("node:fs"); \
      const dir = "/app/db/migrations"; \
      const file = `${dir}/meta/_journal.json`; \
      const journal = JSON.parse(fs.readFileSync(file, "utf8")); \
      const last = journal.entries.at(-1); \
      journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag: process.env.MIGRATION_TAG }); \
      fs.writeFileSync(file, JSON.stringify(journal, null, 2)); \
      fs.writeFileSync(`${dir}/${process.env.MIGRATION_TAG}.sql`, process.env.MIGRATION_SQL); \
    ' \
    && chown -R node:node /app/db/migrations
USER node
