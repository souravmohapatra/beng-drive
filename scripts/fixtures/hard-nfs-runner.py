#!/usr/bin/env python3
"""Disposable Docker-only hard-NFS proof; never attaches to the host NAS mount."""
import os
import pathlib
import secrets
import select
import stat
import subprocess
import sys
import time

stage = pathlib.Path(sys.argv[1]).resolve(strict=True)
assert str(stage).startswith('/home/beng/bd-t03-hard-')
prefix = 'bd-t03-' + secrets.token_hex(4)
network, volume = prefix + '-net', prefix + '-vol'
server, client = prefix + '-server', prefix + '-client'
server_image, client_image = prefix + '-ganesha', prefix + '-client-image'
created = set()
fault = None
server_id = None
safe_to_clean = True


def run(*args, timeout=60):
    result = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{args!r}: exit {result.returncode}: {(result.stderr + result.stdout)[-1000:]}')
    return (result.stdout + result.stderr).strip()


def docker(*args, timeout=60):
    return run('docker', *args, timeout=timeout)


def running(name):
    return docker('inspect', '-f', '{{.State.Running}}', name) == 'true'


def paused():
    return docker('inspect', '-f', '{{.State.Paused}}', server_id) == 'true'


def watchdog(seconds, label):
    log = stage / (label + '.log')
    with log.open('w') as stream:
        proc = subprocess.Popen(['sh', str(stage / 'scripts/fixtures/watchdog.sh'), server_id, str(seconds)],
                                stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT,
                                start_new_session=True)
    print('WATCHDOG_ARMED', label, proc.pid, server_id, flush=True)
    return proc, log


def verify_host():
    assert run('hostname') == 'beng-mini-pc' and run('id', '-un') == 'beng'
    mount = run('findmnt', '-rn', '-T', '/mnt/nas/workspace', '-o', 'SOURCE,FSTYPE,OPTIONS')
    assert mount.startswith('192.168.68.67:/volume3/workspace nfs ') and 'hard' in mount
    root = pathlib.Path('/mnt/nas/workspace/beng-drive').lstat()
    assert (root.st_uid, root.st_gid, stat.S_IMODE(root.st_mode)) == (1000, 10, 0o700)
    assert not list(pathlib.Path('/mnt/nas/workspace/beng-drive').iterdir())
    return mount


