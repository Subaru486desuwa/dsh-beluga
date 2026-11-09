"""Validate the parts Beluga writes by hand against the ECMA-376 transitional schemas.

Excel refuses or "repairs" a file whose parts break the schema, element order included, while
LibreOffice and most readers accept it. This check stands in for opening the file in Excel.

    .artifacts/office-baseline/venv/bin/python -I scripts/ooxml-schema-check.py book.xlsx ...

The schemas come from ECMA-376 Part 4, downloaded once into .artifacts/ecma-376/ and checked against
a pinned digest. Attributes and elements in namespaces a part marks mc:Ignorable are dropped before
validation, as Office does. Exits 1 when any part is invalid.
"""
import hashlib
import io
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

from lxml import etree

SOURCE = 'https://ecma-international.org/wp-content/uploads/ECMA-376-4_5th_edition_december_2016.zip'
DIGEST = 'bd25da1109f73762356596918bf5ff8b74a1331642dba5f1c1d1dfc6bed34ecd'
CACHE = Path(__file__).resolve().parent.parent / '.artifacts' / 'ecma-376'
MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
# Part name pattern -> schema. Extend this as more parts are written by hand.
PARTS = [
    (re.compile(r'xl/charts/chart\d+\.xml$'), 'dml-chart.xsd'),
    (re.compile(r'xl/drawings/drawing\d+\.xml$'), 'dml-spreadsheetDrawing.xsd'),
    (re.compile(r'xl/worksheets/sheet\d+\.xml$'), 'sml.xsd'),
]


def schemas_dir() -> Path:
    target = CACHE / 'xsd'
    if (target / 'sml.xsd').exists():
        return target
    archive = CACHE / 'part4.zip'
    if not archive.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(SOURCE, timeout=120) as response:
            archive.write_bytes(response.read())
    if hashlib.sha256(archive.read_bytes()).hexdigest() != DIGEST:
        archive.unlink()
        sys.exit('The downloaded ECMA-376 archive does not match its pinned digest')
    inner = zipfile.ZipFile(io.BytesIO(zipfile.ZipFile(archive).read('OfficeOpenXML-XMLSchema-Transitional.zip')))
    target.mkdir(exist_ok=True)
    for name in inner.namelist():
        if name.endswith('.xsd'):
            (target / Path(name).name).write_bytes(inner.read(name))
    return target


def without_ignorable(root):
    spaces = {root.nsmap.get(prefix) for prefix in (root.get(f'{{{MC}}}Ignorable') or '').split()} | {MC}
    namespace = lambda name: name[1:name.index('}')] if isinstance(name, str) and name.startswith('{') else None
    for node in list(root.iter()):
        for key in list(node.attrib):
            if namespace(key) in spaces:
                del node.attrib[key]
        if namespace(node.tag) in spaces and node.getparent() is not None:
            node.getparent().remove(node)
    return root


def main(paths: list[str]) -> int:
    directory = schemas_dir()
    loaded: dict[str, etree.XMLSchema] = {}
    invalid = 0
    for path in paths:
        package = zipfile.ZipFile(path)
        for name in sorted(package.namelist()):
            schema_name = next((schema for pattern, schema in PARTS if pattern.match(name)), None)
            if schema_name is None:
                continue
            schema = loaded.get(schema_name) or loaded.setdefault(schema_name, etree.XMLSchema(etree.parse(str(directory / schema_name))))
            if schema.validate(without_ignorable(etree.fromstring(package.read(name)))):
                print(f'valid    {path} {name}')
                continue
            invalid += 1
            print(f'INVALID  {path} {name}')
            for error in list(schema.error_log)[:5]:
                print(f'         line {error.line}: {error.message}')
    return 1 if invalid else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]) if len(sys.argv) > 1 else 'Usage: ooxml-schema-check.py FILE.xlsx ...')
