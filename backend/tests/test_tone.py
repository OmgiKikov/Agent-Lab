import asyncio
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from zipfile import ZipFile

import httpx

from lab import api, discover, llm, policy_files, quotes, store, tone
from lab.jobs import Jobs

POLICY = """## Главные принципы
Отказ сам по себе не является нарушением. Не оценивай достоверность фактов.
# Правила коммуникаций
### pronouns
Обращайтесь к клиенту на «вы» со строчной буквы.
### simple_language
Не используйте канцеляризмы.
## Лексика и синтаксис: simple_language
Используйте активный залог.
# Формат ответа
Только JSON.
# Примеры
Пример ответа не является новым правилом.
"""


def docx(text):
    output = io.BytesIO()
    xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    xml += f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>'
    with ZipFile(output, 'w') as archive:
        archive.writestr('word/document.xml', xml)
    return output.getvalue()


class PolicyTests(unittest.TestCase):
    def test_docx_and_utf8_text_are_read_without_losing_text(self):
        text = 'Обращайтесь к клиенту на вы и не используйте эмодзи.'
        self.assertEqual(policy_files.read('rules.docx', docx(text)), text)
        self.assertEqual(policy_files.read('rules.md', b'\xef\xbb\xbf' + text.encode()), text)

    def test_invalid_and_oversized_uploads_are_rejected(self):
        for name, data in (('bad.docx', b'bad zip'), ('rules.pdf', b'%PDF'), ('rules.txt', b'x' * 2_000_001)):
            with self.subTest(name=name), self.assertRaises(ValueError):
                policy_files.read(name, data)

    def test_supplied_codes_keep_repeated_sections_and_global_exceptions(self):
        source = tone.policy('rules', POLICY)
        rules = tone.coded_criteria(source)
        self.assertEqual([rule['id'] for rule in rules], ['pronouns', 'simple_language'])
        self.assertIn('канцеляризмы', rules[1]['text'])
        self.assertIn('активный залог', rules[1]['text'])
        self.assertIn('Отказ сам по себе', rules[0]['acceptable'])
        self.assertNotIn('Только JSON', rules[1]['text'])
        self.assertTrue(all(quotes.found(rule['quote'], source['content']) for rule in rules))

    def test_generated_criteria_cannot_invent_source_evidence(self):
        source = tone.policy('rules', 'Обращайтесь к клиенту на вы и не используйте эмодзи.')
        row = {
            'name': 'Обращение',
            'text': 'Используйте вы',
            'quote': 'Нельзя просить реквизиты',
            'condition': '',
            'acceptable': '',
        }
        with self.assertRaises(ValueError):
            tone._parse({'criteria': [row]}, source)


class ToneFlowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for mocked in (
            patch.object(store, 'DB', Path(directory.name) / 'lab.sqlite3'),
            patch.object(api, 'jobs', Jobs()),
        ):
            mocked.start()
            self.addCleanup(mocked.stop)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url='http://test')
        self.dialogue = {
            'id': 'd1',
            'messages': [
                {'role': 'user', 'content': 'Вопрос клиента'},
                {'role': 'assistant', 'content': 'Уточните, пожалуйста, вопрос'},
            ],
        }
        await self.client.post('/api/logs?name=fixture.jsonl', content=json.dumps(self.dialogue))

    async def asyncTearDown(self):
        await api.jobs.close()
        await self.client.aclose()

    async def wait_job(self):
        for _ in range(100):
            if not api.jobs.state['running']:
                return
            await asyncio.sleep(0.002)
        self.fail('background job did not finish')

    async def prepared(self):
        response = await self.client.post('/api/tone-of-voice/policy', json={'text': POLICY})
        self.assertEqual(response.status_code, 200, response.text)
        with patch.object(
            llm, 'structured', AsyncMock(side_effect=AssertionError('coded policy must not call a model'))
        ):
            response = await self.client.post('/api/tone-of-voice/criteria')
            self.assertEqual(response.status_code, 200, response.text)
            await self.wait_job()
        self.assertIsNone(api.jobs.state['error'])
        return store.load(tone.DRAFT)

    async def test_file_preview_does_not_change_inputs_or_existing_results(self):
        store.save(discover.RESULT, {'results': ['old']})
        response = await self.client.post(
            '/api/tone-of-voice/read-file?name=rules.docx', content=docx('Обращайтесь на вы и отвечайте вежливо.')
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('отвечайте вежливо', response.json()['text'])
        self.assertEqual(store.load(discover.RESULT), {'results': ['old']})
        self.assertEqual(store.load(api.logs.FILE), [self.dialogue])

    async def test_policy_keeps_existing_code_sources_and_creates_reviewable_criteria(self):
        code = {'id': 's1', 'kind': 'prompt', 'origin': 'agent.py', 'content': 'original prompt'}
        store.save(api.sources.FILE, [code])
        draft = await self.prepared()
        self.assertEqual(len(draft['criteria']), 2)
        self.assertEqual(api.sources.load()[0], code)
        self.assertIsNone(store.load(discover.RESULT))
        state = (await self.client.get('/api/state')).json()
        self.assertEqual(state['toneOfVoice']['revision'], draft['revision'])

    async def test_check_uses_existing_judge_and_saves_tone_scope(self):
        draft = await self.prepared()
        rows = [
            {
                'ruleId': rule['id'],
                'rule': rule['text'],
                'status': 'PASS',
                'reason': 'Обращается вежливо',
                'agentQuote': 'Уточните, пожалуйста, вопрос',
                'title': '',
            }
            for rule in draft['criteria']
        ]
        value = {
            'dialogueId': 'd1',
            'topicId': 't1',
            'status': 'PASS',
            'rules': rows,
            'opening': 'Вопрос клиента',
            'model': 'test',
            'second': None,
        }
        with patch.object(discover, 'judge_dialogue', AsyncMock(return_value=value)) as judge:
            response = await self.client.post(
                '/api/tone-of-voice/check', json={'ruleIds': ['pronouns', 'simple_language'], 'count': 1}
            )
            self.assertEqual(response.status_code, 200, response.text)
            await self.wait_job()
        self.assertIsNone(api.jobs.state['error'])
        judge.assert_awaited_once()
        result = store.load(discover.RESULT)
        self.assertEqual(result['purpose'], 'tone-of-voice')
        self.assertEqual(result['criteriaRevision'], draft['revision'])
        self.assertEqual((result['summary']['measured'], result['summary']['passed']), (1, 1))

    async def test_partial_unknown_is_not_a_successful_tone_check(self):
        draft = await self.prepared()
        rows = [
            {
                'ruleId': rule['id'],
                'rule': rule['text'],
                'status': status,
                'reason': 'Проверка',
                'agentQuote': '',
                'title': '',
            }
            for rule, status in zip(draft['criteria'], ('PASS', 'UNKNOWN'), strict=True)
        ]
        value = {
            'dialogueId': 'd1',
            'topicId': 't1',
            'status': 'PASS',
            'rules': rows,
            'opening': 'Вопрос',
            'model': 'test',
            'second': {'status': 'PASS', 'model': 'test2', 'rules': rows},
        }
        with patch.object(discover, 'judge_dialogue', AsyncMock(return_value=value)):
            await self.client.post(
                '/api/tone-of-voice/check', json={'ruleIds': ['pronouns', 'simple_language'], 'count': 1}
            )
            await self.wait_job()
        result = store.load(discover.RESULT)
        self.assertEqual(result['results'][0]['status'], 'UNMEASURED')
        self.assertEqual(result['results'][0]['second']['status'], 'UNMEASURED')
        self.assertEqual((result['summary']['measured'], result['summary']['unmeasured']), (0, 1))

    async def test_unknown_or_stale_selection_cannot_start_a_check(self):
        await self.prepared()
        response = await self.client.post('/api/tone-of-voice/check', json={'ruleIds': ['invented'], 'count': 1})
        self.assertEqual(response.status_code, 400)
        await self.client.post('/api/logs?name=other.jsonl', content=json.dumps(self.dialogue))
        self.assertIsNone(store.load(tone.DRAFT))
        response = await self.client.post('/api/tone-of-voice/check', json={'ruleIds': ['pronouns'], 'count': 1})
        self.assertEqual(response.status_code, 400)

    async def test_policy_changes_are_blocked_while_another_job_is_running(self):
        entered = asyncio.Event()

        async def busy(progress):
            entered.set()
            await asyncio.Event().wait()

        api.jobs.start('run', busy)
        await entered.wait()
        response = await self.client.post('/api/tone-of-voice/policy', json={'text': POLICY})
        self.assertEqual(response.status_code, 409)

    async def test_cancelled_generation_cannot_publish_partial_criteria(self):
        source = 'Обращайтесь к клиенту на вы и отвечайте вежливо.'
        await self.client.post('/api/tone-of-voice/policy', json={'text': source})
        entered = asyncio.Event()

        async def generate(*args, **kwargs):
            entered.set()
            await asyncio.Event().wait()

        with patch.object(llm, 'structured', side_effect=generate):
            await self.client.post('/api/tone-of-voice/criteria')
            await entered.wait()
            await self.client.post('/api/job/stop')
        self.assertIsNone(store.load(tone.DRAFT))
        self.assertEqual(api.jobs.state['error'], 'Остановлено')
