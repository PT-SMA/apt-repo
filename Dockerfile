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

# The aptly API runs with -no-lock, so every request opens and closes the database.
# Only probe that its port is open; calling it every 30s churns the leveldb MANIFEST.
HEALTHCHECK --interval=30s --timeout=5s --start-period=2m \
  CMD bash -c '</dev/tcp/127.0.0.1/8080' \
   && curl -fsS http://127.0.0.1/healthz >/dev/null || exit 1

# -g: forward stop signals to the whole process group, so an aptly CLI run during startup
# closes the database cleanly instead of being killed mid-write.
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
