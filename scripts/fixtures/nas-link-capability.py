#!/usr/bin/env python3
"""Exact disposable same-filesystem link/fsync proof under beng-drive."""
import hashlib
import os
import pathlib
import secrets
import stat
import subprocess
import sys

root = pathlib.Path('/mnt/nas/workspace/beng-drive')


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def writer(fixture):
    partials, completed = fixture / 'partials', fixture / 'completed'
    os.mkdir(partials, 0o700)
    os.mkdir(completed, 0o700)
    sync_dir(fixture)
    source, final, competing = partials / 'source.part', completed / 'final.bin', partials / 'competing.part'
    payload = bytes(range(256)) * 256
    expected = hashlib.sha256(payload).hexdigest()
    fd = os.open(source, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, payload)
        os.fsync(fd)
    finally: os.close(fd)
    sync_dir(partials)
    os.link(source, final)
    source_stat, final_stat = source.lstat(), final.lstat()
    assert source_stat.st_dev == final_stat.st_dev and source_stat.st_ino == final_stat.st_ino
    sync_dir(completed)
    fd = os.open(competing, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try: os.write(fd, b'foreign'); os.fsync(fd)
    finally: os.close(fd)
    try: os.link(competing, final)
    except FileExistsError: pass
    else: raise RuntimeError('exclusive link overwrote existing final')
    assert final.lstat().st_ino == final_stat.st_ino
    os.unlink(source)
    sync_dir(partials)
    assert hashlib.sha256(final.read_bytes()).hexdigest() == expected
    assert stat.S_IMODE(final.lstat().st_mode) == 0o600
    print('NAS_LINK_WRITER_PASS', fixture.name, expected, 'inode', final_stat.st_ino, flush=True)


def main():
    assert subprocess.check_output(['hostname'], text=True).strip() == 'beng-mini-pc'
    assert subprocess.check_output(['id', '-un'], text=True).strip() == 'beng'
    mount = subprocess.check_output(['findmnt', '-rn', '-T', str(root), '-o', 'SOURCE,FSTYPE,OPTIONS'], text=True).strip()
    assert mount.startswith('192.168.68.67:/volume3/workspace nfs ') and 'hard' in mount
    st = root.lstat()
    assert st.st_uid == 1000 and st.st_gid == 10 and stat.S_IMODE(st.st_mode) == 0o700
    name = 'bd-t10-link-' + secrets.token_hex(8)
    fixture = root / name
    os.mkdir(fixture, 0o700)
    print('NAS_LINK_FIXTURE', name, flush=True)
    child = subprocess.run([sys.executable, __file__, 'writer', str(fixture)], capture_output=True, text=True, timeout=45)
    print('WRITER_EXIT', child.returncode, flush=True)
    print(child.stdout[-1000:], flush=True)
    if child.returncode or 'NAS_LINK_WRITER_PASS' not in child.stdout:
        print('FIXTURE_RETAINED', name, child.stderr[-500:], flush=True)
        raise RuntimeError('NAS link capability failed; exact fixture retained')
    # The exact writer has exited; remove only its known names.
    (fixture / 'completed' / 'final.bin').unlink()
    (fixture / 'partials' / 'competing.part').unlink()
    (fixture / 'partials').rmdir()
    (fixture / 'completed').rmdir()
    fixture.rmdir()
    print('NAS_LINK_PASS', name, flush=True)
    print('FIXTURE_CLEAN_PASS', name, flush=True)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'writer': writer(pathlib.Path(sys.argv[2]))
    elif len(sys.argv) == 1: main()
    else: raise SystemExit('Invalid fixture invocation')
