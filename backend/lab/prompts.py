"""Every prompt the Lab sends to a model: rules from sources, log audit, cards, test data, simulator, judge."""

PLAN = """Find business topics in the given CUSTOMER requests, and explicit expectations grounded in the provided sources.
Every dialogue ID must be assigned to exactly one topic. Different tasks in one topic may have conditional expectations.
Topics are the customer's business tasks (e.g. подключение QR, возврат покупки, тарифы эквайринга). Never create a topic about style, formatting or greetings.
Do not infer topics from incorrect agent answers. No invented policy, deadlines, amounts, facts or source quotes.
Prompts are behavior rules of the agent (several prompts may come from the agent's code: the answer prompt and classifier prompts that route requests); knowledge is factual reference.
A source of kind 'tools' lists the agent's business-system tools. Add an expectation with observation 'tool' only when a prompt or the tool list grounds it (e.g. asking about the customer's own rate requires querying its tariff); quote the tool's line from that source.
Every expectation must cite one source ID and a meaningful EXACT source quote (copy it character by character, at least 20 characters). Preserve exceptions and acceptable alternatives, including allowed handoffs.
Separate observable reply behavior from tool actions and backend state (tool/state require actual events, replies alone do not prove them).
Prefer expectations that can be checked from the agent's replies alone and that matter for the customer's outcome.
If no relevant rule can be grounded, leave rules empty and state the gap without inventing a failure.
Use Russian. Return {topics:[{id,title,dialogueIds,rules:[{id,name,text,sourceId,quote,condition,acceptable,observation:"reply|tool|state"}],gap?}]}.
name is the rule in 2-5 words, what the agent does, readable at a glance by a bank manager (e.g. «Не отсылает в поддержку», «Время — по Москве»); no period.
Choose at most 8 topics, at most 3 expectations per topic. condition says WHEN this duty actually applies; acceptable says permitted ways to satisfy it.
Rule ids must be unique across all topics (e.g. t1r1)."""

ASSIGN = """Assign every dialogue ID to exactly one of the given topics by the customer's business task (what the customer wants to get done).
If no topic fits well, choose the closest one in business meaning. Return {assignments:[{dialogueId,topicId}]}."""

JUDGE_LOG = """Evaluate only the supplied expectations against this RECORDED conversation from production logs. Neither agent nor user was run here.
For each rule return exactly one row. Apply its condition first; if the moment did not arise, return NOT_APPLICABLE. If uncertain, UNKNOWN.
FAIL requires a real contradiction of an applicable rule. PASS requires evidence, not an agreeable-looking answer.
Missing knowledge evidence is UNKNOWN. A handoff may be allowed: respect rule exceptions and acceptable alternatives. Never force pass/fail.
Replies never prove tool calls, backend changes, identity, payment or refunds. Without tools/state events, these expectations are UNKNOWN.
Values masked with * or # are hidden, not missing. Repeats are not errors by themselves. transition-code blocks are UI controls, not spoken text.
Each PASS/FAIL must cite a meaningful EXACT substring of an AGENT reply in agentQuote (copy it character by character). Never invent an event or quote.
Use Russian. Return {rules:[{ruleId,status:"PASS|FAIL|UNKNOWN|NOT_APPLICABLE",reason,agentQuote,title}]}.
title describes a concrete recurring failure pattern for FAIL, e.g. "Повторяет вопрос, когда клиент не знает номер", not a generic bad conversation."""

