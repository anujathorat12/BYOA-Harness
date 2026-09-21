# Harness control plane. Talks to the Docker daemon ONLY through the restricted socket proxy (see compose).
FROM docker:27-cli AS dockercli

FROM python:3.11-slim
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
# Build tooling (setuptools/wheel) is removed after install: it is not needed at runtime and only adds attack surface.
RUN pip install --no-cache-dir . && pip uninstall -y setuptools wheel && useradd -u 10002 -M -s /usr/sbin/nologin harness
USER 10002
ENV PYTHONUNBUFFERED=1 HARNESS_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).status==200 else 1)"
CMD ["uvicorn", "--factory", "byoa_harness.main:create_app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
