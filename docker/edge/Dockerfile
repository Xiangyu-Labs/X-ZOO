# syntax=docker/dockerfile:1.7
#
# The `edge` image: nginx and its configuration, nothing else.
#
#   docker build -f docker/edge/Dockerfile -t x-zoo-edge .
#
# It carries no front-end files. `/` is the landing page, answered by `web`;
# the WeChat domain-verification files are a read-only mount at
# `/srv/domain-verification` (deploy/compose.yml); the uploads are a volume.
#
# The build context is the repository root, like the other two images. The
# adjacent `Dockerfile.dockerignore` replaces the root `.dockerignore`, so the
# edge build sees exactly `docker/edge/`.

ARG NGINX_IMAGE=nginx:1.29-alpine

FROM ${NGINX_IMAGE} AS edge

RUN rm -f /etc/nginx/conf.d/default.conf
COPY docker/edge/nginx.conf /etc/nginx/conf.d/edge.conf
# The trusted-proxy list for the realip module, rendered from
# NEXT_EDGE_TRUSTED_PROXIES at every start by the image's own entrypoint hook
# mechanism. Empty by default: nothing is trusted, and the TCP peer is the
# client. `compose.traefik.yml` requires it once Traefik fronts the edge.
COPY --chmod=0755 docker/edge/40-edge-real-ip.sh /docker-entrypoint.d/40-edge-real-ip.sh
ENV NEXT_EDGE_TRUSTED_PROXIES=''

# The uploads volume and the verification directory are mounted read-only
# here, and both directories have to exist for nginx to start when nothing is
# attached at all (a config test, say). Without the mount the verification
# directory is empty and every `/<name>.txt` is a 404.
#
# `/data/uploads` is owned by uid 1000 even though nginx never writes to it,
# because Docker seeds a new named volume from *whichever* container mounts it
# first — read-only mounts included, and the edge usually wins that race. A
# root-owned `/data/uploads` then makes every upload fail with EACCES in
# containers that are deliberately not root. A manual `chown` on the host would paper over it
# until the next fresh volume; the fix is for every image that declares this
# path to agree about who owns it.
#
# The config test runs against the list the entrypoint would write for the
# default (empty) value and for a representative one, so a directive that the
# realip module would refuse fails the build rather than the first start.
RUN mkdir -p /data/uploads /srv/domain-verification /etc/nginx/edge \
    && chown -R 1000:1000 /data \
    && NEXT_EDGE_TRUSTED_PROXIES='172.18.0.0/16 fd00::/8' /docker-entrypoint.d/40-edge-real-ip.sh \
    && nginx -t \
    && /docker-entrypoint.d/40-edge-real-ip.sh \
    && nginx -t

# nginx:alpine already drops to the `nginx` user for its workers, and the
# master needs to bind :80 — inside the container, with no host port mapped
# below 1024 by compose, so the root master never faces the network directly.
EXPOSE 80
