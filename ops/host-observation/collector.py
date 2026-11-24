#!/usr/bin/python3
"""Root, local, read-only host/Docker producer. Python standard library only."""
import datetime
import fcntl
import hashlib
import json
import math
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time

BASE = '/var/lib/infra-control-host-observer'
MAX_BYTES = 4 * 1024 * 1024
MAX_SAFE = 9007199254740991
MAX_CONTAINERS = 1000
DOCKER = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']
ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'DOCKER_CONFIG': '/nonexistent/infra-control-observer', 'LANG': 'C', 'LC_ALL': 'C'}
TEMPLATE = r'{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"status":{{json .State.Status}},"healthStatus":{{if index .State "Health"}}{{json (index (index .State "Health") "Status")}}{{else}}null{{end}},"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}},"restartCount":{{json .RestartCount}},"labels":{"com.docker.compose.project":{{json (index .Config.Labels "com.docker.compose.project")}},"com.docker.compose.service":{{json (index .Config.Labels "com.docker.compose.service")}}}}'

class CollectionError(Exception):
    pass

def iso(value):
    return value.astimezone(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def safe_text(value, maximum):
    if not isinstance(value, str) or not value or len(value) > maximum or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value):
        raise CollectionError('docker_invalid')
    value.encode('utf-8', 'strict')
    return value

def integer(value, positive=False):
    if type(value) is not int or value < (1 if positive else 0) or value > MAX_SAFE:
        raise ValueError('invalid integer')
    return value

def docker_time(value):
    if not isinstance(value, str):
        raise CollectionError('docker_invalid')
    if value.startswith('0001-01-01T00:00:00'):
        return None
    if not value.endswith('Z') or len(value) > 40:
        raise CollectionError('docker_invalid')
    try:
        return iso(datetime.datetime.fromisoformat(value.replace('Z', '+00:00')))
    except (ValueError, OverflowError):
        raise CollectionError('docker_invalid') from None

def run_bounded(argv, deadline, limit, popen=subprocess.Popen, monotonic=time.monotonic):
    process = None
    output = bytearray()
    try:
        if deadline <= monotonic():
            raise CollectionError('docker_timeout')
        process = popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                        env=dict(ENV), shell=False, close_fds=True, start_new_session=True)
        os.set_blocking(process.stdout.fileno(), False)
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - monotonic()
                if remaining <= 0:
                    raise CollectionError('docker_timeout')
                for key, _ in selector.select(min(remaining, 0.2)):
                    chunk = os.read(key.fd, min(65536, limit - len(output) + 1))
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    output.extend(chunk)
                    if len(output) > limit:
                        raise CollectionError('docker_output_limit')
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise CollectionError('docker_timeout')
        try:
            code = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            raise CollectionError('docker_timeout') from None
        if code != 0:
            raise CollectionError('docker_unavailable')
        return bytes(output)
    except OSError:
        raise CollectionError('docker_unavailable') from None
    finally:
        if process is not None:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            if process.stdout is not None:
                process.stdout.close()

def native_read(path, limit):
    with open(path, 'r', encoding='ascii', errors='strict') as source:
        result = source.readline(limit + 1) if path == '/proc/stat' else source.read(limit + 1)
    if len(result) > limit:
        raise ValueError('input too large')
    return result

class NativeIO:
    def wall(self):
        return iso(datetime.datetime.now(datetime.timezone.utc))
    def monotonic(self):
        return time.monotonic()
    def read(self, path, limit):
        return native_read(path, limit)
    def statvfs(self, path):
        return os.statvfs(path)
    def run(self, argv, deadline, limit):
        return run_bounded(argv, deadline, limit)

def cpu_counters(text):
    fields = text.split()
    if len(fields) < 9 or fields[0] != 'cpu':
        raise ValueError('invalid cpu')
    raw = [integer(int(value)) for value in fields[1:]]
    result = raw[:8]
    # guest/guest_nice are already included in user/nice; exclude them explicitly.
    result[0] -= raw[8] if len(raw) > 8 else 0
    result[1] -= raw[9] if len(raw) > 9 else 0
    if any(value < 0 for value in result):
        raise ValueError('invalid cpu')
    return result

