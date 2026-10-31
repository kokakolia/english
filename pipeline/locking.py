"""Общая файловая блокировка для потоков и процессов; ОС снимает её при выходе."""
from __future__ import annotations

import errno
import os
import time
from contextlib import contextmanager
from pathlib import Path
from functools import wraps


@contextmanager
def exclusive_file_lock(path: Path, timeout: float = 60):
    path.parent.mkdir(parents=True, exist_ok=True)
    # Файл не удаляется: иначе ожидающий процесс мог бы блокировать старый inode.
    with path.open("a+b") as stream:
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b"\0")
            stream.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                stream.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"файл занят другим процессом: {path}") from exc
                time.sleep(0.02)
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def serialized_file_update(path):
    """Блокирует всю операцию чтение–изменение–запись, а не только замену файла.

    Путь вычисляется при вызове: настройки хранилища могут меняться в тестах.
    """
    def decorate(operation):
        @wraps(operation)
        def locked(*args, **kwargs):
            target = path()
            with exclusive_file_lock(target.with_name(target.name + ".lock")):
                return operation(*args, **kwargs)
        return locked
    return decorate
