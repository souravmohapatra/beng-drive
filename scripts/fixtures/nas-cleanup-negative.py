#!/usr/bin/env python3
"""Exercise attached-CLI timeout and cannot-stop cleanup against local test data."""
import pathlib
import secrets
import subprocess
import sys

from nas_tus_cleanup import CleanupBlocked, clean_after_writer_exit, docker, state

stage = pathlib.Path(sys.argv[1]).resolve(strict=True)
assert str(stage).startswith('/home/beng/bd-t03-negative-')
assert subprocess.check_output(['hostname'], text=True).strip() == 'beng-mini-pc'
assert subprocess.check_output(['id', '-un'], text=True).strip() == 'beng'
name = 'bd-t03-negative-' + secrets.token_hex(4)
fixture = stage / 'storage'
fixture.mkdir(mode=0o700)
payload = fixture / 'payload'
container = name + '-writer'
container_id = None
cleaned = False


def clean_files():
    global cleaned
    assert payload.is_file() and payload.read_bytes() == b'owned-fixture'
    payload.unlink()
    fixture.rmdir()
    cleaned = True


print('NEGATIVE_MANIFEST', name, fixture, container, flush=True)
try:
    result = docker('create', '--name', container, '--network', 'none', '--user', '1000:1000',
                    '--mount', f'type=bind,src={fixture},dst=/data', 'python:3.13-slim',
                    'python', '-c', 'import os,time; f=open("/data/payload","xb"); f.write(b"owned-fixture"); f.flush(); os.fsync(f.fileno()); time.sleep(60)')
    container_id = result.stdout.strip()
    print('NEGATIVE_CONTAINER_CREATED', container_id, flush=True)
    try:
        subprocess.run(['docker', 'start', '-a', container_id], capture_output=True, timeout=2, check=True)
        raise AssertionError('attached Docker CLI did not time out')
    except subprocess.TimeoutExpired:
        print('ATTACHED_CLI_TIMEOUT', container_id, flush=True)
    assert state(container_id, container)[0] is True
    assert payload.read_bytes() == b'owned-fixture'
    try:
        clean_after_writer_exit(container_id, container, clean_files, allow_stop=False)
        raise AssertionError('cannot-stop injection did not block cleanup')
    except CleanupBlocked:
        assert state(container_id, container)[0] is True
        assert payload.read_bytes() == b'owned-fixture' and not cleaned
        print('BLOCKED_RETAIN_PASS', container_id, fixture, flush=True)
    clean_after_writer_exit(container_id, container, clean_files)
    assert cleaned and not fixture.exists() and state(container_id, container) is None
    print('NEGATIVE_CLEAN_PASS', container_id, flush=True)
finally:
    if not cleaned:
        try:
            if container_id:
                clean_after_writer_exit(container_id, container, clean_files)
        except CleanupBlocked as error:
            print('BLOCKED_CLEANUP_RETAIN', container_id, fixture, stage, error, flush=True)
            raise
