"""Focused launcher extraction safety tests; no Node/npm installation required."""
import io
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packaging/python/src"))
from relay_gateway.cli import extract_runtime


class ExtractionTests(unittest.TestCase):
    def archive(self, root, name, kind=tarfile.REGTYPE):
        path = root / "runtime.tgz"
        with tarfile.open(path, "w:gz") as archive:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.linkname = "../../outside"
            member.size = 2 if kind == tarfile.REGTYPE else 0
            archive.addfile(member, io.BytesIO(b"ok") if member.size else None)
        return path

    def test_rejects_escaping_paths_and_links(self):
        for name, kind in [("package/../../outside", tarfile.REGTYPE), ("package/..\\..\\outside", tarfile.REGTYPE), ("package/C:/outside", tarfile.REGTYPE), ("/outside", tarfile.REGTYPE), ("elsewhere/file", tarfile.REGTYPE), ("package/link", tarfile.SYMTYPE), ("package/hard", tarfile.LNKTYPE)]:
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                with self.assertRaises(RuntimeError):
                    extract_runtime(self.archive(root, name, kind), root / "out")

    def test_extracts_ordinary_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            extract_runtime(self.archive(root, "package/build/cli.js"), root / "out")
            self.assertEqual((root / "out/package/build/cli.js").read_text(), "ok")


if __name__ == "__main__":
    unittest.main()
