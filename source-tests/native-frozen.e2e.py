#!/usr/bin/env python3
"""Native REST -> queued event -> paused worker -> immutable child execution. Synthetic data only."""
import json,os,signal,subprocess,threading,time,urllib.request,urllib.parse
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
ROOT=Path(__file__).resolve().parent.parent;LOCAL=ROOT/'langwatch/.local'
config=dict(line.split('=',1) for line in (LOCAL/'.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
u=urllib.parse.urlsplit(config['DATABASE_URL'].strip('"'));env={**os.environ,'PGPASSWORD':urllib.parse.unquote(u.password or '')}
key=subprocess.check_output(['/opt/homebrew/bin/psql','-h',u.hostname,'-p',str(u.port),'-U',u.username,'-d',u.path[1:],'-At','-c','SELECT "apiKey" FROM langwatch_db."Project" WHERE slug=\'local-dev-project-se7hbx\''],env=env,text=True).strip()
def api(path,body=None,method=None):
 request=urllib.request.Request('http://localhost:5560'+path,data=None if body is None else json.dumps(body).encode(),method=method or ('GET' if body is None else 'POST'),headers={'X-Auth-Token':key,'Content-Type':'application/json'})
 try:return json.load(urllib.request.urlopen(request,timeout=60))
 except urllib.error.HTTPError as error:raise RuntimeError(str(error.code)+': '+error.read().decode()[:300])
class Fixture(BaseHTTPRequestHandler):
 def do_POST(self):
  self.rfile.read(int(self.headers.get('Content-Length',0)));data=json.dumps({'reply':'FROZEN_ALPHA'}).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(data)
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',8094),Fixture);threading.Thread(target=server.serve_forever,daemon=True).start()
name='Synthetic frozen-contract '+str(int(time.time()))
agents=api('/api/agents');entries=agents.get('data',agents) if isinstance(agents,dict) else agents
base=next(a for a in entries if a['type']=='http');settings={**base['config'],'url':'http://127.0.0.1:8094/chat','headers':[]}
agent=api('/api/agents',{'name':name,'type':'http','config':settings})
scenario=api('/api/scenarios',{'name':name,'situation':'This is a synthetic platform test. Ask the assistant for a short greeting. No personal or bank data.','criteria':['The assistant reply must contain FROZEN_ALPHA.'],'labels':['synthetic-contract-probe'],'parameters':[{'name':'customer_contract','defaultValue':json.dumps({'mode':'scripted','opening':'Hello, please greet me.','followup':'Please greet me.','facts':[],'maxCustomerTurns':3})}]})
suite=api('/api/suites',{'name':name,'scenarioIds':[scenario['id']],'targets':[{'type':'http','referenceId':agent['id']}],'repeatCount':1})
# Pause only the native worker child in this local installation, never the tested bank agent.
lines=subprocess.check_output(['ps','-axo','pid,command'],text=True).splitlines();worker=int(next(line.split()[0] for line in lines if line.strip().endswith('node --enable-source-maps dist/server/workers.cjs')))
paused=False
try:
 os.kill(worker,signal.SIGSTOP);paused=True
 started=api('/api/suites/'+suite['id']+'/run',{'note':'Synthetic queue immutability probe'})
 assert started['jobCount']==1,started
 run_id=started['items'][0]['scenarioRunId']
 api('/api/scenarios/'+scenario['id'],{'criteria':['The assistant reply must contain FROZEN_BETA.'],'situation':'Edited after scheduling: ask only for BETA.','judgeModel':'custom/not-configured','simulatorModel':'custom/not-configured'},'PUT')
 synthetic_suite=suite['id'].replace("'","''")
 query='UPDATE langwatch_db."SimulationSuite" SET "judgeModel"=\'custom/not-configured\', "simulatorModel"=\'custom/not-configured\' WHERE id=\''+synthetic_suite+'\';'
 subprocess.run(['/opt/homebrew/bin/psql','-h',u.hostname,'-p',str(u.port),'-U',u.username,'-d',u.path[1:],'-c',query],env=env,stdout=subprocess.DEVNULL,check=True)
 print('QUEUED THEN EDITED scenario and suite; resuming native worker',flush=True)
 os.kill(worker,signal.SIGCONT);paused=False
 deadline=time.time()+300
 while time.time()<deadline:
  try:data=api('/api/simulation-runs/'+run_id)
  except RuntimeError as error:
   if str(error).startswith('404:'):time.sleep(2);continue
   raise
  if data['status'] not in ['IN_PROGRESS','QUEUED','PENDING','RUNNING']:
   result=data.get('results')or{};print(json.dumps({'runId':run_id,'status':data['status'],'scenarioVersion':data.get('scenarioVersion'),'verdict':result.get('verdict'),'metCriteria':result.get('metCriteria'),'reasoning':result.get('reasoning')},ensure_ascii=False),flush=True)
   assert data['status']=='SUCCESS',data['status']
   assert data.get('frozenManifest',{}).get('parameters',{}).get('customer_contract'), 'scripted client not frozen'
   assert data.get('scenarioVersion') is not None, 'scenario version not visible in native API'
   assert result.get('metCriteria')==['The assistant reply must contain FROZEN_ALPHA.'],result
   print('PASS native queue: executed original criterion/model settings after live scenario + suite edits',flush=True);break
  time.sleep(3)
 else:raise RuntimeError('Native run did not settle within five minutes')
finally:
 if paused:os.kill(worker,signal.SIGCONT)
 server.shutdown()
