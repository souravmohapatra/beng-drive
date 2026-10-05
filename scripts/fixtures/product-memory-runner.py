#!/usr/bin/env python3
"""Run product-route RSS sampling in exact disposable Docker containers."""
import pathlib
import secrets
import subprocess
import sys

stage = pathlib.Path(sys.argv[1]).resolve(strict=True)
assert str(stage).startswith('/home/beng/bd-t09-rss-')
assert subprocess.check_output(['hostname'], text=True).strip() == 'beng-mini-pc'
assert subprocess.check_output(['id', '-un'], text=True).strip() == 'beng'
prefix = 'bd-t09-rss-' + secrets.token_hex(4)
image = 'node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6'
created = []
safe = True


def docker(*args, timeout=150):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'docker {args[0]} failed: {(result.stderr + result.stdout)[-1200:]}')
    return result.stdout.strip()


def run_container(label, command, network):
    global safe
    name = prefix + '-' + label
    cid = docker('create', '--name', name, '--network', network, '--user', '1000:1000',
                 '--mount', f'type=bind,src={stage},dst=/code', '--workdir', '/code',
                 '--env', 'npm_config_cache=/tmp/bd-npm-cache', image, *command)
    created.append((cid, name))
    print('FIXTURE_CONTAINER', label, cid, flush=True)
    try:
        output = docker('start', '-a', cid, timeout=150)
        state = docker('inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', cid)
        if not state.startswith('false '):
            safe = False
            raise RuntimeError(f'exit unverified for {cid}: {state}')
        print(output[-5000:], flush=True)
        if state != 'false 0':
            raise RuntimeError(f'{label} exited {state}')
        docker('rm', cid)
        created.remove((cid, name))
        return output
    except Exception:
        state = docker('inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', cid)
        if state.startswith('true '):
            try:
                docker('stop', '-t', '5', cid, timeout=15)
                state = docker('inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', cid)
            except Exception:
                safe = False
        if not state.startswith('false '):
            safe = False
            print('RETAIN_UNVERIFIED', cid, stage, flush=True)
        raise


print('FIXTURE_MANIFEST', prefix, stage, flush=True)
try:
    run_container('install', ['npm', 'ci', '--omit=dev', '--ignore-scripts'], 'bridge')
    output = run_container('measure', ['node', '--test', '--test-name-pattern=paired 16/128', 'test/uploads.test.mjs'], 'none')
    if 'PRODUCT_WORKER_RSS' not in output or 'pass 1' not in output:
        raise RuntimeError('Product worker RSS assertion missing')
    print('PRODUCT_MEMORY_PASS', flush=True)
finally:
    for cid, name in list(created):
        try:
            state = docker('inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', cid)
            if state.startswith('true '):
                docker('stop', '-t', '5', cid, timeout=15)
                state = docker('inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', cid)
            if state.startswith('false '):
                docker('rm', cid)
                created.remove((cid, name))
            else:
                safe = False
        except Exception:
            safe = False
    if safe and not created:
        print('FIXTURE_CONTAINERS_CLEAN_PASS', prefix, flush=True)
    else:
        print('FIXTURE_RETAINED', prefix, stage, created, flush=True)
