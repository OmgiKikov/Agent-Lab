#!/usr/bin/env python3
"""Loopback API for the LangWatch review page. Uses the existing local session."""
import base64
import csv
import io
import json
import os
import posixpath
import re
import threading
import urllib.error
import urllib.request
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.etree import ElementTree as ET

import review_engine as engine

IMPORTS = {}
MUTATION_LOCK = threading.Lock()
ORIGINS = {'http://localhost:5560', 'http://127.0.0.1:5560'}


def spreadsheet(data):
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if sum(x.file_size for x in archive.infolist()) > 50_000_000:
            raise ValueError('Распакованная таблица превышает 50 МБ')
        shared = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            shared = [''.join(x.itertext()) for x in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('m:si', ns)]
        names = {}
        if 'xl/workbook.xml' in archive.namelist() and 'xl/_rels/workbook.xml.rels' in archive.namelist():
            relns = {'r': 'http://schemas.openxmlformats.org/package/2006/relationships'}
            relationships = {r.attrib['Id']: r.attrib['Target'] for r in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels')).findall('r:Relationship', relns)}
            for sheet in ET.fromstring(archive.read('xl/workbook.xml')).findall('m:sheets/m:sheet', ns):
                target = relationships.get(sheet.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'))
                if target:
                    filename = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/' + target)
                    names[filename] = sheet.attrib.get('name', 'Лист')
        files = sorted(x for x in archive.namelist() if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', x))
        sheets = []
        for filename in files:
            rows = []
            for row in ET.fromstring(archive.read(filename)).findall('.//m:sheetData/m:row', ns):
                cells = {}
                for cell in row.findall('m:c', ns):
                    letters = re.match(r'[A-Z]+', cell.attrib.get('r', 'A1')).group()
                    index = 0
                    for letter in letters:
                        index = index * 26 + ord(letter) - 64
                    value = cell.find('m:v', ns)
                    text = value.text if value is not None and value.text else ''
                    if cell.attrib.get('t') == 's':
                        text = shared[int(text)] if text else ''
                    elif cell.attrib.get('t') == 'inlineStr':
                        inline = cell.find('m:is', ns)
                        text = ''.join(inline.itertext()) if inline is not None else ''
                    cells[index-1] = text
                if cells:
                    rows.append([cells.get(i, '') for i in range(max(cells)+1)])
            if rows:
                headers = rows[0]
                if len(headers) != len(set(headers)):
                    continue
                sheets.append((names.get(filename, 'Лист ' + str(len(sheets)+1)), [{h: row[i] if i < len(row) else '' for i, h in enumerate(headers)} for row in rows[1:]]))
        if not sheets:
            raise ValueError('Не удалось найти лист с уникальными заголовками')
        return sheets


def parse(name, data):
    if name.lower().endswith('.xlsx'):
        return spreadsheet(data)
    text = data.decode('utf-8-sig')
    if name.lower().endswith('.csv'):
        dialect = csv.Sniffer().sniff(text[:10000], delimiters=',;\t')
        return [('CSV', list(csv.DictReader(io.StringIO(text), dialect=dialect)))]
    if name.lower().endswith(('.json', '.jsonl')):
        if name.lower().endswith('.jsonl'):
            rows = [json.loads(line) for line in text.splitlines() if line.strip()]
        else:
            rows = json.loads(text)
            if isinstance(rows, dict):
                rows = rows.get('dialogues', rows.get('data', [rows]))
        if not isinstance(rows, list) or not all(isinstance(x, dict) for x in rows):
            raise ValueError('Ожидается список объектов с колонками ID и текста разговора')
        return [('JSON', rows)]
    raise ValueError('Для логов выберите XLSX, CSV, JSON или JSONL')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        origin = self.headers.get('Origin')
        if origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Credentials', 'true')
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if self.headers.get('Origin') not in ORIGINS:
            return self.respond(403, {'error': 'Запрос с другого сайта запрещён'})
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
        self.send_header('Access-Control-Allow-Credentials', 'true')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.end_headers()

    def authenticated(self):
        if self.headers.get('Origin') not in ORIGINS:
            raise PermissionError('Откройте страницу проверки из локального LangWatch')
        request = urllib.request.Request(engine.BASE + '/api/auth/get-session', headers={'Cookie': self.headers.get('Cookie', '')})
        with urllib.request.urlopen(request, timeout=5) as response:
            session = json.load(response)
        # This local pilot serves the seeded owner only, not arbitrary signed-in accounts.
        if not session or session.get('user', {}).get('email') != 'local@langwatch.dev':
            raise PermissionError('Войдите в локальный LangWatch как local@langwatch.dev')

    def do_GET(self):
        if self.path == '/health':
            return self.respond(200, {'status': 'ok'})
        try:
            self.authenticated()
            if self.path == '/bootstrap':
                result = engine.catalog()
            elif self.path.startswith('/job/'):
                result = engine.read(self.path.split('/')[-1])
            elif self.path.startswith('/run/'):
                job_id, finding_id = self.path.split('/')[2:]
                finding = engine.find(engine.read(job_id), finding_id)
                result = engine.command('simulation-run', 'get', finding['run_id'])
            else:
                return self.respond(404, {'error': 'Страница не найдена'})
            self.respond(200, result)
        except PermissionError as error:
            self.respond(401, {'error': str(error)})
        except Exception as error:
            self.respond(400, {'error': str(error)[:250]})

    def do_POST(self):
        try:
            self.authenticated()
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 22_000_000:
                raise ValueError('Размер запроса превышает 22 МБ')
            data = json.loads(self.rfile.read(size))
            with MUTATION_LOCK:
                result = self.action(data)
            self.respond(200, result)
        except PermissionError as error:
            self.respond(401, {'error': str(error)})
        except Exception as error:
            self.respond(400, {'error': str(error)[:250]})

    def action(self, data):
        if self.path == '/preview':
            raw = base64.b64decode(data['data'], validate=True)
            if len(raw) > 15_000_000:
                raise ValueError('Выберите файл до 15 МБ')
            sheets = parse(data['name'], raw)
            token = uuid.uuid4().hex
            if len(IMPORTS) >= 8:
                raise ValueError('Уже загружено 8 файлов. Завершите текущую проверку.')
            IMPORTS[token] = {'name': data['name'], 'sheets': sheets}
            return {'token': token, 'sheets': [{'name': n, 'rows': len(r), 'columns': list(r[0]) if r else [], 'preview': r[:2]} for n, r in sheets]}
        if self.path == '/analyze':
            if data.get('existing'):
                rows = [json.loads(line) for line in (engine.HOME / 'imports/dialogues.jsonl').open()]
                name = 'Банковские диалоги · существующая выгрузка'
            else:
                uploaded = IMPORTS.get(data.get('token'))
                if not uploaded:
                    raise ValueError('Загрузите файл заново')
                sheet_index = int(data['sheet'])
                if not 0 <= sheet_index < len(uploaded['sheets']):
                    raise ValueError('Выберите существующий лист')
                _, original = uploaded['sheets'][sheet_index]
                if not original or data.get('text_column') not in original[0]:
                    raise ValueError('Выберите колонку с текстом разговора')
                if data.get('id_column') == data.get('text_column'):
                    raise ValueError('ID и текст разговора должны быть в разных колонках')
                rows = []
                for index, row in enumerate(original):
                    text = row.get(data['text_column'], '')
                    if not isinstance(text, str) or not text.strip():
                        continue
                    identifier = str(row.get(data.get('id_column'), '')).strip() or str(index+1)
                    if len(identifier) > 250:
                        raise ValueError('В колонке ID слишком длинные значения. Проверьте выбранную колонку.')
                    rows.append({'dialogue_id': identifier, 'conversation': text})
                name = uploaded['name']
            references = [json.loads(line) for line in (engine.HOME / 'imports/reference.jsonl').open()] if data.get('use_reference') else []
            if data.get('reference_text', '').strip():
                if len(data['reference_text']) > 100000:
                    raise ValueError('Справочник длиннее 100 000 символов: выберите выдержки для этой проверки')
                references.append({'article_id': 'uploaded-reference', 'title': 'Ваш справочник', 'text': data['reference_text']})
            return engine.start(rows, data.get('rules', ''), references, int(data['count']), name)
        if self.path == '/review':
            return engine.review(data['job'], data['finding'], data['decision'], data.get('note', ''))
        if self.path == '/card':
            return engine.card(data['job'], data['finding'], data['title'], data['situation'], data['criterion'])
        if self.path == '/start-run':
            return engine.run(data['job'], data['finding'], data['agent'])
        raise ValueError('Неизвестное действие')


if __name__ == '__main__':
    os.umask(0o077)
    engine.key()
    # Jobs interrupted by a restart remain visible and never look completed.
    if engine.AREA.exists():
        for path in engine.AREA.glob('*.json'):
            job = json.loads(path.read_text())
            if job['status'] == 'running':
                job.update(status='interrupted', message='Сервис перезапущен; сделанные оценки сохранены.')
                engine.save(job)
    print('Review API listening on 127.0.0.1:11436', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 11436), Handler).serve_forever()
