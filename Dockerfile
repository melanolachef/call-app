# Build: compiles the server (the HTML/JS are embedded in the binary).
FROM rust:1-slim-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY static ./static
RUN cargo build --release --locked

# Run: just the binary on a minimal image.
FROM gcr.io/distroless/cc-debian12
COPY --from=build /app/target/release/call-app /call-app
ENV PORT=3000
EXPOSE 3000
# Root: the Fly volume (/data, the accounts database) is mounted owned by
# root, and this image has no shell to change that at start. The machine is
# a Firecracker VM running only this binary.
USER root
CMD ["/call-app"]
