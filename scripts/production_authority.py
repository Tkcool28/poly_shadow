"""V5 public, independently pinned authority. No defaults or production discovery.
Requires rfc8785==0.1.4 and cryptography (Ed25519); no custom crypto primitive.
"""
import base64
import hashlib
import os
import stat
import types
from pathlib import Path
import rfc8785
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey, Ed25519PrivateKey

_CLOCK_PATH = Path(__file__).with_name('exact_clock.py')
_CLOCK = types.ModuleType('authority_clock')
exec(compile(_CLOCK_PATH.read_bytes(), str(_CLOCK_PATH), 'exec', dont_inherit=True), _CLOCK.__dict__)


def canonical(value):
    # Restrict integral float operands too: both runtimes must reject unsafe IDs.
    def safe(v):
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v == int(v) and abs(v) > 9007199254740991:
            raise ValueError('finite safe numeric domain')
        if isinstance(v, dict):
            for item in v.values(): safe(item)
        elif isinstance(v, list):
            for item in v: safe(item)
    safe(value)
    return rfc8785.dumps(value).decode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def public_pem(key):
    return key.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()


def fingerprint(pem):
    key = serialization.load_pem_public_key(pem.encode())
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError('authority Ed25519 key required')
    return hashlib.sha256(key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()


def validate(authority, pin, binding):
    import re
    if not isinstance(pin, str) or not re.fullmatch('[a-f0-9]{64}', pin) or digest(authority) != pin:
        raise ValueError('independent authority pin mismatch')
    if set(authority) != {'schemaVersion', 'version', 'binding', 'cohortSha256', 'requiredWriterServices', 'producerFingerprint', 'approvedUtc', 'installations'}:
        raise ValueError('complete authority schema required')
    if authority['schemaVersion'] != 1 or authority['version'] != 'poly2-production-authority-v1' or canonical(authority['binding']) != canonical(binding):
        raise ValueError('external authority binding mismatch')
    if binding['evidenceKind'] != 'observational' or any(not isinstance(binding.get(k), str) or not binding[k] for k in ('runId', 'shadowRunId', 'generationId')):
        raise ValueError('observational run/generation required')
    for field, size in [('poly2CodeSha', 40), ('shadowCodeSha', 40), ('componentSha256', 64), ('protocolDigest', 64)]:
        if not re.fullmatch('[a-f0-9]{'+str(size)+'}', binding.get(field, '')):
            raise ValueError('authority revision/protocol identity')
    cohort = binding['cohort']
    if len(cohort) != 5 or len(set(cohort)) != 5 or any(not re.fullmatch('0x[a-f0-9]{40}', w) for w in cohort) or authority['cohortSha256'] != digest(cohort):
        raise ValueError('authority cohort')
    workers = binding['expectedWorkers']
    if not workers or len(set(workers)) != len(workers) or any(not re.fullmatch('(backend|bot):[A-Za-z0-9][A-Za-z0-9._-]{0,127}', w) for w in workers) or {w.split(':')[0] for w in workers} != {'backend', 'bot'} or authority['requiredWriterServices'] != ['backend', 'bot']:
        raise ValueError('authority complete backend/bot roster')
    if _CLOCK.epoch_micros(binding['window']['endUtc']) - _CLOCK.epoch_micros(binding['window']['startUtc']) != 86400000000 or _CLOCK.epoch_micros(authority['approvedUtc']) >= _CLOCK.epoch_micros(binding['window']['startUtc']):
        raise ValueError('authority preactivation exact24h window')
    if fingerprint(binding['sourcePublicKey']) != authority['producerFingerprint']:
        raise ValueError('authority producer fingerprint')
    installations = authority['installations']
    if set(installations) != set(workers):
        raise ValueError('authority approved installation inventory')
    for worker, proof in installations.items():
        if set(proof) != {'installationSha256', 'approvedUtc'} or not re.fullmatch('[a-f0-9]{64}', proof['installationSha256']) or _CLOCK.epoch_micros(proof['approvedUtc']) > _CLOCK.epoch_micros(authority['approvedUtc']):
            raise ValueError('independently approved installation proof required')
    return authority


def signed_bytes(record, binding, authority, stream):
    # signedPayload is a retained rendering, not a second authoritative payload.
    unsigned = {k: v for k, v in record.items() if k not in ('signature', 'signedPayload')}
    return canonical(dict(domain='poly2-v5-authenticated-record-v1', stream=stream,
        authoritySha256=digest(authority), bindingSha256=digest(binding), runId=binding['runId'],
        generationId=binding['generationId'], record=unsigned)).encode()


def sign(record, binding, authority, stream, key):
    payload = signed_bytes(record, binding, authority, stream)
    record['signedPayload'] = payload.decode()
    record['signature'] = base64.b64encode(key.sign(payload)).decode()
    return record


def verify(record, binding, authority, stream):
    payload = signed_bytes(record, binding, authority, stream)
    if record.get('signedPayload') != payload.decode():
        raise ValueError('authenticated full record payload mismatch')
    key = serialization.load_pem_public_key(binding['sourcePublicKey'].encode())
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError('authority Ed25519 key required')
    key.verify(base64.b64decode(record['signature'], validate=True), payload)


def load_private_key(path, binding):
    # Open no-follow, inspect the opened descriptor: no symlink/stat race.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('private key must be owner-only regular mode0600 file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            key = serialization.load_pem_private_key(stream.read(), password=None)
    finally:
        os.close(fd)
    if not isinstance(key, Ed25519PrivateKey) or public_pem(key.public_key()) != binding['sourcePublicKey']:
        raise ValueError('private key differs from independent pinned producer')
    return key
