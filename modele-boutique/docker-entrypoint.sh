#!/bin/sh
set -e

mkdir -p /var/data/uploads
chown -R app:app /var/data

exec setpriv --reuid=app --regid=app --init-groups "$@"
