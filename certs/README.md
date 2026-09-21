# certs/

Optional extra trusted CA certificates. **Normally this folder stays empty.**

Only needed if your network re-signs HTTPS traffic (a TLS-inspecting corporate proxy such as Netskope or Zscaler),
which shows up as `CERTIFICATE_VERIFY_FAILED ... self-signed certificate in certificate chain`.

1. Put your proxy's root CA, in PEM format, here as `corp-ca.pem`.
2. Set `EXTRA_CA_BUNDLE=/certs/corp-ca.pem` in `.env`.

The harness then trusts that CA **in addition to** the normal ones (verification is never disabled), and the console image
build uses it for `npm ci`. `*.pem` files are git-ignored, so a certificate is never committed. This folder is tracked
only so `docker compose build` works on a fresh clone (the console Dockerfile copies it).
