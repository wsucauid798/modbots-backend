FROM rust:1.93-alpine AS build
WORKDIR /app

RUN apk add --no-cache build-base cmake perl

COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM alpine:3.23 AS runtime
WORKDIR /app

RUN apk add --no-cache ca-certificates

COPY --from=build /app/target/release/modbots-realtime-gateway ./modbots-realtime-gateway

EXPOSE 3002/tcp
EXPOSE 4433/udp

CMD ["./modbots-realtime-gateway"]
