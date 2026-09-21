# Build context is the REPO ROOT (compose sets it) so an optional ./certs/corp-ca.pem can be trusted during
# `npm ci` behind a TLS-inspecting corporate proxy. Without that file the build uses the normal trust store.
FROM node:22-alpine AS build
WORKDIR /app
COPY certs/ /certs/
COPY console/package.json console/package-lock.json ./
RUN if [ -f /certs/corp-ca.pem ]; then export NODE_EXTRA_CA_CERTS=/certs/corp-ca.pem; fi && npm ci
COPY console/ ./
RUN npm run build

# Non-root nginx: serves the static console and reverse-proxies the API so the browser is same-origin.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY console/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
