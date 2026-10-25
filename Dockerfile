# syntax=docker/dockerfile:1.7
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    CARD_DB=/data/cards.sqlite3 \
    CARD_HOST=0.0.0.0 \
    CARD_PORT=8080 \
    CARD_UPDATE_MODE=auto \
    CARD_UPDATE_REPO=quanquna0319/card-service \
    CARD_UPDATE_BRANCH=main \
    CARD_UPDATE_DIR=/data \
    CARD_UPDATE_INSTALL_DIR=/data/app

WORKDIR /app

ARG CARD_BUILD_REVISION=""

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app --shell /usr/sbin/nologin app \
    && printf '%s\n' "$CARD_BUILD_REVISION" > /app/.build-revision

COPY server.py /app/server.py
COPY mitm_server.py /app/mitm_server.py
COPY static /app/static
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod 0555 /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data \
    && chown -R app:app /app /data

USER 10001:10001

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('CARD_PORT','8080'), timeout=2)" || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "/app/server.py"]
