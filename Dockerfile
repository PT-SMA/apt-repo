FROM debian:trixie-slim

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      aptly gnupg nginx tini openssl curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled/default \
 && useradd --system --uid 10001 --user-group --home-dir /data --no-create-home \
      --shell /usr/sbin/nologin aptly \
 && install -d -o aptly -g aptly /data

ENV GNUPGHOME=/data/gnupg

COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/aptly.conf /etc/aptly.conf.tmpl
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY web/ /usr/share/apt-ui/

VOLUME /data
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=2m \
  CMD curl -fsS http://127.0.0.1:8080/api/version >/dev/null \
   && curl -fsS http://127.0.0.1/healthz >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
