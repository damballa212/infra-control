#!/usr/bin/env python3
"""Fail-closed deployment admission and SQLite-consistent backup for Infra Control."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sqlite3
import sys
import uuid

GATE_KEY = 'deployment-gate'
MAX_LEASE_SECONDS = 3600


def connect(database):
    path = Path(database).resolve(strict=True)
    db = sqlite3.connect(f'file:{path}?mode=rw', uri=True, timeout=5)
    db.execute('PRAGMA busy_timeout=5000')
    return db


def active_count(db):
    return db.execute("SELECT COUNT(*) FROM operations WHERE state IN ('accepted','running')").fetchone()[0]


def read_gate(db):
    row = db.execute('SELECT value FROM settings WHERE key=?', (GATE_KEY,)).fetchone()
    if row is None:
        return None
    try:
        value = json.loads(row[0])
        expiration = datetime.fromisoformat(value['expiresAt'].replace('Z', '+00:00'))
        if expiration.tzinfo is None:
            raise ValueError('Gate lease has no timezone')
        return value if expiration > datetime.now(timezone.utc) else None
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        # The application also treats malformed gate state as active.
        return {'owner': None, 'invalid': True}


def backup_database(database, backup_dir):
    folder = Path(backup_dir)
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(folder, 0o700)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    target = folder / f'infra-control-{stamp}-{uuid.uuid4().hex[:8]}.sqlite'
    source = connect(database)
    destination = sqlite3.connect(target)
    os.chmod(target, 0o600)
    try:
        source.backup(destination)
        result = destination.execute('PRAGMA integrity_check').fetchone()[0]
        if result != 'ok':
            raise RuntimeError('SQLite backup integrity check failed')
    except Exception:
        target.unlink(missing_ok=True)
        raise
    finally:
        destination.close()
        source.close()
    return target


def enter(database, backup_dir, lease_seconds):
    if not 60 <= lease_seconds <= MAX_LEASE_SECONDS:
        raise ValueError(f'Lease must be between 60 and {MAX_LEASE_SECONDS} seconds')
    owner = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    gate = {'owner': owner, 'createdAt': now.isoformat(), 'expiresAt': (now + timedelta(seconds=lease_seconds)).isoformat()}
    db = connect(database)
    try:
        db.execute('BEGIN IMMEDIATE')
        current = read_gate(db)
        if current:
            db.rollback()
            raise RuntimeError('Deployment gate is already active or invalid')
        active = active_count(db)
        if active:
            db.rollback()
            raise RuntimeError(f'Deployment denied: {active} operation(s) are active')
        db.execute('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)', (GATE_KEY, json.dumps(gate, separators=(',', ':'))))
        db.commit()
    finally:
        db.close()

    try:
        backup = backup_database(database, backup_dir)
    except Exception:
        release(database, owner)
        raise
    return {'owner': owner, 'expiresAt': gate['expiresAt'], 'backup': str(backup), 'activeOperations': 0}


def release(database, owner):
    db = connect(database)
    try:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT value FROM settings WHERE key=?', (GATE_KEY,)).fetchone()
        if row is None:
            db.commit()
            return {'released': False, 'reason': 'no_active_gate'}
        try:
            current = json.loads(row[0])
        except json.JSONDecodeError as error:
            db.rollback()
            raise RuntimeError('Cannot release malformed deployment gate without manual inspection') from error
        if current.get('owner') != owner:
            db.rollback()
            raise RuntimeError('Deployment gate owner mismatch')
        db.execute('DELETE FROM settings WHERE key=?', (GATE_KEY,))
        db.commit()
        return {'released': True}
    finally:
        db.close()


def status(database):
    db = connect(database)
    try:
        return {'activeOperations': active_count(db), 'gate': read_gate(db)}
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('enter', 'release', 'status'))
    parser.add_argument('--database', default=os.environ.get('INFRA_CONTROL_DB', '/opt/infra-control/data/infra.sqlite'))
    parser.add_argument('--backup-dir', default='/opt/infra-control/backups')
    parser.add_argument('--lease-seconds', type=int, default=1800)
    parser.add_argument('--owner')
    args = parser.parse_args()
    try:
        if args.command == 'enter':
            result = enter(args.database, args.backup_dir, args.lease_seconds)
        elif args.command == 'release':
            if not args.owner:
                parser.error('release requires --owner')
            result = release(args.database, args.owner)
        else:
            result = status(args.database)
        print(json.dumps(result, sort_keys=True))
    except Exception as error:
        print(f'Deployment gate: {type(error).__name__}: {error}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
