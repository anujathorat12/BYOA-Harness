# Sandbox runtime image shared by all agent shapes. Contains ONLY the agent-side SDK and the
# declarative interpreter - no harness code, no secrets, no network tools.
FROM python:3.11-slim

RUN pip uninstall -y pip setuptools wheel >/dev/null 2>&1 || true \
 && groupadd -g 10001 agent && useradd -u 10001 -g 10001 -M -d /nonexistent -s /usr/sbin/nologin agent \
 && rm -rf /var/lib/apt/lists/* /root/.cache

COPY byoa_runtime/ /opt/byoa_runtime/
RUN chmod -R a=rX,u+w /opt/byoa_runtime && chown -R root:root /opt/byoa_runtime

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/tmp
USER 10001:10001
WORKDIR /tmp
ENTRYPOINT ["python", "-u", "-B", "/opt/byoa_runtime/bootstrap.py"]
