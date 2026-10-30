FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
ARG VERSION=dev
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/ ./cmd/...

FROM gcr.io/distroless/static:nonroot
LABEL org.opencontainers.image.source="https://github.com/imhyunho99/php2shell-shield" \
      org.opencontainers.image.licenses="MIT"
COPY LICENSE /usr/share/doc/php2shell-shield/LICENSE
COPY --from=build /out/ /usr/local/bin/
USER nonroot
ENTRYPOINT ["/usr/local/bin/php2shell-shield"]
