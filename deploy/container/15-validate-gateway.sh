#!/bin/sh
set -eu

fail() {
  printf '%s\n' "[hermes-mobile] invalid HERMES_GATEWAY_URL: $1" >&2
  exit 1
}

url=${HERMES_GATEWAY_URL-}
[ -n "$url" ] || fail 'it is required'
case "$url" in
  *[!A-Za-z0-9./:-]* | *..* | *[?]* | *'#'*) fail 'must be an HTTP(S) origin without credentials, path, query, or fragment' ;;
esac

case "$url" in
  http://*) scheme=http; authority=${url#http://} ;;
  https://*) scheme=https; authority=${url#https://} ;;
  *) fail 'must start with http:// or https://' ;;
esac

case "$authority" in
  */) authority=${authority%/} ;;
esac
[ -n "$authority" ] || fail 'host is required'
case "$authority" in
  *//* | */* | *:*:*) fail 'must contain only one optional port and no path' ;;
esac

host=$authority
port=
case "$authority" in
  *:*)
    host=${authority%:*}
    port=${authority##*:}
    case "$port" in ''|*[!0-9]*) fail 'port must be numeric' ;; esac
    [ "$port" -ge 1 ] 2>/dev/null && [ "$port" -le 65535 ] 2>/dev/null || fail 'port must be between 1 and 65535'
    ;;
esac

[ -n "$host" ] || fail 'host is required'
case "$host" in
  .*|*.) fail 'host must not begin or end with a dot' ;;
esac

is_ipv4=false
looks_like_ipv4=true
old_ifs=$IFS
IFS=.
set -- $host
IFS=$old_ifs
[ "$#" -eq 4 ] || looks_like_ipv4=false
if [ "$looks_like_ipv4" = true ]; then
  for octet in "$@"; do
    case "$octet" in ''|*[!0-9]*) looks_like_ipv4=false; break ;; esac
  done
fi
if [ "$looks_like_ipv4" = true ]; then
  is_ipv4=true
  for octet in "$@"; do
    [ "$octet" -le 255 ] 2>/dev/null || fail 'IPv4 octets must be between 0 and 255'
  done
fi

if [ "$is_ipv4" != true ]; then
  case "$host" in *[!A-Za-z0-9.-]*|*..*) fail 'host must be a DNS name or IPv4 address' ;; esac
  old_ifs=$IFS
  IFS=.
  set -- $host
  IFS=$old_ifs
  for label in "$@"; do
    case "$label" in ''|-*|*-) fail 'DNS labels must be nonempty and may not begin or end with a hyphen' ;; esac
  done
fi

[ -n "$port" ] || { [ "$scheme" = https ] && port=443 || port=80; }

# Entrypoint hook scripts run in separate processes, so exports here would not
# reach nginx's later envsubst hook. This validated include keeps the official
# template pipeline and gives proxy_pass variables that Docker's DNS resolver
# can re-resolve after a backend container is recreated.
conf_dir=${HERMES_NGINX_CONF_DIR:-/etc/nginx/conf.d}
mkdir -p "$conf_dir"
cat > "$conf_dir/10-hermes-gateway-upstream.conf" <<EOF
map "" \$hermes_gateway_scheme { default "$scheme"; }
map "" \$hermes_gateway_host { default "$host"; }
map "" \$hermes_gateway_port { default "$port"; }
EOF
