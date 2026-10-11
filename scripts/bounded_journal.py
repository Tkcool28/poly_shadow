"""Disposable disk indexes; journal bytes alone remain authority.

No tail retention. Iterators fetch one row at a time; diagnostics paginate exact
stable IDs. Indexes are rebuilt, never trusted across process restart.
"""
import json
from collections.abc import Sequence
from itertools import zip_longest


class DiskMap:
    def __init__(self, db, table='attempt_index'):
        self.db, self.table = db, table
        db.execute(f'CREATE TABLE IF NOT EXISTS {table}(id TEXT PRIMARY KEY, body TEXT NOT NULL)')

    def __getitem__(self, key):
        row = self.db.execute(f'SELECT body FROM {self.table} WHERE id=?', (key,)).fetchone()
        if row is None:
            raise KeyError(key)
        return json.loads(row[0])

    def __setitem__(self, key, value):
        self.db.execute(f'INSERT INTO {self.table} VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', (key, json.dumps(value, sort_keys=True, separators=(',', ':'))))

    def __delitem__(self, key):
        self.db.execute(f'DELETE FROM {self.table} WHERE id=?', (key,))

    def __iter__(self):
        for row in self.db.execute(f'SELECT id FROM {self.table} ORDER BY id'):
            yield row[0]

    def __contains__(self, key):
        return self.db.execute(f'SELECT 1 FROM {self.table} WHERE id=?', (key,)).fetchone() is not None

    def get(self, key, default=None):
        try:
            return self[key]
        except KeyError:
            return default

    def __len__(self):
        return self.db.execute(f'SELECT count(*) FROM {self.table}').fetchone()[0]

    def items(self):
        for key, body in self.db.execute(f'SELECT id,body FROM {self.table} ORDER BY id'):
            yield key, json.loads(body)

    def values(self):
        for _, value in self.items():
            yield value


class DiskSequence(Sequence):
    def __init__(self, db, table='events'):
        self.db, self.table = db, table
        db.execute(f'CREATE TABLE IF NOT EXISTS {table}(seq INTEGER PRIMARY KEY, body TEXT NOT NULL)')

    def __len__(self):
        return self.db.execute(f'SELECT coalesce(max(seq),0) FROM {self.table}').fetchone()[0]

    def __getitem__(self, index):
        if isinstance(index, slice):
            raise TypeError('whole history slicing is not supported')
        if index < 0:
            index += len(self)
        row = self.db.execute(f'SELECT body FROM {self.table} WHERE seq=?', (index+1,)).fetchone()
        if row is None:
            raise IndexError(index)
        return json.loads(row[0])

    def __iter__(self):
        for row in self.db.execute(f'SELECT body FROM {self.table} ORDER BY seq'):
            yield json.loads(row[0])

    def __eq__(self, other):
        if not hasattr(other, '__iter__'):
            return False
        sentinel = object()
        return all(a == b for a, b in zip_longest(self, other, fillvalue=sentinel))

    def append(self, value):
        self.db.execute(f'INSERT INTO {self.table} VALUES(?,?)', (len(self)+1, json.dumps(value, sort_keys=True, separators=(',', ':'))))


class JournalSequence(Sequence):
    """Offset-only derived index: raw frames are never duplicated into cache."""
    def __init__(self, db, path, canonical):
        self.db, self.path, self.canonical = db, path, canonical
        db.execute('CREATE TABLE journal_offsets(seq INTEGER PRIMARY KEY, position INTEGER NOT NULL, length INTEGER NOT NULL)')

    def __len__(self):
        return self.db.execute('SELECT coalesce(max(seq),0) FROM journal_offsets').fetchone()[0]

    def __getitem__(self, index):
        if isinstance(index, slice):
            raise TypeError('whole history slicing is not supported')
        if index < 0:
            index += len(self)
        row = self.db.execute('SELECT position,length FROM journal_offsets WHERE seq=?', (index+1,)).fetchone()
        if row is None:
            raise IndexError(index)
        with self.path.open('rb') as stream:
            stream.seek(row[0])
            data = stream.read(row[1])
        if len(data) != row[1] or not data.endswith(b'\n'):
            raise ValueError('indexed authority changed/torn; rebuild required')
        return json.loads(data)

    def __iter__(self):
        with self.path.open('rb') as stream:
            for position, length in self.db.execute('SELECT position,length FROM journal_offsets ORDER BY seq'):
                stream.seek(position)
                data = stream.read(length)
                if len(data) != length or not data.endswith(b'\n'):
                    raise ValueError('indexed authority changed/torn; rebuild required')
                yield json.loads(data)

    def append(self, value, raw=None):
        length = len(raw if raw is not None else (self.canonical(value)+'\n').encode())
        row = self.db.execute('SELECT seq,position+length FROM journal_offsets ORDER BY seq DESC LIMIT 1').fetchone()
        seq, position = (row[0]+1, row[1]) if row else (1, 0)
        self.db.execute('INSERT INTO journal_offsets VALUES(?,?,?)', (seq, position, length))
