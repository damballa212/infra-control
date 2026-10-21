#!/bin/sh
# This key can only inspect this fixed helper or wake this one PC.
case "${SSH_ORIGINAL_COMMAND:-}" in
  check) exec /fhconf/infra-control/wol --check ;;
  wake) exec /fhconf/infra-control/wol ;;
  *) echo '{"error":"command_not_allowed"}' >&2; exit 2 ;;
esac
