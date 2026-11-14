#!/usr/bin/env bash
#
# Issue a server certificate under a disposable test certificate authority.
#
# Sourced by `scripts/db.sh` and `scripts/mail.sh`, the two test servers that
# speak TLS, so both are given certificates by one recipe. A managed-cloud tier
# reaches its database and its mail relay over verified TLS, often under a
# provider's private authority (DATABASE_CA_CERTIFICATE, MAIL_CA_CERTIFICATE);
# without test servers that speak it, that tier's transport is configuration no
# test has run (`environment-portability.md` AC3).
#
# The certificate names a host name (`localhost`) and not 127.0.0.1, the way a
# managed endpoint's certificate names the endpoint rather than an address. A
# test that connects by 127.0.0.1 therefore sees a certificate naming another
# host, which is what proves hostname verification is actually on.
#
# Each caller has its own directory, so `db:down`/`mail:down` and a re-run of
# either never disturb the other's authority.

# A path node can open on every platform: Git Bash on Windows hands out /c/... paths.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

# issue_test_certificate DIR HOST
# Writes DIR/ca.pem, DIR/server.pem, and DIR/server.key, once; an existing set is kept.
issue_test_certificate() {
  local dir="$1" host="$2"
  # Git Bash rewrites anything that looks like a POSIX path (an openssl -subj)
  # unless told not to.
  local previous="${MSYS_NO_PATHCONV:-}"
  export MSYS_NO_PATHCONV=1
  mkdir -p "${dir}"
  if [ ! -f "${dir}/ca.pem" ] || [ ! -f "${dir}/server.pem" ] || [ ! -f "${dir}/server.key" ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=zeddev test CA" \
      -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -keyout "${dir}/ca.key" -out "${dir}/ca.pem" 2>/dev/null
    openssl req -newkey rsa:2048 -nodes -subj "/CN=${host}" \
      -keyout "${dir}/server.key" -out "${dir}/server.csr" 2>/dev/null
    {
      echo "subjectAltName=DNS:${host}"
      echo "extendedKeyUsage=serverAuth"
    } > "${dir}/server.ext"
    openssl x509 -req -in "${dir}/server.csr" -CA "${dir}/ca.pem" -CAkey "${dir}/ca.key" \
      -CAcreateserial -days 3650 -extfile "${dir}/server.ext" -out "${dir}/server.pem" 2>/dev/null
  fi
  if [ -z "${previous}" ]; then unset MSYS_NO_PATHCONV; else export MSYS_NO_PATHCONV="${previous}"; fi
}
