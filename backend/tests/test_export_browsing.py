"""An export can be inspected before judging, without returning the entire upload or another agent's data."""

import json
import unittest
from unittest.mock import patch

import support

from lab import storage


def dialogue(index: int) -> dict:
    return {
        'id': f'dialog-{index}',
        'messages': [
            {'role': 'user', 'content': f'Вопрос {index}: ' + ('длинный текст ' * 30).strip()},
            {'role': 'assistant', 'content': 'Ответ агента'},
        ],
    }


class ExportBrowsingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        support.serve(self)

    async def test_an_empty_export_is_a_valid_empty_page(self):
        response = await self.client.get('/api/logs')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['items'], [])
        self.assertEqual(response.json()['total'], 0)

    async def test_preview_is_bounded_and_in_export_order_and_detail_stays_complete(self):
        records = [dialogue(i) for i in range(25)]
        body = '\n'.join(json.dumps(record) for record in records)
        await self.client.post('/api/logs?name=october.jsonl', content=body)
        with patch.object(storage.dialogues, 'read', side_effect=AssertionError('Must not read the whole export')):
            response = await self.client.get('/api/logs?offset=10&limit=10')
        page = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(page['total'], 25)
        self.assertEqual(page['file'], 'october.jsonl')
        self.assertIsNotNone(page['updatedAt'])
        self.assertEqual([item['id'] for item in page['items']], [f'dialog-{i}' for i in range(10, 20)])
        self.assertTrue(all(item['turns'] == 2 and len(item['opening']) == 240 for item in page['items']))
        detail = (await self.client.get('/api/logs/dialog-10')).json()
        self.assertEqual(detail['messages'], records[10]['messages'])
        self.assertEqual((await self.client.get('/api/logs?offset=25')).json()['items'], [])

    async def test_paging_limits_are_validated(self):
        for query in ('offset=-1', 'limit=0', 'limit=51', 'limit=nope'):
            with self.subTest(query=query):
                response = await self.client.get(f'/api/logs?{query}')
                self.assertEqual(response.status_code, 422)

    async def test_replacement_does_not_leave_old_previews(self):
        for index, filename in ((1, 'first.jsonl'), (2, 'next.jsonl')):
            await self.client.post(f'/api/logs?name={filename}', content=json.dumps(dialogue(index)))
        page = (await self.client.get('/api/logs')).json()
        self.assertEqual(page['file'], 'next.jsonl')
        self.assertEqual([item['id'] for item in page['items']], ['dialog-2'])
        self.assertEqual((await self.client.get('/api/logs/dialog-1')).status_code, 404)

    async def test_browsing_stays_inside_the_selected_agent(self):
        first = storage.registry.create('Первый', '')['id']
        second = storage.registry.create('Второй', '')['id']
        await self.client.post(
            '/api/logs?name=first.jsonl', content=json.dumps(dialogue(1)), headers={'X-Agent': first}
        )
        page = (await self.client.get('/api/logs', headers={'X-Agent': first})).json()
        other = (await self.client.get('/api/logs', headers={'X-Agent': second})).json()
        self.assertEqual([item['id'] for item in page['items']], ['dialog-1'])
        self.assertEqual(other['items'], [])
        self.assertEqual(other['total'], 0)
        self.assertEqual((await self.client.get('/api/logs/dialog-1', headers={'X-Agent': second})).status_code, 404)
