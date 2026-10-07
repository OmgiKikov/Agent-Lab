import json
import unittest
from unittest.mock import AsyncMock, patch

import support

from lab import models, storage
from lab.domain import cards, metric, profile, scenarios, world
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
            'name': 'Тариф терминала',
            'episode': {'start': 1, 'entry': 'first_message'},
            'facts': [
                {'text': 'тариф 1,8%', 'status': 'learned_from_agent', 'n': 2, 'quote': 'Ваш тариф 1,8%'},
                {'text': 'клиент на тарифе 2%', 'status': 'knows', 'n': 1, 'quote': 'тариф 2%'},
            ],
            'reactions': [
                {
                    'trigger': 'inapplicable_instruction',
                    'actions': ['report_obstacle', 'ask_human', 'shrug'],
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
            episode = {'start': 1, 'end': 3, 'task': 'узнать тариф своего терминала', 'object': 'тариф'}
            card = await deck_flow.build_card(topic(), chat, ['representative'], scenario=scenario, episode=episode)
        self.assertEqual(card['model'], 'actual-model')
        self.assertEqual(card['opening'], 'Какой тариф у терминала 48213907?')
        # The agent's words are not the customer's knowledge; a quote the log does not have is no fact.
        self.assertEqual(card['knowledge'], [])
        dropped = card['checks']['dropped']
        self.assertEqual((dropped['fromAgent'], dropped['facts'], dropped['observations']), (1, 1, 1))
        self.assertNotIn('1,8%', card['situation'])
        # The goal is the episode's task, never what the conversation went on to.
        self.assertEqual(card['goal'], {'task': 'узнать тариф своего терминала', 'object': 'тариф'})
        self.assertIn('Ты пишешь в чат поддержки на сайте банка.', card['situation'])
        self.assertIn('Твоя задача: узнать тариф своего терминала. Речь о: тариф.', card['situation'])
        # A reaction is what the customer did, in the words of its actions: an unknown action is no part of it.
        self.assertEqual(card['reactions'][0]['actions'], ['report_obstacle', 'ask_human'])
        self.assertIn(
            'если инструкция не подходит или её нельзя выполнить: говоришь, что так сделать не можешь и что мешает '
            'и просишь живого специалиста',
            card['situation'],
        )
        terminal = {'label': 'номер терминала', 'value': 'knows', 'basis': 'log', 'status': 'masked_in_source'}
        self.assertEqual(card['identifiers']['terminal'], terminal)
        # The log never settles the INN: no knowledge is drawn at random, the simulator's assumption says so.
        self.assertEqual(
            card['identifiers']['organization'],
            {
                'label': 'ИНН и реквизиты организации',
                'value': 'looks_up',
                'basis': 'assumption',
                'status': 'not_established',
            },
        )
        # Identifiers are not in the brief: their values come from the bank the agent sees, when it is played.
        self.assertNotIn('ИНН', card['situation'])
        self.assertEqual(card['checks']['audit'], {'agentWords': [], 'criteriaWords': [], 'goalAhead': []})
        self.assertEqual((card['episode']['scope'], card['origin']), ('agent_only', 'Представительный набор'))
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
        reply = {'name': 'Заказ терминала', 'episode': {'start': 1}}
        answer = models.Reply(json.dumps(reply, ensure_ascii=False), 'm')
        with (
            patch.object(models, 'chat', AsyncMock(return_value=answer)) as asked,
            patch.object(deck_flow.world, 'templates', return_value=None),
            patch.object(deck_flow.inputs, 'sources', return_value=[]),
        ):
            card = await deck_flow.build_card(
                topic(), chat, ['representative'], episode={'start': 3, 'task': 'заказать терминал'}
            )
        self.assertEqual(json.loads(asked.await_args.args[1])['episodeStart'], 3)
        self.assertEqual((card['opening'], card['episode']['start']), ('Заказать терминал', 3))
        self.assertEqual(card['checks']['dropped']['episode'], 1)  # the extractor put it elsewhere
        self.assertEqual(card['goal']['task'], 'заказать терминал')

    async def test_the_reader_decides_the_domain_and_the_extractors_doubt_stays_on_the_card(self):
        chat = {
            'id': 'g',
            'messages': [{'role': 'user', 'content': 'Оплатил по QR'}, {'role': 'assistant', 'content': 'Да'}],
        }
        storage.dialogues.replace([chat])
        # A conversation the episode reader put outside the agent's domain gets no card and asks no model.
        episodes = {'g': {'inDomain': False, 'reason': 'платит как покупатель'}}
        building = deck_flow._Building(
            'code', {'topics': []}, episodes, {}, {'g': ['stress']}, lambda **_: None, support.agent()
        )
        with (
            patch.object(deck_flow, '_topics', AsyncMock(return_value={'g': topic()})),
            patch.object(deck_flow, 'build_card', AsyncMock()) as build,
        ):
            await building.make(['g'])
        build.assert_not_awaited()
        self.assertEqual(building.made['g']['reason'], 'вне домена агента: платит как покупатель')
        # In the domain by the reader, the card is built; the extractor's doubt is kept beside it for review.
        reply = {
            'domainDoubt': 'клиент платит как покупатель',
            'name': 'Оплата',
            'episode': {'start': 1},
        }
        answer = models.Reply(json.dumps(reply, ensure_ascii=False), 'm')
        with (
            patch.object(models, 'chat', AsyncMock(return_value=answer)),
            patch.object(deck_flow.world, 'templates', return_value=None),
            patch.object(deck_flow.inputs, 'sources', return_value=[]),
        ):
            episode = {'start': 1, 'end': 2}
            card = await deck_flow.build_card(topic(), chat, ['representative'], episode=episode, agent=support.agent())
        self.assertEqual(card['checks']['domainDoubt'], 'клиент платит как покупатель')

    def test_the_profile_says_when_each_fact_is_told_what_a_reaction_reveals_and_what_trying_gives(self):
        messages = [
            {'role': 'user', 'content': 'Не проходит сверка итогов. Что делать?'},
            {'role': 'assistant', 'content': 'Решить проблему помогут эти шаги: 1. Нажмите «Меню».'},
            {'role': 'user', 'content': 'У меня интегрированный терминал, файл от инженера не запускается'},
            {'role': 'assistant', 'content': 'Нажмите «Меню» и выберите «Сверка итогов»'},
            {'role': 'user', 'content': 'Нет кнопки Меню, есть F# и цифры'},
            {'role': 'assistant', 'content': 'С какой кассой работает терминал?'},
            {'role': 'user', 'content': 'АТОЛ'},
        ]
        value = {
            'name': 'Сверка итогов',
            'episode': {'start': 1, 'entry': 'first_message'},
            'facts': [
                {
                    'text': 'Сверка у тебя не проходит.',
                    'status': 'knows',
                    'said': 'opening',
                    'n': 1,
                    'quote': 'Не проходит сверка итогов',
                },
                {
                    'text': 'У тебя интегрированный терминал.',
                    'status': 'knows',
                    'said': 'later',
                    'n': 3,
                    'quote': 'интегрированный терминал',
                },
                {'text': 'Касса у тебя АТОЛ.', 'status': 'believes', 'said': 'on_request', 'n': 7, 'quote': 'АТОЛ'},
            ],
            'observations': [
                {
                    'action': 'запустить файл от инженера',
                    'result': 'не запускается',
                    'n': 3,
                    'quote': 'файл от инженера не запускается',
                },
                {
                    'action': 'нажать «Меню» на терминале',
                    'result': 'кнопки нет, есть F# и цифры',
                    'n': 5,
                    'quote': 'Нет кнопки Меню',
                },
            ],
            'reactions': [
                {
                    'trigger': 'instruction',
                    'actions': ['give_detail'],
                    'agentN': 2,
                    'agentQuote': 'эти шаги',
                    'n': 3,
                    'quote': 'интегрированный терминал',
                },
                {
                    'trigger': 'instruction',
                    'actions': ['report_obstacle'],
                    'agentN': 4,
                    'agentQuote': 'Нажмите',
                    'n': 5,
                    'quote': 'Нет кнопки Меню',
                },
            ],
            'notEstablished': [
                'Модель терминала ######.',
                'Неизвестно, знаешь ли ты номер своего терминала.',
                'Неизвестно, знаешь ли ты ИНН и реквизиты своей организации.',
                'Неизвестно, знаешь ли ты ИНН.',
                'Не установлено, доступна ли история операций терминала по его номеру.',
            ],
        }
        episode = {'start': 1, 'end': 7, 'task': 'разобраться, почему не проходит сверка итогов', 'object': 'сверка'}
        card = cards.customer(value, {'id': 'd', 'messages': messages}, support.agent(), episode)
        self.assertEqual(
            [(k['text'], k['access'], k['disclose']) for k in card['knowledge']],
            [
                ('Сверка у тебя не проходит.', 'knows', 'opening'),
                ('У тебя интегрированный терминал.', 'knows', 'when_relevant'),
                ('Касса у тебя АТОЛ.', 'believes', 'on_request'),
            ],
        )
        # What the customer tried before writing is told; what they reported trying the agent's steps is what trying
        # gives the next customer too. A detail given after steps reports no try: the file is a try of their own.
        self.assertEqual([o['when'] for o in card['observations']], ['before', 'during'])
        self.assertEqual(
            card['reactions'][0]['reveals'],
            ['У тебя интегрированный терминал.', 'уже пробовал: запустить файл от инженера — не запускается'],
        )
        situation = card['situation']
        sections = situation.split('\n')
        self.assertLess(
            sections.index('Уже есть в твоём первом сообщении:'), sections.index('- Сверка у тебя не проходит.')
        )
        self.assertIn(
            'Расскажешь сам, когда это станет к месту, не всё сразу:\n- У тебя интегрированный терминал.', situation
        )
        self.assertIn(
            'Скажешь, только если спросят:\n- Касса у тебя АТОЛ. (так ты считаешь, но можешь ошибаться)', situation
        )
        self.assertRegex(
            situation,
            r'Если агент предложит это сделать, вот что получится:\n'
            r'- нажать «Меню» на терминале → кнопки нет, есть F\d и цифры',
        )
        # No mask is left for the customer: a short masked number is a fictional one, a long one is left out.
        self.assertNotIn('#', situation)
        self.assertIn('Модель терминала ….', situation)
        self.assertEqual(card['checks']['masksFilled'], 2)
        # What the log leaves open about an identifier is not said twice: its value comes from the bank's data.
        # One that only mentions an identifier is about something else and stays.
        self.assertEqual(
            card['notEstablished'],
            ['Модель терминала ….', 'Не установлено, доступна ли история операций терминала по его номеру.'],
        )
        self.assertEqual(card['checks']['dropped']['notEstablished'], 3)
        # Every later message here tells a fact or a result: none is a sample of the manner, told before its time.
        self.assertEqual(card['samples'], [])

    def test_the_brief_is_checked_for_the_agents_words_the_criteria_and_a_goal_ahead_of_the_customer(self):
        messages = [
            {'role': 'user', 'content': 'Не проходит сверка'},
            {'role': 'assistant', 'content': 'Откройте раздел эквайринг и выберите пункт сверка итогов за день'},
            {'role': 'user', 'content': 'У меня интегрированный терминал'},
        ]
        value = {
            'name': 'Сверка',
            'episode': {'start': 1},
            'facts': [
                {
                    'text': 'Тебе сказали: откройте раздел эквайринг и выберите пункт сверка итогов.',
                    'status': 'knows',
                    'said': 'later',
                    'n': 3,
                    'quote': 'интегрированный терминал',
                },
                {
                    'text': 'У тебя интегрированный терминал.',
                    'status': 'knows',
                    'said': 'later',
                    'n': 3,
                    'quote': 'интегрированный терминал',
                },
            ],
        }
        episode = {'start': 1, 'end': 3, 'task': 'провести сверку на интегрированном терминале'}
        card = cards.customer(value, {'id': 'd', 'messages': messages}, support.agent(), episode)
        rule = {'text': 'Агент просит выбрать пункт сверка итогов за день', 'quote': 'выбрать пункт'}
        found = cards.audit(card, {'messages': messages}, [rule])
        self.assertIn('откройте раздел эквайринг и выберите пункт', found['agentWords'])
        self.assertEqual(found['criteriaWords'], [])
        self.assertEqual(found['goalAhead'], ['У тебя интегрированный терминал.'])
        deck = scenarios.checked([card | {'checks': {'audit': found}}, {'checks': {}, 'reactions': []}])
        self.assertEqual(
            deck, {'cards': 2, 'agentWords': 1, 'criteriaWords': 0, 'goalAhead': 1, 'identifierAnswers': {}}
        )
        asked = {'trigger': 'identifier_request', 'actions': ['dont_know']}
        self.assertEqual(scenarios.checked([{'reactions': [asked]}])['identifierAnswers'], {'dont_know': 1})

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

    def test_doubtful_identifiers_and_triggers_are_dropped_and_guesses_never_kept(self):
        messages = [
            {'role': 'user', 'content': 'Вопрос по мерчанту Ромашка Тверская'},
            {'role': 'assistant', 'content': 'Перейдите в раздел «Эквайринг» и нажмите «Тарифы»'},
            {'role': 'user', 'content': 'Не вижу такого раздела'},
        ]
        reaction = {'actions': ['report_obstacle'], 'agentN': 2, 'agentQuote': 'Перейдите в раздел', 'n': 3}
        value = {
            'identifiers': {
                'organization': {'status': 'knows', 'n': 1, 'quote': 'мерчанту Ромашка Тверская'},
                'terminal': {'status': 'knows', 'n': 3, 'quote': 'такого раздела'},
            },
            'reactions': [
                {**reaction, 'trigger': 'handoff_offer', 'quote': 'Не вижу такого раздела'},
                {**reaction, 'trigger': 'instruction', 'quote': 'Не вижу такого раздела'},
                {**reaction, 'trigger': 'instruction', 'actions': ['shrug'], 'quote': 'Не вижу такого раздела'},
            ],
            'hypotheses': [
                {'trigger': 'instruction', 'response': 'попробуешь шаги'},
                {'trigger': 'identifier_request', 'response': 'назовёшь номер, как делал раньше'},
                {'trigger': 'handoff_offer', 'response': 'попросишь оператора'},
            ],
        }
        kept, dropped = cards.grounded(value, messages, agent=support.agent())
        self.assertEqual(
            kept['identifiers'],
            {'terminal': {'status': 'not_established'}} | {'organization': {'status': 'not_established'}},
        )
        self.assertEqual(dropped['identifiers'], 2)
        self.assertEqual([r['trigger'] for r in kept['reactions']], ['instruction'])
        self.assertNotIn('hypotheses', kept)  # a reaction the log never showed is no part of the customer

    def test_what_a_quote_of_an_identifier_must_show_is_the_agent_profiles(self):
        messages = [{'role': 'user', 'content': 'Мой логин customer_alpha, не могу войти'}]
        agent = profile.checked({'domain': 'Вход в банк', 'identifiers': [{'key': 'login', 'label': 'логин'}]})
        value = {'identifiers': {'login': {'status': 'knows', 'n': 1, 'quote': 'логин customer_alpha'}}}
        self.assertEqual(cards.grounded(value, messages, agent=agent)[0]['identifiers']['login']['status'], 'knows')
        # The acquiring agent's identifiers are numbers: a name is no terminal number.
        named = {'identifiers': {'terminal': {'status': 'knows', 'n': 1, 'quote': 'логин customer_alpha'}}}
        found = cards.grounded(named, messages, agent=support.agent())[0]['identifiers']['terminal']
        self.assertEqual(found['status'], 'not_established')
        with self.assertRaisesRegex(ValueError, 'не регулярное выражение'):
            profile.checked({'domain': 'x', 'identifiers': [{'key': 'login', 'label': 'логин', 'value': '('}]})

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
        self.assertTrue(
            cards._fits('identifier_request', 'Предоставьте, пожалуйста, номер терминала.', support.agent())
        )
        # The words of the profile's identifiers: «ИНН» is asked for only by an agent whose customers give one.
        self.assertTrue(cards._fits('identifier_request', 'Укажите ИНН?', support.agent()))
        self.assertFalse(
            cards._fits('identifier_request', 'Укажите ИНН?', {'identifiers': [{'key': 'card', 'label': 'карта'}]})
        )
        self.assertFalse(cards._fits('handoff_offer', '#. Перейдите в раздел «Эквайринг». #. Нажмите «Добавить».'))
        self.assertTrue(cards._fits('resolved', 'Любой текст'))
        self.assertTrue(cards._fits('instruction', '1) Снимите крышку. 2) Протрите контакты.'))
        self.assertFalse(cards._fits('instruction', 'Ваш номер обращения #####. Ожидайте ответа.'))
        self.assertFalse(cards._fits('instruction', 'Списано 12.05. Ожидайте зачисления'))

    def test_evidence_after_the_episode_is_another_task_and_is_dropped(self):
        messages = [
            {'role': 'user', 'content': 'Не печатает чек на терминале'},
            {'role': 'assistant', 'content': 'Перезагрузите терминал'},
            {'role': 'user', 'content': 'Помогло. А как поменять тариф?'},
            {'role': 'assistant', 'content': 'Откройте раздел «Тарифы»'},
            {'role': 'user', 'content': 'Не вижу такого раздела'},
        ]
        value = {
            'identifiers': {'terminal': 'знает', 'organization': ['knows']},
            'facts': [
                {'text': 'терминал не печатает чек', 'status': 'knows', 'n': 1, 'quote': 'Не печатает чек'},
                {'text': 'не видит раздела тарифов', 'status': 'knows', 'n': 5, 'quote': 'Не вижу такого раздела'},
            ],
        }
        kept, dropped = cards.grounded(value, messages, end=3, agent=support.agent())
        self.assertEqual([x['n'] for x in kept['facts']], [1])
        self.assertEqual((dropped['facts'], dropped['afterEpisode']), (1, 1))
        self.assertEqual(set(kept['identifiers']), {'terminal', 'organization'})
        reply = {'name': 'Чек', 'episode': {'start': 1}, **value}
        episode = {'start': 1, 'end': 3, 'task': 'починить печать чека'}
        card = cards.customer(reply, {'id': 'd', 'messages': messages}, support.agent(), episode)
        self.assertEqual((card['episode']['end'], card['style']['messages']), (3, 2))  # the tariff question is not it
        self.assertEqual(cards.episode_texts(card, {'id': 'd', 'messages': messages})[1][-1], messages[2]['content'])

    def test_stress_set_takes_the_rare_conditions_of_the_agents_profile_and_reports_their_share(self):
        long = {'id': 'long', 'messages': [{'role': 'user', 'content': 'x'}] * 4}
        statuses = {'202_7': ['agent-ckr-pa-acquiring'], '200': ['agent-other']}
        refused = {'id': 'refused', 'messages': [], 'meta': {'statuses': statuses}}
        mortgage = {
            'id': 'mortgage',
            'messages': [],
            'meta': {'agents': ['MORTGAGE_AGENT'], 'statuses': {'202_7': ['agent-mortgage']}},
        }
        common = {'id': 'common', 'messages': [{'role': 'user', 'content': 'x'}]}
        talks = [long, refused, mortgage, common]
        acquiring = support.agent()
        acquiring['export']['longTurns'] = 4
        chosen, manifest = scenarios.stress(talks, {'long'}, profile.rare(acquiring, talks))
        self.assertEqual({d['id'] for d in chosen}, {'refused', 'mortgage'})  # another agent took the mortgage chat
        self.assertIsNone(manifest['weight'])
        self.assertEqual(manifest['conditions']['4 и больше реплик клиента'], '1 из 4')
        # The same export for a mortgage agent: its own failure status counts, and it is no other agent to itself.
        export = {'agentCode': 'MORTGAGE_AGENT', 'statusMarker': 'agent-mortgage', 'stressStatuses': ['202_7']}
        rare = profile.rare(profile.checked({'domain': 'Ипотека', 'export': export | {'longTurns': 4}}), talks)
        self.assertEqual([name for name, test in rare.items() if test(mortgage)], ['Агент вернул 202-7'])
        self.assertFalse(any(test(refused) for test in rare.values()))
        # An export read before statuses were kept by agent has those of the agent it was made for.
        self.assertEqual(profile.statuses({'acquiringStatuses': ['202_7']}, 'agent-mortgage'), {'202_7'})

    def test_sets_reach_the_run_and_are_measured_apart_the_representative_one_also_weighted(self):
        card = {'id': 'c', 'name': 'n', 'topic': 't', 'origin': 'o', 'situation': 's', 'criteria': []}
        failed = simulation.new_item({**card, 'sets': ['stress', 'representative'], 'weight': 3.0}, 'default', 1)
        self.assertEqual(failed['sets'], ['stress', 'representative'])
        passed = simulation.new_item({**card, 'id': 'd', 'sets': ['representative'], 'weight': 1.0}, 'default', 1)
        value = metric.metric([{**failed, 'status': 'FAIL'}, {**passed, 'status': 'PASS'}])
        self.assertEqual(value['sets']['stress'], {'accuracy': 0, 'passed': 0, 'measured': 1})
        self.assertEqual(value['sets']['representative'], {'accuracy': 50, 'passed': 1, 'measured': 2, 'weighted': 25})
        # A run of part of the deck's sample (here 1 of its 2 cards) gives no estimate for the export.
        alone = simulation.new_item({**card, 'id': 'd', 'sets': ['representative'], 'weight': 1.0}, 'default', 1, 2)
        part = metric.metric([{**alone, 'status': 'PASS'}])['sets']['representative']
        self.assertEqual((part['partial'], 'weighted' in part), (True, False))
        whole = [{**failed, 'sample': 2, 'status': 'FAIL'}, {**alone, 'status': 'PASS'}]
        self.assertEqual(metric.metric(whole)['sets']['representative']['weighted'], 25)
