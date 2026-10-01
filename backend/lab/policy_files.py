"""Read a communication policy as text; parsing never changes active inputs."""

import io
from pathlib import Path
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def _docx(data: bytes) -> str:
    try:
        with ZipFile(io.BytesIO(data)) as archive:
            info = archive.getinfo('word/document.xml')
            if info.file_size > 1_000_000:
                raise ValueError('Документ слишком большой. Оставьте только правила общения.')
            root = ElementTree.fromstring(archive.read(info))
    except (BadZipFile, KeyError, ElementTree.ParseError) as error:
        raise ValueError('Не удалось прочитать документ Word. Загрузите файл .docx.') from error
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
    if len(data) > 2_000_000:
        raise ValueError('Файл слишком большой: не более 2 МБ.')
    extension = Path(name).suffix.lower()
    if extension == '.docx':
        text = _docx(data)
    elif extension in ('.txt', '.md'):
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError as error:
            raise ValueError('Сохраните текстовый файл в UTF-8 или загрузите .docx.') from error
    else:
        raise ValueError('Загрузите правила в формате .docx, .txt или .md.')
    if not 20 <= len(text.strip()) <= 50000:
        raise ValueError('В правилах должно быть от 20 до 50 000 символов.')
    return text.strip()
