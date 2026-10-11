import importlib.util
import tempfile
import unittest
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = Path(__file__).resolve().parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
A = load('authority', 'scripts/production_authority.py')
F = load('fence', 'scripts/poly2-comparison-fence.py')

def fixture():
    key = Ed25519PrivateKey.generate()
    b = dict(runId='disposable', shadowRunId='shadow-disposable', poly2CodeSha='1'*40,
        shadowCodeSha='2'*40, componentSha256='3'*64, protocolDigest='4'*64, generationId='disposable-generation',
        cohort=['0x'+str(i)*40 for i in range(1,6)], window=dict(startUtc='2026-01-01T00:00:00Z',endUtc='2026-01-02T00:00:00Z'),
        expectedWorkers=['backend:test','bot:test','bot:second'], evidenceKind='observational', sourcePublicKey=A.public_pem(key.public_key()))
    a = dict(schemaVersion=1,version='poly2-production-authority-v1',binding=b,cohortSha256=A.digest(b['cohort']),
        requiredWriterServices=['backend','bot'],producerFingerprint=A.fingerprint(b['sourcePublicKey']),approvedUtc='2025-12-31T23:00:00Z',
        installations={w:dict(installationSha256='5'*64,approvedUtc='2025-12-31T22:00:00Z') for w in b['expectedWorkers']})
    return b,a,key

class AuthorityTests(unittest.TestCase):
    def test_external_pin(self):
        b,a,key=fixture()
        A.validate(a,A.digest(a),b)
        with self.assertRaises(ValueError): A.validate(a,'0'*64,b)
    def test_full_record_signature(self):
        b,a,key=fixture()
        record=dict(seq=1,observedUtc='2025-12-31T23:30:00Z',payload={'unicode':'é😀','number':1e-7},kind='ARM')
        A.sign(record,b,a,'fence',key); A.verify(record,b,a,'fence')
        record['seq']=2
        with self.assertRaises(ValueError): A.verify(record,b,a,'fence')
    def test_production_arm_enroll_admit_restart(self):
        b,a,key=fixture(); pin=A.digest(a)
        with tempfile.TemporaryDirectory() as directory:
            fence=F.Fence(directory,b,authority=a,authority_pin=pin,private_key=key,read_clock=lambda:'2025-12-31T23:30:00Z')
            with self.assertRaises(ValueError): fence._admit('bot:test')
            for w in b['expectedWorkers']: fence.enroll(w)
            fence._admit('bot:test'); fence.close()
            fence=F.Fence(directory,b,authority=a,authority_pin=pin,private_key=key,read_clock=lambda:'2025-12-31T23:30:00Z')
            self.assertEqual(len(fence.state()['workers']),3); fence.close()
    def test_private_key_external_owner_mode_symlink_and_mismatch(self):
        from cryptography.hazmat.primitives import serialization
        b,a,key=fixture()
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'disposable-key.pem'
            path.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
            path.chmod(0o600); self.assertIsNotNone(A.load_private_key(path,b))
            path.chmod(0o644)
            with self.assertRaises(ValueError): A.load_private_key(path,b)
            path.chmod(0o600); link=Path(directory)/'link';link.symlink_to(path)
            with self.assertRaises(OSError): A.load_private_key(link,b)
            other=Ed25519PrivateKey.generate()
            path.write_bytes(other.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
            with self.assertRaises(ValueError): A.load_private_key(path,b)
    def test_wrong_key_authority_or_pin_denied_before_spool_creation(self):
        b,a,key=fixture()
        with tempfile.TemporaryDirectory() as directory:
            for name,params in [('pin',dict(authority=a,authority_pin='0'*64,private_key=key)),('key',dict(authority=a,authority_pin=A.digest(a),private_key=Ed25519PrivateKey.generate())),('authority',dict(private_key=key))]:
                path=Path(directory)/name
                with self.assertRaises(ValueError): F.Fence(path,b,**params)
                self.assertFalse(path.exists())
    def test_each_instance_enrollment_and_ack_required_across_restart(self):
        b,a,key=fixture()
        for missing in b['expectedWorkers']:
            with self.subTest(missing=missing),tempfile.TemporaryDirectory() as directory:
                now=['2025-12-31T23:30:00Z']
                def open_fence(): return F.Fence(directory,b,authority=a,authority_pin=A.digest(a),private_key=key,read_clock=lambda:now[0])
                f=open_fence()
                for w in b['expectedWorkers']:
                    if w!=missing: f.enroll(w)
                f.close();f=open_fence()
                with self.assertRaises(ValueError): f._admit(next(w for w in b['expectedWorkers'] if w!=missing))
                f.enroll(missing);now[0]='2026-01-02T00:00:00.000001Z';f.close_epoch()
                for w in b['expectedWorkers']:
                    if w!=missing: f._ack(w)
                f.close();f=open_fence();self.assertIsNone(f.complete());f._ack(missing);self.assertIsNotNone(f.complete());f.close()
    def test_changed_run_or_generation_replay_and_tampered_authenticated_database_denied(self):
        import copy
        import sqlite3
        import json
        for field in ('runId','generationId'):
            b,a,key=fixture()
            with tempfile.TemporaryDirectory() as directory:
                f=F.Fence(directory,b,authority=a,authority_pin=A.digest(a),private_key=key,read_clock=lambda:'2025-12-31T23:30:00Z');f.close()
                changed=copy.deepcopy(a);changed['binding'][field]+='-other'
                with self.assertRaises(ValueError): F.Fence(directory,changed['binding'],authority=changed,authority_pin=A.digest(changed),private_key=key,read_clock=lambda:'2025-12-31T23:30:00Z')
                db=sqlite3.connect(Path(directory)/'source_fence.sqlite');e=json.loads(db.execute('SELECT body FROM events WHERE seq=1').fetchone()[0]);e['observedUtc']='2025-12-31T23:31:00Z';e['signedPayload']=A.signed_bytes(e,b,a,'fence').decode();db.execute('UPDATE events SET body=? WHERE seq=1',(A.canonical(e),));db.commit();db.close()
                with self.assertRaises(Exception): F.Fence(directory,b,authority=a,authority_pin=A.digest(a),private_key=key)
    def test_observational_synthetic_only_denied(self):
        b,a,key=fixture()
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError): F.Fence(directory,b)

if __name__=='__main__': unittest.main()
