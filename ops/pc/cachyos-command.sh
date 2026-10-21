#!/bin/sh
# Authorized-key forced command; pass the command literally, never evaluate it.
exec sudo -n /usr/local/sbin/infra-control-pc "$SSH_ORIGINAL_COMMAND"
