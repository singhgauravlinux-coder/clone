# Two stages, one image. The frontend is baked in so the API can serve it
# directly; there is no separate web container to keep in step.

FROM node:22-alpine AS web
WORKDIR /src
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM golang:1.22-alpine AS api
WORKDIR /src
RUN apk add --no-cache git
COPY backend/go.mod backend/go.sum* ./
# go.sum is optional here: a fresh clone may not have one committed yet, and a
# build that fails on its absence is a worse outcome than one that resolves it.
RUN go mod download || go mod tidy
COPY backend/ ./
# Tidy again now the sources are present: the first pass only saw go.mod.
RUN go mod tidy
# Static build: the runtime image has no libc.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/workbench .

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=api /out/workbench /app/workbench
COPY --from=web /src/dist /app/web
COPY db/migrations /app/migrations
USER nonroot:nonroot
EXPOSE 8080
ENV WEB_DIR=/app/web
ENTRYPOINT ["/app/workbench"]