def cpu_percent(current, previous, boot, mono):
    if previous.get('bootId') != boot or previous.get('cpuCounters') is None:
        return None
    elapsed = mono - previous.get('monotonic', -1e30)
    if not 0 < elapsed <= 180:
        return None
    old = previous['cpuCounters']
    if len(old) != 8:
        return None
    delta = [a - b for a, b in zip(current, old)]
    total = sum(delta)
    if any(value < 0 for value in delta) or total <= 0:
        return None
    return 100.0 * (total - delta[3] - delta[4]) / total

def memory_values(text):
    found = {}
    for line in text.splitlines():
        fields = line.split()
        if fields and fields[0] in ('MemTotal:', 'MemAvailable:'):
            if len(fields) != 3 or fields[2] != 'kB' or fields[0] in found:
                raise ValueError('invalid memory')
            found[fields[0]] = integer(int(fields[1]) * 1024)
    total, available = found['MemTotal:'], found['MemAvailable:']
    if total <= 0 or available > total:
        raise ValueError('invalid memory')
    return total, available

def list_ids(data):
    try:
        values = data.decode('ascii', 'strict').splitlines()
    except UnicodeError:
        raise CollectionError('docker_invalid') from None
    if any(not re.fullmatch('[a-f0-9]{64}', value) for value in values) or len(set(values)) != len(values):
        raise CollectionError('docker_invalid')
    if len(values) > MAX_CONTAINERS:
        raise CollectionError('docker_limit')
    return sorted(values)

def container_value(value, observed_at):
    if not isinstance(value, dict) or set(value) != {'id', 'name', 'image', 'status', 'healthStatus', 'startedAt', 'finishedAt', 'restartCount', 'labels'}:
        raise CollectionError('docker_invalid')
    if not isinstance(value['id'], str) or not re.fullmatch('[a-f0-9]{64}', value['id']):
        raise CollectionError('docker_invalid')
    if value['status'] not in ('created', 'restarting', 'running', 'removing', 'paused', 'exited', 'dead') or value['healthStatus'] not in (None, 'starting', 'healthy', 'unhealthy'):
        raise CollectionError('docker_invalid')
    labels = value['labels']
    allowed = {'com.docker.compose.project', 'com.docker.compose.service'}
    if not isinstance(labels, dict) or set(labels) - allowed:
        raise CollectionError('docker_invalid')
    result = dict(value)
    result['name'] = safe_text(value['name'][1:] if isinstance(value['name'], str) and value['name'].startswith('/') else value['name'], 200)
    result['image'] = safe_text(value['image'], 200)
    result['labels'] = {key: safe_text(item, 160) for key, item in labels.items() if item not in (None, '')}
    result['restartCount'] = integer(value['restartCount'])
    for field in ('startedAt', 'finishedAt'):
        result[field] = docker_time(value[field])
        if result[field] is not None and result[field] > observed_at:
            raise CollectionError('docker_invalid')
    return result

def docker_observation(io, deadline):
    started = io.wall()
    remaining_bytes = MAX_BYTES
    containers = []
    errors = []
    def run(arguments):
        nonlocal remaining_bytes
        if remaining_bytes <= 0:
            raise CollectionError('docker_output_limit')
        data = io.run(DOCKER + arguments, min(deadline, io.monotonic() + 8), remaining_bytes)
        remaining_bytes -= len(data)
        return data
    try:
        ids = list_ids(run(['ps', '-aq', '--no-trunc']))
        for offset in range(0, len(ids), 32):
            batch = ids[offset:offset + 32]
            output = run(['inspect', '--type', 'container', '--format', TEMPLATE] + batch)
            observed_at = io.wall()
            decoded = [json.loads(line) for line in output.decode('utf-8', 'strict').splitlines()]
            values = [dict(container_value(value, observed_at), observedAt=observed_at) for value in decoded]
            if len(values) != len(batch) or {value['id'] for value in values} != set(batch):
                raise CollectionError('docker_invalid')
            containers.extend(values)
        if list_ids(run(['ps', '-aq', '--no-trunc'])) != ids:
            raise CollectionError('docker_changed')
    except CollectionError as error:
        errors = [str(error)]
    except (ValueError, TypeError, KeyError, UnicodeError, OverflowError):
        errors = ['docker_invalid']
    return {'startedAt': started, 'observedAt': io.wall(), 'complete': not errors, 'errors': errors, 'containers': containers}

