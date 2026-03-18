# =============================================================================
# Polymarket Copier — Multi-stage Rust Build
# =============================================================================
# Builds the Rust hot-path binary for copy-trade execution.
# Target: ARM64 (AWS Ireland m6g.large). Built natively on self-hosted runner.

# ─── Builder Stage ──────────────────────────────────────────────────────────
FROM rust:latest AS builder

RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cache dependency build: copy manifests first, build with empty main
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main(){}" > src/main.rs && cargo build --release && rm -rf src

# Copy real source and rebuild (only recompiles our code, deps cached)
COPY src/ src/
RUN touch src/main.rs && cargo build --release

# ─── Production Stage ───────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/polymarket-copier /usr/local/bin/

USER nobody

ENTRYPOINT ["polymarket-copier"]