JUDGE_RUN = """Evaluate only the supplied expectations against this conversation. The AGENT was really run just now; the CUSTOMER is a synthetic customer who plays the given situation.
For each rule return exactly one row. Apply its condition first; if the moment did not arise in this conversation, return NOT_APPLICABLE. If uncertain, UNKNOWN.
FAIL requires a real contradiction of an applicable rule. PASS requires evidence in the agent's replies, not an agreeable-looking answer.
A handoff may be allowed: respect rule exceptions and acceptable alternatives. Never force pass/fail. Judge only the AGENT, never the synthetic customer.
A "[служебный статус ...]" reply means the bot did not answer itself and handed the conversation to a human operator. Such a handoff counts as sending the customer to support/an operator, unless the rule's condition or acceptable explicitly allows a handoff in this situation.
Each PASS/FAIL must cite a meaningful EXACT substring of the agent's own words in agentQuote (copy it character by character, never the bracketed service marker). Never invent a quote.
Rules with observation "tool" are judged only from the "[вызовы систем: …]" lines; if toolCallsObserved is false, they are UNKNOWN. For them agentQuote is the tool name from that line.
"Answers the question" is judged on EVERY agent reply: an off-topic or wrong reply fails it even if a later reply is correct.
Rules with observation "knowledge" are judged against the supplied knowledge articles (the ones the agent retrieved). FAIL only for a concrete contradiction or an invented step, menu or section name, deadline, amount or condition that the articles do not contain; quote the agent's words and name the mismatch in reason. If no articles are supplied, UNKNOWN.
First write customerGoal: the exact operation the customer wants (3-8 words). Judge every reply against it: a reply that serves another operation fails "answers the question" even if it is a correct instruction for that other operation.
Use Russian. Return {customerGoal, rules:[{ruleId,status:"PASS|FAIL|UNKNOWN|NOT_APPLICABLE",reason,agentQuote}]}.
Not an answer to the question: an instruction for a different operation than the customer asked (e.g. blocking instead of returning equipment, cancelling a refund instead of viewing refunds), an instruction that starts in the middle (e.g. from step 7), text addressed to bank staff (e.g. «рекомендуй», «используй статью», internal systems), or a fragment unrelated to the question.
reason: one or two short sentences a business owner understands."""

CARD = """Build a source-grounded card of the CUSTOMER of one recorded support chat. A simulator will play this customer against a new version of the bank's acquiring support agent, so keep the customer's task, knowledge and manner, never the old agent's answers.
The chat is the customer's whole conversation with the bank assistant; several agents may have answered. Find the acquiring episode: the CUSTOMER event n where the acquiring task is first stated (episode.start) and how the customer got there (entry: first_message | after_greeting | after_other_topic).
Evidence: every customer-side item cites a CUSTOMER event n and an exact quote copied from it (3-150 characters). Agent context cites an AGENT event agentN and an exact quote from it.
- Only what the customer actually wrote. No biography, role, age, emotions or reasons the text does not show.
- circumstances: the customer's situation in the world (equipment, point of sale, what already happened), never remarks about the chat itself.
- Absence is not knowledge. If the chat never shows whether the customer knows something, list it in notEstablished (identifiers have their own field). does_not_know needs the customer's own words.
- A value the customer typed but the export masked (# for digits, * for hidden text) is masked_in_source: the customer knew it.
- What the AGENT said is never the customer's initial knowledge: such facts are learned_from_agent.
- said: opening (in the episode's first message) | later (volunteered later) | on_request (answering the agent's question).
- observations: the customer's own attempts in the world (pressed a button on the device, opened a section, followed a link) and what happened, in their words. Never an agent answer, never the customer's reply.
- A result the customer got by following the agent's suggestion is an observation, never a fact: the new agent may suggest something else.
- reactions: how the customer answered a specific agent move; trigger is one of unclear_question, repeated_clarification, wrong_object, inapplicable_instruction, no_progress, identifier_request, choice_offer, instruction, handoff_offer, resolved. Observed ones only, each with the agent quote it answered and the customer quote.
- hypotheses: at most two plausible reactions to triggers that did NOT occur in this chat, tentative and consistent with the observed manner; they are untested. They describe only how the customer answers (clarifies, repeats, asks for a human, says they will try), never new facts or results of actions the customer did not report.
- identifiers.terminal (the terminal number) and identifiers.organization (INN or company details): {status:"knows|masked_in_source|does_not_know|not_established",n,quote}; n and quote only for the first three.
- Never put the correct agent answer, a bank procedure or a quality criterion into customer fields.
- openingFilled: the episode's first customer message character for character, each masked run (# or *) replaced by one plausible fictional value of its kind (digits for numbers); the same text if nothing is masked.
eligible is false when the customer has no acquiring task; ineligibleReason says why. An acquiring task is the merchant's side of card and QR payments: terminals and pinpads, QR and SBP payment acceptance, cash registers working with acquiring, settlements and revenue crediting, tariffs and fees, refunds to buyers, equipment requests, acquiring contracts and reports. Not acquiring: greeting only, paying as a buyer, salary projects, other bank products. When in doubt, eligible is true: the chat reached the acquiring agent.
Use Russian; write text, goal, object, response and action/result addressed to the customer in the second person («у тебя», «ты»). Return {eligible, ineligibleReason, name:"business title, 3-7 words", episode:{start, entry}, goal, object, circumstances:[{text,n,quote}], facts:[{text,status:"knows|believes|learned_from_agent|does_not_know|masked_in_source",said,n,quote}], notEstablished:[text], observations:[{action,result,n,quote}], reactions:[{trigger,response,agentN,agentQuote,n,quote}], hypotheses:[{trigger,response}], identifiers:{terminal,organization}, openingFilled}"""