def collect(io, previous):
    started, mono = io.wall(), io.monotonic()
    boot = io.read('/proc/sys/kernel/random/boot_id', 64).strip().lower()
    machine = io.read('/etc/machine-id', 64).strip().lower()
    if not re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', boot) or not re.fullmatch('[a-f0-9]{32}', machine):
        raise CollectionError('identity_invalid')
    fingerprint = hashlib.sha256(('infra-control-host-v1\0' + machine).encode('ascii')).hexdigest()
    errors, cpu, counters, memory, rootfs = [], None, None, None, None
    try:
        counters = cpu_counters(io.read('/proc/stat', 4096))
        percent = cpu_percent(counters, previous, boot, mono)
        if percent is not None:
            cpu = {'percent': percent, 'observedAt': io.wall()}
    except (OSError, ValueError, KeyError, TypeError):
        errors.append('cpu_unavailable')
    try:
        total, available = memory_values(io.read('/proc/meminfo', 65536))
        memory = {'totalBytes': total, 'availableBytes': available, 'observedAt': io.wall()}
    except (OSError, ValueError, KeyError, TypeError):
        errors.append('memory_unavailable')
    try:
        fs = io.statvfs('/')
        total = integer(fs.f_blocks * fs.f_frsize, True)
        free, available = integer(fs.f_bfree * fs.f_frsize), integer(fs.f_bavail * fs.f_frsize)
        if available > free or free > total:
            raise ValueError('invalid filesystem')
        rootfs = {'totalBytes': total, 'freeBytes': free, 'availableBytes': available, 'observedAt': io.wall()}
    except (OSError, ValueError, TypeError):
        errors.append('filesystem_unavailable')
    status = 'complete' if memory and rootfs and not errors else 'failed' if cpu is None and memory is None and rootfs is None else 'partial'
    host = {'observedAt': io.wall(), 'status': status, 'errors': errors, 'cpu': cpu, 'memory': memory, 'rootfs': rootfs}
    docker = docker_observation(io, mono + 23)
    completed = io.wall()
    if io.read('/proc/sys/kernel/random/boot_id', 64).strip().lower() != boot:
        raise CollectionError('boot_changed')
    start_time = datetime.datetime.fromisoformat(started.replace('Z', '+00:00'))
    end_time = datetime.datetime.fromisoformat(completed.replace('Z', '+00:00'))
    if not 0 <= (end_time - start_time).total_seconds() <= 25:
        raise CollectionError('clock_invalid')
    sequence = integer(previous.get('sequence', 0)) + 1
    integer(sequence, True)
    sample = {'schemaVersion': 2, 'fingerprint': fingerprint, 'bootId': boot, 'sequence': sequence, 'startedAt': started, 'completedAt': completed, 'host': host, 'docker': docker}
    checkpoint = {'sequence': sequence, 'bootId': boot, 'cpuCounters': counters, 'monotonic': mono}
    return sample, checkpoint

def secure_directory(path, mode, gid):
    try:
        os.mkdir(path, mode)
        os.chown(path, 0, gid)
        os.chmod(path, mode)
    except FileExistsError:
        pass
    value = os.lstat(path)
    if not stat.S_ISDIR(value.st_mode) or value.st_uid != 0 or value.st_gid != gid or stat.S_IMODE(value.st_mode) != mode:
        raise CollectionError('storage_invalid')

