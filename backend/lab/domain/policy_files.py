"""Read a communication policy as text; parsing never changes active inputs."""

import io
import zlib
from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZIP_DEFLATED, ZIP_STORED, BadZipFile, ZipFile

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
LIMIT = 2_000_000  # the uploaded file
TEXT_LIMIT = 1_000_000  # the text of a .docx, unpacked


def _text_part(archive: ZipFile) -> bytes:
    """The document's text, unpacked a piece at a time: the size an archive declares can lie, and a zip bomb stops at
    TEXT_LIMIT instead of filling memory. Word deflates; other methods unpack without a bound on each piece."""
    info = archive.getinfo('word/document.xml')
    if info.flag_bits & 1 or info.compress_type not in (ZIP_STORED, ZIP_DEFLATED):
        raise BadZipFile('encrypted or unusual compression')
    data = bytearray()
    with archive.open(info) as part:
        while piece := part.read(1 << 16):
            data += piece
            if len(data) > TEXT_LIMIT:
                raise ValueError('Документ слишком большой. Оставьте только правила общения.')
    return bytes(data)


def _docx(data: bytes) -> str:
    try:
        with ZipFile(io.BytesIO(data)) as archive:
            root = ElementTree.fromstring(_text_part(archive))
    except (BadZipFile, KeyError, ElementTree.ParseError, zlib.error, EOFError, NotImplementedError) as error:
        raise ValueError('Не удалось прочитать документ Word. Сохраните его заново в .docx.') from error
    paragraphs = []
    for paragraph in root.iter(W + 'p'):
        parts = []
        for node in paragraph.iter():
            if node.tag == W + 't':
                parts.append(node.text or '')
            elif node.tag in (W + 'br', W + 'cr'):
                parts.append('\n')
            elif node.tag == W + 'tab':
                parts.append('\t')
        text = ''.join(parts).strip()
        if text:
            paragraphs.append(text)
    return '\n'.join(paragraphs)


def read(name: str, data: bytes) -> str:
    if len(data) > LIMIT:
        raise ValueError('Файл больше 2\u00a0МБ. Оставьте в файле только правила общения.')
    extension = Path(name).suffix.lower()
    if extension == '.docx':
        text = _docx(data)
    elif extension in ('.txt', '.md'):
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError as error:
            raise ValueError('Файл не в кодировке UTF-8. Сохраните его в UTF-8 или загрузите .docx.') from error
    else:
        raise ValueError('Загрузите правила в формате .docx, .txt или .md.')
    if not 20 <= len(text.strip()) <= 50000:
        raise ValueError('В правилах должно быть от 20 до 50 000 символов.')
    return text.strip()