before = verify_host()
print('RESOURCE_MANIFEST', prefix, 'network', network, 'volume', volume, 'server', server, 'client', client, flush=True)
try:
    print('DOCKER_SECURITY', docker('info', '--format', '{{json .SecurityOptions}}'), flush=True)
    print('CLIENT_CAP_PREFLIGHT', docker('run', '--rm', '--name', prefix + '-cap', '--network', 'none',
          '--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor=unconfined',
          'node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6',
          'sh', '-c', 'mkdir -p /tmp/bd-t03-preflight && mount -t tmpfs tmpfs /tmp/bd-t03-preflight && umount /tmp/bd-t03-preflight && echo PRIVATE_MOUNT_OK'), flush=True)
    # Build context is the caller's explicit source allowlist, never the repository root.
    for image, dockerfile in ((server_image, 'Dockerfile.hard-nfs-server'), (client_image, 'Dockerfile.hard-nfs-client')):
        digest = docker('build', '-q', '-t', image, '-f', str(stage / 'scripts/fixtures' / dockerfile), str(stage), timeout=180)
        created.add(image)
        print('IMAGE', image, digest, flush=True)
    docker('network', 'create', '--internal', network); created.add(network)
    docker('volume', 'create', volume); created.add(volume)
    server_id = docker('run', '-d', '--name', server, '--network', network, '--network-alias', 'bd-t03-server',
                       '--cap-add', 'DAC_READ_SEARCH', '--mount', f'type=volume,src={volume},dst=/export', server_image)
    created.add(server)
    for _ in range(30):
        if not running(server):
            raise RuntimeError('Ganesha exited: ' + docker('logs', server)[-1000:])
        if 'NFS SERVER INITIALIZED' in docker('logs', server):
            break
        time.sleep(.2)
    else:
        raise RuntimeError('Ganesha did not initialize')
    docker('run', '-d', '--name', client, '--network', network, '--cap-add', 'SYS_ADMIN',
           '--security-opt', 'apparmor=unconfined', client_image)
    created.add(client)
    for _ in range(30):
        if not running(client):
            raise RuntimeError('client mount denied: ' + docker('logs', client)[-1000:])
        if 'HARD_NFS_CLIENT_PREFLIGHT' in docker('logs', client):
            break
        time.sleep(.2)
    else:
        raise RuntimeError('client mount preflight did not finish')
    print('CLIENT_MOUNT', docker('exec', client, 'findmnt', '-n', '-o', 'SOURCE,FSTYPE,OPTIONS', '/data'), flush=True)
    assert 'bd-t03-server:/export' not in run('findmnt', '-rn', '-o', 'SOURCE,TARGET')
    print('SERVER_INSPECT', docker('inspect', server, '--format', 'privileged={{.HostConfig.Privileged}} cap={{json .HostConfig.CapAdd}} ports={{json .NetworkSettings.Ports}}'), flush=True)
    print('CLIENT_INSPECT', docker('inspect', client, '--format', 'privileged={{.HostConfig.Privileged}} cap={{json .HostConfig.CapAdd}} security={{json .HostConfig.SecurityOpt}} binds={{json .HostConfig.Binds}}'), flush=True)
    print('NETWORK_INTERNAL', docker('network', 'inspect', network, '--format', '{{.Internal}}'), flush=True)
    for label in ('initial', 'remounted'):
        print('WORKER_BASELINE', label, docker('exec', '--user', '1000:1000', client, 'node', '/code/scripts/fixtures/hard-nfs-probe.mjs'), flush=True)
        if label == 'initial':
            docker('exec', client, 'umount', '/data')
            docker('exec', client, 'mount', '-t', 'nfs', '-o', 'vers=3,proto=tcp,hard,nolock,port=2049,mountport=20048,timeo=10,retrans=2', 'bd-t03-server:/export', '/data', timeout=15)
    baseline_watch, baseline_log = watchdog(2, 'watchdog-baseline')
    docker('pause', server_id)
    baseline_watch.wait(timeout=8)
    assert not paused() and baseline_log.read_text().strip() == server_id
    print('WATCHDOG_BASELINE_PASS', flush=True)
    fault = subprocess.Popen(['docker', 'exec', '-i', '--user', '1000:1000', client, 'node', '/code/scripts/fixtures/hard-nfs-fault.mjs'],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    if not select.select([fault.stdout], [], [], 30)[0]:
        raise RuntimeError('fault fixture did not become ready')
    ready = fault.stdout.readline().strip()
    assert ready.startswith('FAULT_READY '), ready
    print(ready, flush=True)
    fault_watch, fault_log = watchdog(30, 'watchdog-fault')
    docker('pause', server_id)
    out, _ = fault.communicate(input='go\n', timeout=90)
    print(out, flush=True)
    assert fault.returncode == 0, f'fault fixture exit {fault.returncode}'
    assert 'FAULT_TIMEOUT_RETAINED' in out and 'FAULT_RECOVERY_PASS' in out
    fault_watch.wait(timeout=3)
    assert not paused() and fault_log.read_text().strip() == server_id
    print('HARD_NFS_PASS', flush=True)
finally:
    if server_id and server in created:
        try:
            if paused():
                print('RESTORE_SERVER', docker('unpause', server_id), flush=True)
        except Exception as error:
            safe_to_clean = False
            print('RESTORE_FAILED', error, flush=True)
    if fault and fault.poll() is None:
        try:
            fault.communicate(timeout=35)
        except subprocess.TimeoutExpired:
            safe_to_clean = False
    if safe_to_clean:
        if client in created and running(client):
            try:
                docker('exec', client, 'umount', '/data', timeout=15)
                print('CLIENT_UNMOUNTED', flush=True)
            except Exception as error:
                safe_to_clean = False
                print('UNMOUNT_FAILED', error, flush=True)
        if safe_to_clean:
            for name in (client, server):
                if name in created:
                    if running(name): docker('stop', name, timeout=25)
                    docker('rm', name)
            if network in created: docker('network', 'rm', network)
            if volume in created: docker('volume', 'rm', volume)
            for image in (client_image, server_image):
                if image in created: docker('rmi', image)
            assert verify_host() == before
            assert prefix not in docker('ps', '-a', '--format', '{{.Names}}')
            print('FIXTURE_CLEAN_PASS', prefix, flush=True)
    if not safe_to_clean:
        print('BLOCKED_CLEANUP_KEEP_LIVE_SERVER', prefix, server_id, stage, flush=True)
