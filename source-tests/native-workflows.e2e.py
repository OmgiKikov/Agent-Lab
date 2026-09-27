#!/usr/bin/env python3
"""Synthetic fixture only: verify skips recorded judgment; discover never runs an agent."""
import json,time,urllib.request,http.cookiejar
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
ns={'__file__':str(ROOT/'source-tests/native-frozen.e2e.py')}
exec((ROOT/'source-tests/native-frozen.e2e.py').read_text().split('class Fixture')[0],ns)
api=ns['api']; project='TdRRgtHpp40hUuQhFADY0'
cookies=http.cookiejar.CookieJar();opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
def session(path,body=None):
 req=urllib.request.Request('http://localhost:5560'+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json','Origin':'http://localhost:5560'})
 try:return json.load(opener.open(req,timeout=60))
 except urllib.error.HTTPError as e:raise RuntimeError(str(e.code)+': '+e.read().decode()[:250])
session('/api/auth/sign-in/email',{'email':'local@langwatch.dev','password':(ROOT/'langwatch/.local/local-admin-password').read_text().strip()})
dataset=api('/api/dataset',{'name':'Synthetic workflow control','columnTypes':[{'name':'dialogue_id','type':'string'},{'name':'conversation','type':'string'}]})
api('/api/dataset/'+dataset['id']+'/records',{'entries':[{'dialogue_id':'public-fixture','conversation':'CLIENT: Hello!\nAGENT: Hello! How can I help?'}]})
base={'projectId':project,'datasetId':dataset['id'],'textColumn':'conversation','idColumn':'dialogue_id','task':'Check greeting behavior using this public synthetic conversation.','ownerRules':'When the customer greets you, respond with a greeting.','model':'custom/gpt-5.6-sol','count':1,'autoEvaluate':True,'materials':[]}
for purpose in ['verify','discover']:
 started=session('/api/agent-lab/plan',{**base,'purpose':purpose});id=started['id'];deadline=time.time()+180
 while time.time()<deadline:
  job=session('/api/agent-lab/analysis/'+id+'?projectId='+project)
  if job['status'] in ['done','failed']:
   assert job['status']=='done',job.get('error')
   assert not job.get('batches'), 'unexpected agent execution'
   if purpose=='verify':
    assert not job['results'], 'direct verification judged recorded logs'
    assert any(c.get('scenarioId') for c in job['cards']), 'no native scenario'
   else:assert len(job['results'])==1, 'recorded log not judged'
   print(json.dumps({'purpose':purpose,'analysisId':id,'status':job['status'],'recordedJudgments':len(job['results']),'nativeScenarios':len([c for c in job['cards'] if c.get('scenarioId')]),'agentBatches':len(job.get('batches')or[])},ensure_ascii=False),flush=True);break
  time.sleep(2)
 else:raise RuntimeError('workflow did not settle')
print('PASS native workflows: direct cards bypass production judgment; recorded-log analysis never executes an agent')
