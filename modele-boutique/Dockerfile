# syntax=docker/dockerfile:1

FROM rust:1-bookworm AS build
WORKDIR /src/backend
COPY backend/ ./
RUN cargo build --release --locked

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system app \
    && useradd --system --gid app --no-create-home --home-dir /nonexistent app

WORKDIR /app
COPY --from=build /src/backend/target/release/aura-store-backend /app/aura-store-backend
COPY modele-boutique/ /app/site/
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod 755 /app/docker-entrypoint.sh /app/aura-store-backend

ENV PORT=10000 \
    STATIC_DIR=/app/site \
    DATABASE_URL=sqlite:///var/data/store.db?mode=rwc \
    PRODUCT_UPLOAD_DIR=/var/data/uploads \
    COOKIE_SECURE=true \
    TRUST_PROXY=true

EXPOSE 10000

# The entrypoint runs as root only to fix ownership of the persistent disk,
# then starts the server as the unprivileged "app" user.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["/app/aura-store-backend"]
