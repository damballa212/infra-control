#!/usr/bin/env bash
# Backup cifrado de Vaultwarden (se ejecuta en el VPS). Cifra con la clave PÚBLICA del destinatario:
# el servidor no puede descifrar sus propias copias. Conserva las últimas VW_BACKUP_KEEP.
set -euo pipefail
umask 077
DIR=${VW_DIR:-/opt/vaultwarden}
OUT=$DIR/backups
RECIPIENT=${VW_BACKUP_RECIPIENT:?define VW_BACKUP_RECIPIENT (huella o correo de la clave pública importada)}
KEEP=${VW_BACKUP_KEEP:-14}
CONTAINER=${VW_CONTAINER:-vaultwarden-vaultwarden-1}

install -d -m 0700 "$OUT"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
stage=$(mktemp -d "$OUT/.stage.XXXXXX")
trap 'rm -rf "$stage" "$stage.tar.gz"' EXIT

docker exec "$CONTAINER" /vaultwarden backup >/dev/null   # instantánea consistente: data/db_*.sqlite3
snapshot=$(ls -1t "$DIR"/data/db_*.sqlite3 | head -1)
mv "$snapshot" "$stage/db.sqlite3"
cp -a "$DIR/data/rsa_key.pem" "$stage/"
for extra in attachments sends config.json; do
  [ -e "$DIR/data/$extra" ] && cp -a "$DIR/data/$extra" "$stage/"
done
tar -C "$stage" -czf "$stage.tar.gz" .
gpg --batch --yes --trust-model always --encrypt --recipient "$RECIPIENT" \
  --output "$OUT/vw-$stamp.tar.gz.gpg" "$stage.tar.gz"
gpg --batch --list-only --list-packets "$OUT/vw-$stamp.tar.gz.gpg" >/dev/null 2>&1   # válido como OpenPGP y cifrado para el destinatario (no descifra)

ls -1t "$OUT"/vw-*.tar.gz.gpg | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "backup: $OUT/vw-$stamp.tar.gz.gpg"
