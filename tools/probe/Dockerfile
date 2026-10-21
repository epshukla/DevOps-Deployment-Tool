# Multi-stage: compile a static binary, ship it on a tiny base (~10 MB)
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN go test ./... && CGO_ENABLED=0 go build -ldflags="-s -w" -o /probe .

FROM alpine:3.20
RUN adduser -D -u 10001 probe
USER probe
COPY --from=build /probe /usr/local/bin/probe
ENTRYPOINT ["probe"]
