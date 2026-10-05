#!/usr/bin/env python3
"""Run 128 MiB tus against an exact NAS bind with a verified writer-exit gate."""
import pathlib
import re
import secrets
import stat
import subprocess
import sys

from nas_tus_cleanup import CleanupBlocked, clean_after_writer_exit, docker

stage = pathlib.Path(sys.argv[1]).resolve(strict=True)
assert str(stage).startswith('/home/beng/bd-t03-nas-')
root = pathlib.Path('/mnt/nas/workspace/beng-drive')
name = 'bd-t03-' + secrets.token_hex(8)
fixture = root / name
image = name + '-nas-tus'
container = name + '-transfer'
container_id = None
created_image = False
created_fixture = False
transfer_error = None


def run(*args, timeout=180):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{args!r}: exit {result.returncode}: {(result.stdout + result.stderr)[-3000:]}')
    return (result.stdout + result.stderr).strip()


def verify_root(empty):
    source = run('findmnt', '-rn', '-T', str(root), '-o', 'SOURCE,FSTYPE')
    info = root.lstat()
    acl = run('getfacl', '-cp', str(root)).splitlines()
    assert source == '192.168.68.67:/volume3/workspace nfs'
    assert (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (1000, 10, 0o700)
    assert acl == ['user::rwx', 'group::---', 'other::---']
    if empty: assert not list(root.iterdir())
    return source


def clean_generated_files():
    paths = sorted(fixture.rglob('*'), key=lambda p: len(p.parts), reverse=True)
    for path in paths:
        relative = path.relative_to(fixture)
        assert len(relative.parts) <= 3 and not path.is_symlink(), relative
        if path.is_file():
            assert relative.parts[0] in ('partials', 'completed')
            if relative.parts[0] == 'partials':
                assert re.fullmatch(r'[0-9a-f]{32}(?:\.part|\.json)?', path.name)
            else:
                assert relative.parts[1] == '00000000-0000-4000-8000-000000000001'
                assert re.fullmatch(r'[0-9a-f]{32}-fixture\.bin', path.name)
            assert path.lstat().st_uid == 1000
        else:
            assert path.is_dir() and path.name in ('partials', 'completed', '00000000-0000-4000-8000-000000000001')
    for path in paths:
        if path.is_file(): path.unlink()
        else:
            path.rmdir()
    fixture.rmdir()


assert run('hostname') == 'beng-mini-pc' and run('id', '-un') == 'beng'
verify_root(True)
print('NAS_RESOURCE_MANIFEST', name, 'stage', stage, 'fixture', fixture, 'container', container, 'image', image, flush=True)
try:
    print('NAS_IMAGE', run('docker', 'build', '-q', '-t', image, '-f', str(stage / 'scripts/fixtures/Dockerfile.nas-tus'), str(stage)), flush=True)
    created_image = True
    fixture.mkdir(mode=0o700)
    created_fixture = True
    info = fixture.lstat()
    assert (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (1000, 1000, 0o700)
    source = f'192.168.68.67:/volume3/workspace/beng-drive/{name}'
    container_id = run('docker', 'create', '--name', container, '--network', 'none', '--user', '1000:1000',
                       '--memory', '384m', '--mount', f'type=bind,src={fixture},dst=/data',
                       '-e', f'FIXTURE_NFS_SOURCE={source}', image)
    print('NAS_CONTAINER_CREATED', container_id, flush=True)
    try:
        attached = subprocess.run(['docker', 'start', '-a', container_id], capture_output=True, text=True, timeout=180)
        output = (attached.stdout + attached.stderr).strip()
        print(output, flush=True)
        if attached.returncode or 'NAS_TUS_PASS' not in output:
            transfer_error = RuntimeError(f'NAS tus transfer failed: CLI exit {attached.returncode}')
    except subprocess.TimeoutExpired as error:
        partial = error.stdout or b''
        if isinstance(partial, bytes): partial = partial.decode('utf8', 'replace')
        print('NAS_ATTACHED_CLI_TIMEOUT', container_id, partial[-1000:], flush=True)
        transfer_error = RuntimeError('attached Docker CLI timed out; container exit requires separate proof')
except BaseException as error:
    transfer_error = error
finally:
    if created_fixture:
        try:
            if container_id is None:
                inspected = docker('inspect', '-f', '{{.Id}}', container, check=False)
                if inspected.returncode == 0:
                    container_id = inspected.stdout.strip()
                elif 'no such object' not in (inspected.stdout + inspected.stderr).lower():
                    raise CleanupBlocked(f'cannot establish fixture container state: {inspected.stderr[-600:]}')
            if container_id:
                clean_after_writer_exit(container_id, container, clean_generated_files)
            else:
                clean_generated_files()
        except CleanupBlocked as error:
            print('BLOCKED_CLEANUP_RETAIN', 'container', container_id or container,
                  'fixture', fixture, 'image', image, 'stage', stage, 'reason', error, flush=True)
            raise
    if created_image:
        run('docker', 'rmi', image)
    verify_root(True)
    assert container not in run('docker', 'ps', '-a', '--format', '{{.Names}}')
    print('NAS_FIXTURE_CLEAN_PASS', name, flush=True)

if transfer_error:
    raise transfer_error