def checkpoint_read(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        raise CollectionError('checkpoint_missing') from None
    with os.fdopen(fd, 'rb') as source:
        value = os.fstat(source.fileno())
        if not stat.S_ISREG(value.st_mode) or value.st_uid != 0 or value.st_gid != 0 or stat.S_IMODE(value.st_mode) != 0o600 or value.st_nlink != 1 or value.st_size > 65536:
            raise CollectionError('checkpoint_invalid')
        data = source.read(65537)
    try:
        result = json.loads(data)
        if set(result) != {'sequence', 'bootId', 'cpuCounters', 'monotonic'}:
            raise ValueError('invalid state')
        integer(result['sequence'], True)
        if not isinstance(result['bootId'], str) or not re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', result['bootId']):
            raise ValueError('invalid boot')
        if result['cpuCounters'] is not None:
            if not isinstance(result['cpuCounters'], list) or len(result['cpuCounters']) != 8:
                raise ValueError('invalid counters')
            for count in result['cpuCounters']:
                integer(count)
        if type(result['monotonic']) not in (int, float) or not math.isfinite(result['monotonic']) or result['monotonic'] < 0:
            raise ValueError('invalid monotonic')
        return result
    except (ValueError, TypeError, KeyError):
        raise CollectionError('checkpoint_invalid') from None

def atomic_json(directory, name, payload, mode, gid, limit):
    data = json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(data) > limit:
        raise CollectionError('snapshot_output_limit')
    fd, temporary = tempfile.mkstemp(prefix='.observer-', dir=directory)
    try:
        with os.fdopen(fd, 'wb') as output:
            os.fchown(output.fileno(), 0, gid)
            os.fchmod(output.fileno(), mode)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, os.path.join(directory, name))
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass

def publish_once(base, io, initialize=False):
    private, published = os.path.join(base, 'private'), os.path.join(base, 'published')
    checkpoint_path = os.path.join(private, 'checkpoint.json')
    marker = os.path.join(private, 'initialized.json')
    if initialize:
        paths = (marker, checkpoint_path, os.path.join(published, 'snapshot.json'), os.path.join(published, 'snapshot.v2.json'))
        if any(os.path.lexists(path) for path in paths):
            raise CollectionError('already_initialized')
        previous = {}
    else:
        previous = checkpoint_read(checkpoint_path)
    sample, checkpoint = collect(io, previous)
    legacy = {**sample, 'schemaVersion': 1, 'docker': {**sample['docker'], 'containers': [
        {key: value for key, value in container.items() if key != 'observedAt'}
        for container in sample['docker']['containers']
    ]}}
    if not os.path.lexists(marker):
        atomic_json(private, 'initialized.json', {'version': 1}, 0o600, 0, 65536)
    # Reservar la secuencia en el formato que también usa el productor anterior.
    atomic_json(private, 'checkpoint.json', checkpoint, 0o600, 0, 65536)
    atomic_json(published, 'snapshot.v2.json', sample, 0o640, 1000, MAX_BYTES)
    atomic_json(published, 'snapshot.json', legacy, 0o640, 1000, MAX_BYTES)


def main():
    arguments = sys.argv[1:]
    if arguments not in ([], ['--initialize']):
        raise CollectionError('invalid_arguments')
    if os.geteuid() != 0:
        raise CollectionError('root_required')
    for path in ('/', '/var', '/var/lib'):
        value = os.lstat(path)
        if not stat.S_ISDIR(value.st_mode) or value.st_uid != 0 or stat.S_IMODE(value.st_mode) & 0o022:
            raise CollectionError('storage_invalid')
    secure_directory(BASE, 0o750, 0)
    secure_directory(BASE + '/private', 0o700, 0)
    secure_directory(BASE + '/published', 0o750, 1000)
    lock = os.open(BASE + '/private', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        publish_once(BASE, NativeIO(), initialize=arguments == ['--initialize'])
    finally:
        os.close(lock)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Emitir solo códigos previstos de inicialización. Excluir stderr y datos del host.
        code = str(error) if isinstance(error, CollectionError) else ''
        print(code if code in ('checkpoint_missing', 'checkpoint_invalid', 'already_initialized', 'invalid_arguments') else 'host_observer_failed', file=sys.stderr)
        sys.exit(1)
