import json
import unittest
from unittest.mock import AsyncMock, patch

import support

from lab import models
from lab.domain import cards, metric, scenarios, world
from lab.flows import scenarios as deck_flow
from lab.flows import simulation


def topic():
    rule = {'id': 'reply', 'text': 'Ответить клиенту', 'quote': 'Подробный ответ клиенту', 'observation': 'reply'}
    tool = {'id': 'tool', 'text': 'Узнать тариф', 'quote': 'getLkkTariff', 'observation': 'tool'}
    return {'id': 't', 'title': 'Тариф', 'rules': [rule, tool]}


class CustomerCardTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        support.lab(self)

    async def test_card_keeps_only_quoted_customer_facts_and_the_actual_model(self):
        chat = {
            'id': 'd',
            'meta': {'agents': ['ACQUIRING_AGENT'], 'channel': 'WEB', 'row': 5},
            'messages': [
                {'role': 'user', 'content': 'Какой тариф у терминала ########?'},
                {'role': 'assistant', 'content': 'Ваш тариф 1,8%. Подробный ответ клиенту'},
                {'role': 'user', 'content': 'Такого раздела нет, зови человека'},
            ],
        }
        reply = {
            'eligible': True,
            'name': 'Тариф терминала',
            'goal': 'Узнать тариф своего терминала',
            'episode': {'start': 1, 'entry': 'first_message'},
            'facts': [
                {'text': 'тариф 1,8%', 'status': 'learned_from_agent', 'n': 2, 'quote': 'Ваш тариф 1,8%'},
                {'text': 'клиент на тарифе 2%', 'status': 'knows', 'n': 1, 'quote': 'тариф 2%'},
            ],
            'reactions': [
                {
                    'trigger': 'inapplicable_instruction',
                    'response': 'говорит, что раздела нет, и зовёт человека',
                    'agentN': 2,
                    'agentQuote': 'Подробный ответ',
                    'n': 3,
                    'quote': 'Такого раздела нет',
                }
            ],
            'observations': [
                {'action': 'спросил в чате', 'result': 'бот ответил про тариф', 'n': 3, 'quote': 'Такого раздела нет'}
            ],
            'identifiers': {'terminal': {'status': 'masked_in_source', 'n': 1, 'quote': 'терминала ########'}},
            'openingFilled': 'Какой тариф у терминала 48213907?',
        }
        scenario = {'id': 'c1s1', 'title': 'Узнать ставку', 'categoryId': 'c1', 'category': 'Тарифы'}
        answer = models.Reply(json.dumps(reply, ensure_ascii=False), 'actual-model')
        with (
            patch.object(models, 'chat', AsyncMock(return_value=answer)),
            patch.object(deck_flow.world, 'templates', return_value=None),
            patch.object(deck_flow.inputs, 'sources', return_value=[]),
        ):
            card = await deck_flow.build_card(topic(), chat, ['representative'], scenario=scenario)
        self.assertEqual(card['model'], 'actual-model')
        self.assertEqual(card['opening'], 'Какой тариф у терминала 48213907?')
        self.assertEqual([(f['status'], f['said']) for f in card['facts']], [('learned_from_agent', None)])
        self.assertEqual((card['checks']['dropped']['facts'], card['checks']['dropped']['observations']), (1, 1))
        self.assertNotIn('1,8%', card['situation'])
        self.assertIn('раздела нет', card['situation'])
        self.assertEqual(card['identifiers']['terminal'], {'value': 'knows', 'basis': 'log'})
        self.assertEqual(card['identifiers']['organization']['basis'], 'variant')
        self.assertEqual((card['episode']['scope'], card['origin']), ('acquiring_only', 'Представительный набор'))
        self.assertEqual(card['criteria'][1]['observation'], 'tool')
        self.assertEqual(card['scenario'], scenario)

    async def test_the_card_describes_the_episode_the_catalog_placed(self):
        chat = {
            'id': 'm',
            'messages': [
                {'role': 'user', 'content': 'Эквайринг'},
                {'role': 'assistant', 'content': 'Какой у вас вопрос?'},
                {'role': 'user', 'content': 'Заказать терминал'},
                {'role': 'assistant', 'content': 'Перейдите в раздел «Оборудование»'},
            ],
        }
        reply = {'eligible': True, 'name': 'Заказ терминала', 'goal': 'Заказать терминал', 'episode': {'start': 1}}
        answer = models.Reply(json.dumps(reply, ensure_ascii=False), 'm')
        with (
            patch.object(models, 'chat', AsyncMock(return_value=answer)) as asked,
            patch.object(deck_flow.world, 'templates', return_value=None),
            patch.object(deck_flow.inputs, 'sources', return_value=[]),
        ):
            card = await deck_flow.build_card(topic(), chat, ['representative'], start=3)
        self.assertEqual(json.loads(asked.await_args.args[1])['episodeStart'], 3)
        self.assertEqual((card['opening'], card['episode']['start']), ('Заказать терминал', 3))
        self.assertEqual(card['checks']['dropped']['episode'], 1)  # the extractor put it elsewhere

    async def test_a_conversation_without_an_acquiring_task_gives_no_card(self):
        chat = {'id': 'g', 'messages': [{'role': 'user', 'content': 'Привет'}, {'role': 'assistant', 'content': 'Да'}]}
        answer = models.Reply(json.dumps({'eligible': False, 'ineligibleReason': 'только приветствие'}), 'm')
        with patch.object(models, 'chat', AsyncMock(return_value=answer)):
            card = await deck_flow.build_card(topic(), chat, ['representative'])
        self.assertEqual(
            card,
            {'eligible': False, 'sets': ['representative'], 'sourceDialogueId': 'g', 'reason': 'только приветствие'},
        )

    def test_filled_opening_may_change_only_the_masked_runs(self):
        self.assertEqual(cards._filled('Терминал ####', 'Терминал 1234'), 'Терминал 1234')
        self.assertIsNone(cards._filled('Терминал ####', 'Мой терминал 1234'))
        self.assertIsNone(cards._filled('Терминал ####', 'Терминал ####'))
        self.assertEqual(cards._filled('Без масок', 'что угодно'), 'Без масок')
        self.assertRegex(cards._digits('Терминал #, сумма *', 'd'), r'^Терминал \d{4}, сумма \*$')

    def test_observations_about_the_equipment_survive_the_chat_filter(self):
        self.assertIsNone(cards.ABOUT_CHAT.search('терминал не работает, чек не печатает'))
        self.assertTrue(cards.ABOUT_CHAT.search('бот ответил про тариф'))

    def test_world_is_checked_for_the_numbers_of_the_filled_opening_but_never_rewritten(self):
        test_data = {'terminals': [{'terminalId': '48213907'}], 'tools': {'refund': [{'terminalId': '48213907'}]}}
        raw = 'Терминал ######## не работает, заявка ########'
        self.assertTrue(cards.uses(test_data, raw, 'Терминал 48213907 не работает, заявка'))
        self.assertFalse(cards.uses(test_data, raw, 'Терминал 48213907 не работает, заявка 55512345'))
        self.assertEqual(test_data['terminals'][0]['terminalId'], '48213907')
        self.assertIsNone(cards.uses(test_data, 'Без масок', 'Без масок'))
        # A short filled number is an amount or a count, not an identifier the world must contain.
        self.assertIsNone(cards.uses({'terminals': [{'terminalId': '99999999'}]}, 'Терминал ####', 'Терминал 1234'))

    def test_doubtful_identifiers_triggers_and_guesses_are_dropped(self):
        messages = [
            {'role': 'user', 'content': 'Вопрос по мерчанту Ромашка Тверская'},
            {'role': 'assistant', 'content': 'Перейдите в раздел «Эквайринг» и нажмите «Тарифы»'},
            {'role': 'user', 'content': 'Не вижу такого раздела'},
        ]
        reaction = {'response': 'не нашёл раздел', 'agentN': 2, 'agentQuote': 'Перейдите в раздел', 'n': 3}
        value = {
            'identifiers': {
                'organization': {'status': 'knows', 'n': 1, 'quote': 'мерчанту Ромашка Тверская'},
                'terminal': {'status': 'knows', 'n': 3, 'quote': 'такого раздела'},
            },
            'reactions': [
                {**reaction, 'trigger': 'handoff_offer', 'quote': 'Не вижу такого раздела'},
                {**reaction, 'trigger': 'instruction', 'quote': 'Не вижу такого раздела'},
            ],
            'hypotheses': [
                {'trigger': 'instruction', 'response': 'попробуешь шаги'},
                {'trigger': 'identifier_request', 'response': 'назовёшь номер, как делал раньше'},
                {'trigger': 'handoff_offer', 'response': 'попросишь оператора'},
            ],
        }
        kept, dropped = cards.grounded(value, messages)
        self.assertEqual((kept['organization'], kept['terminal']), ({'status': 'not_established'},) * 2)
        self.assertEqual(dropped['identifiers'], 2)
        self.assertEqual([r['trigger'] for r in kept['reactions']], ['instruction'])
        self.assertEqual(kept['hypotheses'], [{'trigger': 'handoff_offer', 'response': 'попросишь оператора'}])
        self.assertEqual(dropped['hypotheses'], 2)

    def test_a_quote_keeps_its_negation_word_starts_and_masks(self):
        found = cards._found
        # A quote that leaves out the negation before it says the opposite of what the customer wrote.
        self.assertFalse(found('знаю номер терминала', 'Не знаю номер терминала', 'user'))
        self.assertTrue(found('не знаю номер', 'Не знаю номер терминала', 'user'))
        self.assertFalse(found('мер терминала', 'Не знаю номер терминала', 'user'))
        self.assertTrue(found('да', 'Да, спасибо', 'user'))
        # A customer's mask is a word of their message: a mask-only reply is a quote, a made-up mask is not.
        self.assertTrue(found('########', '########', 'user'))
        self.assertFalse(found('Номер терминала ########', 'Номер терминала не знаю', 'user'))
        self.assertFalse(found('терминал ****', 'терминал ####', 'user'))
        # Spacing around punctuation and line breaks are the copy's, not the words.
        self.assertTrue(found('ИНН: ##########', 'ИНН:##########', 'user'))
        self.assertTrue(found('не работает терминал', 'не работает\nтерминал', 'user'))
        # The agent's # and * are as often its Markdown.
        self.assertTrue(found('Важно: перезагрузите терминал', '**Важно:** перезагрузите терминал', 'assistant'))
        self.assertTrue(found('Номер обращения', '### Номер обращения #####', 'assistant'))

    def test_world_identity_is_fixed_per_card_and_varies_between_cards(self):
        self.assertEqual(world.identity('a'), world.identity('a'))
        many = [world.identity(str(i)) for i in range(60)]
        self.assertEqual({len(x['terminalIds']) for x in many}, {1, 2, 3})
        self.assertGreater(len({x['inn'] for x in many}), 55)
        self.assertTrue(all(len(x['inn']) == 10 and len(t) == 8 for x in many for t in x['terminalIds']))

    def test_the_customer_knows_only_the_numbers_the_card_says(self):
        made = {
            'organization': {'name': 'ООО «Кофе»', 'inn': '7701234567', 'merchantName': 'Кофе', 'address': 'Москва'},
            'terminals': [{'nameForClient': 'Касса', 'terminalId': '12345678', 'stateCode': 'ACTIVE'}],
        }
        unknown = {'terminal': {'value': 'unknown'}, 'organization': {'value': 'looks_up'}}
        profile = world.customer_profile(made, unknown)
        self.assertNotIn('12345678', profile)
        self.assertIn('наизусть не помнишь', profile)
        self.assertIn('12345678', world.customer_profile(made))

    def test_masked_numbered_steps_and_requests_fit_their_triggers(self):
        self.assertTrue(cards._fits('instruction', '#. Повторите операцию. #. Если ошибка повторится, смените карту.'))
        self.assertTrue(cards._fits('identifier_request', 'Предоставьте, пожалуйста, номер терминала.'))
        self.assertFalse(cards._fits('handoff_offer', '#. Перейдите в раздел «Эквайринг». #. Нажмите «Добавить».'))
        self.assertTrue(cards._fits('resolved', 'Любой текст'))
        self.assertTrue(cards._fits('instruction', '1) Снимите крышку. 2) Протрите контакты.'))
        self.assertFalse(cards._fits('instruction', 'Ваш номер обращения #####. Ожидайте ответа.'))
        self.assertFalse(cards._fits('instruction', 'Списано 12.05. Ожидайте зачисления'))

    def test_guesses_about_the_future_keep_words_that_only_contain_a_past_marker(self):
        messages = [{'role': 'user', 'content': 'Не печатает чек'}]
        value = {
            'identifiers': {'terminal': 'знает', 'organization': ['knows']},
            'hypotheses': [
                {'trigger': 'instruction', 'response': 'попросишь обычное объяснение без терминов'},
                {'trigger': 'identifier_request', 'response': 'заранее уточнишь, какие данные нужны'},
                {'trigger': 'handoff_offer', 'response': 'попросишь оператора, как обычно'},
            ],
        }
        kept, dropped = cards.grounded(value, messages)
        self.assertEqual([h['trigger'] for h in kept['hypotheses']], ['instruction', 'identifier_request'])
        self.assertEqual(dropped['hypotheses'], 1)
        self.assertEqual((kept['terminal'], kept['organization']), ({'status': 'not_established'},) * 2)

    def test_stress_set_takes_rare_conditions_and_reports_their_share(self):
        long = {'id': 'long', 'messages': [{'role': 'user', 'content': 'x'}] * 4}
        refused = {'id': 'refused', 'messages': [], 'meta': {'acquiringStatuses': ['200', '202_7']}}
        common = {'id': 'common', 'messages': [{'role': 'user', 'content': 'x'}]}
        chosen, manifest = scenarios.stress([long, refused, common], {'long'})
        self.assertEqual([d['id'] for d in chosen], ['refused'])
        self.assertIsNone(manifest['weight'])
        self.assertEqual(manifest['conditions']['Четыре и больше реплик клиента'], '1 из 3')

    def test_sets_reach_the_run_and_are_measured_apart_the_representative_one_also_weighted(self):
        card = {'id': 'c', 'name': 'n', 'topic': 't', 'origin': 'o', 'situation': 's', 'criteria': []}
        failed = simulation.new_item({**card, 'sets': ['regression', 'representative'], 'weight': 3.0}, 'default', 1)
        self.assertEqual(failed['sets'], ['regression', 'representative'])
        passed = simulation.new_item({**card, 'id': 'd', 'sets': ['representative'], 'weight': 1.0}, 'default', 1)
        value = metric.metric([{**failed, 'status': 'FAIL'}, {**passed, 'status': 'PASS'}])
        self.assertEqual(value['sets']['regression'], {'accuracy': 0, 'passed': 0, 'measured': 1})
        self.assertEqual(value['sets']['representative'], {'accuracy': 50, 'passed': 1, 'measured': 2, 'weighted': 25})