WORLD = """You prepare test data for the mocked business systems behind a bank acquiring support chatbot.
Input: a customer situation taken from a real conversation, and JSON templates of the systems' responses.
Return {"organization":{"name","inn","merchantName","address"},"terminals":[{"nameForClient","terminalId","stateCode"}],"tools":{...}}.
- organization: a fictional company matching the situation (e.g. an АЗС, a shop, a cafe); inn = 10 digits; merchantName = short point-of-sale name; address in Russia.
- terminals: 1-3 items; terminalId = 8 digits; stateCode ACTIVE or BLOCKED (BLOCKED only if the situation implies a blocked terminal).
- tools: only tools whose data matters for this situation, from: getLkkTariff, terminalInfoByTidV2, acquiringSettlements, getLkkTransactionList, getServicesListInfoByUcpid, MakeReqToSM2.
  Each value is the full response with EXACTLY the template's keys and value types; change values and the number of list items only.
  Make the data consistent with the situation and with the organization/terminals (e.g. two identical successful refunds for a doubled refund).
- Never copy masked values (# or *) and never use real people's personal data.
Use Russian for human-readable values."""

SIMULATOR = """Ты играешь клиента банка, который пишет в чат поддержки по эквайрингу. Это тест чат-бота, но ты ведёшь себя как настоящий клиент.
Твоя ситуация:
{situation}
{profile}
{persona}

Правила:
- Пиши только следующую реплику клиента: коротко, по-русски, как в мессенджере (1-2 предложения).
- Не выдумывай факты, суммы, номера и продукты сверх ситуации. Если спросят то, чего ты не знаешь, так и скажи.
- Если агент называет твою организацию, мерчанта или терминал, соглашайся: это ты.
- Если в ответе агента есть [Кнопки: ...], ответь точным текстом одной из кнопок (как будто нажал её), без других слов.
- Не подсказывай агенту правильный ответ и не говори, что это тест.
- Если вопрос решён, агент дал понятную инструкцию или разговор зашёл в тупик, ответь ровно: [КОНЕЦ]
  Не пиши отдельное «спасибо» — вместо него сразу [КОНЕЦ]."""

PERSONA_OPENING = """Перепиши первое сообщение клиента в чат поддержки банка так, как его написал бы клиент с такой манерой:
{style}

Сохрани смысл, вопрос и все факты (суммы, номера, названия). Ничего не добавляй по существу и не убирай. Не отвечай на вопрос.
Верни только текст сообщения, без кавычек и пояснений."""
