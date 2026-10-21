import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC=importlib.util.spec_from_file_location('resource_runner',Path(__file__).resolve().parents[1]/'scripts/uncertified-diagnostic-runner.py')
R=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(R)

class DiagnosticResources(unittest.TestCase):
    def test_finite_kernel_resource_controls_are_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); leaf=root/'fixture';leaf.mkdir(); membership=root/'membership';membership.write_text('0::/fixture\n')
            good={'memory.max':str(4*1024**3),'memory.swap.max':'0','pids.max':'128','cpu.max':'100000 100000'}
            for key,value in good.items():(leaf/key).write_text(value)
            result=R.resource_envelope(root,membership)
            self.assertEqual(result['enforcement'],'KERNEL_CGROUP_V2')
            for key,value in [('memory.max','max'),('memory.swap.max','max'),('pids.max','max'),('cpu.max','max 100000'),('cpu.max','200000 100000')]:
                with self.subTest(key=key,value=value):
                    (leaf/key).write_text(value)
                    with self.assertRaisesRegex(RuntimeError,'FINITE_RESOURCE'):R.resource_envelope(root,membership)
                    (leaf/key).write_text(good[key])

    def test_disk_monitor_counts_sqlite_wal_and_refuses_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'racing-index.sqlite-wal').write_bytes(b'12345678901')
            with self.assertRaisesRegex(RuntimeError,'DISK_CAP'):R.check_retained_limit(root,10)
            self.assertEqual(R.check_retained_limit(root,11),11)
            (root/'linked').symlink_to(root/'racing-index.sqlite-wal')
            with self.assertRaisesRegex(RuntimeError,'FILE_LIMIT'):R.check_retained_limit(root,100)

    def test_evidence_references_are_relative_and_hashed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'shadow-data').mkdir();(root/'shadow-data'/'source_observations.ndjson').write_bytes(b'{}\n')
            inventory=R.evidence_inventory(root)
            self.assertFalse(inventory['rawEvidencePublic'])
            self.assertEqual(inventory['files'][0]['file'],'shadow-data/source_observations.ndjson')
            self.assertEqual(len(inventory['files'][0]['sha256']),64)
