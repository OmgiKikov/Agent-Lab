#!/usr/bin/env python3
"""Preserve completed local reviews in the native analysis library, without new judging."""
import datetime, hashlib, json, os
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
HOME=ROOT/'langwatch/.local'
PROJECT='TdRRgtHpp40hUuQhFADY0'
def migrate():
 directory=HOME/'data/agent-lab'/PROJECT
 directory.mkdir(parents=True,exist_ok=True,mode=0o700)
 for file in (HOME/'review').glob('*.json'):
  old=json.loads(file.read_text())
  if old.get('status')!='done':continue
  target=directory/(old['id']+'.json')
  if target.exists():continue
  created=datetime.datetime.fromtimestamp(old['created_at'],datetime.timezone.utc).isoformat()
  rules=[];results=[];dialogues=[];reviews=[];cards=[];sources=[]
  for result in old['results']:
   did=result['dialogue_id'];dialogues.append({'id':did,'text':result['conversation'],'topicId':'imported'})
   verdicts=[]
   for f in result.get('findings',[]):
    rid=f['id'];sid='source-'+rid
    sources.append({'id':sid,'name':f.get('source_name','Прежний источник'),'kind':'prompt' if f.get('source_id')=='owner-rules' else 'knowledge','content':f['source_quote']})
    rules.append({'id':rid,'text':f['criterion'],'sourceId':sid,'quote':f['source_quote'],'condition':'Условия прежнего разбора; проверить применимость к текущей версии агента','acceptable':'Допустимые исключения необходимо сверить с текущими правилами','observation':'reply','approved':True})
    verdicts.append({'ruleId':rid,'status':'FAIL','reason':f['reason'],'agentQuote':f['agent_quote'],'title':f['title']})
    decision=f.get('owner_decision')
    if decision in ('confirmed','disputed'):
     reviews.append({'dialogueId':did,'ruleId':rid,'decision':decision,'note':f.get('owner_reason','Перенесённое решение прежнего разбора'),'userId':'historical-owner','at':created})
    if f.get('scenario_id'):
     digest=hashlib.sha256(json.dumps({'situation':f.get('situation',''),'criteria':[f['criterion']]}).encode()).hexdigest()
     card={'id':rid,'origin':'regression','dialogueId':did,'ruleIds':[rid],'name':f['title'],'situation':f.get('situation',''),'criteria':[f['criterion']],'definitionHash':digest,'status':'saved','scenarioId':f['scenario_id'],'runs':[]}
     if f.get('run_id'):card['runs'].append({'id':f['run_id'],'agentId':f.get('agent_id',''),'definitionHash':digest,'at':created,'note':'Прежний прогон: модели и версия не зафиксированы'})
     cards.append(card)
   if not verdicts:
    verdicts=[{'ruleId':'legacy-'+did,'status':'UNKNOWN','reason':result.get('reason','Прежняя оценка не содержит привязки к отдельному критерию'),'agentQuote':'','title':''}]
   results.append({'dialogueId':did,'topicId':'imported','rules':verdicts})
  job={'id':old['id'],'projectId':PROJECT,'datasetId':old['dataset_id'],'name':'Перенесённый разбор · '+old['name'],'task':old['name'],'model':'historical/not-recorded','ownerRules':old.get('rules',''),'materialRefs':[], 'textColumn':'conversation','idColumn':'dialogue_id','createdAt':created,'status':'done','message':'Перенесены прежние результаты. Новая оценка не выполнялась.','total':old['logged'],'selected':old['selected'],'processed':old['processed'],'calls':old['calls'],'sources':sources,'dialogues':dialogues,'topics':[{'id':'imported','title':'Прежний разбор','dialogueIds':[d['id'] for d in dialogues],'rules':rules}],'results':results,'reviews':reviews,'cards':cards,'knowledgeGap':'Исторические результаты: исходная версия агента и модели не зафиксированы. Нельзя использовать как доказательство изменения качества.'}
  target.write_text(json.dumps(job,ensure_ascii=False));os.chmod(target,0o600)
  print('Перенесён разбор:',old['id'],len(dialogues),'разговоров,',len(cards),'карточек')
if __name__=='__main__':migrate()
