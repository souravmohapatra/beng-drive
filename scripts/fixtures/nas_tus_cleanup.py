"""Exact-container writer-exit gate shared by NAS and local negative fixtures."""
import subprocess


class CleanupBlocked(RuntimeError):
    pass


def docker(*args, timeout=25, check=True):
    try:
        result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise CleanupBlocked(f'docker {args[0]} timed out for exact fixture container') from error
    if check and result.returncode:
        raise CleanupBlocked(f'docker {args[0]} failed: {(result.stderr + result.stdout)[-600:]}')
    return result


def state(container_id, expected_name):
    result = docker('inspect', '-f', '{{.Id}} {{.Name}} {{.State.Running}} {{.State.Status}}', container_id, check=False)
    if result.returncode:
        if 'no such object' in (result.stderr + result.stdout).lower():
            return None
        raise CleanupBlocked(f'cannot inspect exact container: {result.stderr[-600:]}')
    identity, name, running, status = result.stdout.strip().split(' ', 3)
    if identity != container_id or name != '/' + expected_name:
        raise CleanupBlocked(f'container identity changed: {identity} {name}')
    return running == 'true', status


def ensure_writer_exited(container_id, expected_name, *, allow_stop=True):
    """Return only after Docker confirms the exact writer container has exited."""
    current = state(container_id, expected_name)
    if current is None:
        print('WRITER_ABSENT', container_id, flush=True)
        return
    if current[0]:
        if not allow_stop:
            raise CleanupBlocked('injected cannot-stop: writer still running')
        docker('stop', '--time', '10', container_id, timeout=20)
        print('WRITER_STOP_REQUESTED', container_id, flush=True)
    docker('wait', container_id, timeout=20)
    current = state(container_id, expected_name)
    if current is not None and current[0]:
        raise CleanupBlocked(f'writer still running after stop/wait: {container_id}')
    print('WRITER_EXIT_VERIFIED', container_id, current[1] if current else 'absent', flush=True)


def clean_after_writer_exit(container_id, expected_name, clean_files, *, allow_stop=True):
    ensure_writer_exited(container_id, expected_name, allow_stop=allow_stop)
    if state(container_id, expected_name) is not None:
        docker('rm', container_id)
        print('WRITER_CONTAINER_REMOVED', container_id, flush=True)
    clean_files()
