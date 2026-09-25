# syntax=docker/dockerfile:1
FROM node:26-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e AS build

ARG SOURCE_REVISION
ARG SOURCE_BRANCH=main

WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/shared/package.json apps/shared/package.json
RUN npm ci
COPY apps ./apps
RUN printf '%s' "$SOURCE_REVISION" | grep -Eq '^[0-9a-f]{40}$' \
    || { echo 'SOURCE_REVISION must be exactly 40 lowercase hexadecimal characters' >&2; exit 1; }
RUN GITHUB_SHA="$SOURCE_REVISION" GITHUB_REF_NAME="$SOURCE_BRANCH" npm run build -w apps/desktop

FROM nginx:1.31.5-alpine@sha256:72ba65eb42c10344912a84ff42408db7d34f2feb642204570ab8fc5ffd29f1d3

ARG SOURCE_REVISION
ARG SOURCE_BRANCH=main
LABEL org.opencontainers.image.source="https://github.com/sremes/hermes-mobile" \
      org.opencontainers.image.revision="$SOURCE_REVISION" \
      org.opencontainers.image.version="$SOURCE_BRANCH"

COPY --from=build /workspace/apps/desktop/dist/ /usr/share/nginx/html/
COPY --from=build /workspace/apps/desktop/build/install-stamp.json /usr/share/nginx/html/build-info.json
COPY deploy/container/default.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/container/15-validate-gateway.sh /docker-entrypoint.d/15-validate-gateway.sh
RUN chmod 0555 /docker-entrypoint.d/15-validate-gateway.sh

EXPOSE 80
