#!/usr/bin/env python3
"""Native event ingestion and native run API preserve partial evidence. No model calls."""
import json,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
ns={'__file__':str(ROOT/'source-tests/native-frozen.e2e.py')}
exec((ROOT/'source-tests/native-frozen.e2e.py').read_text().split('class Fixture')[0],ns)
api=ns['api'];criteria=['Public fixture criterion '+str(i) for i in range(20)]
scenario=api('/api/scenarios',{'name':'Synthetic partial evidence control','situation':'Public fixture for native outcome ingestion, no agent or model invoked.','criteria':criteria,'labels':['synthetic-contract-probe']})
run='synthetic_unknown_'+uuid.uuid4().hex
common={'scenarioId':scenario['id'],'scenarioRunId':run,'batchRunId':'synthetic_partial_evidence','scenarioSetId':'synthetic-controls','timestamp':int(time.time()*1000)}
api('/api/scenario-events',{'type':'SCENARIO_RUN_STARTED',**common,'metadata':{'name':'Synthetic partial evidence: 1 PASS + 19 UNKNOWN'}})
api('/api/scenario-events',{'type':'SCENARIO_RUN_FINISHED',**common,'status':'SUCCESS','results':{'verdict':'inconclusive','reasoning':'Public fixture: no evidence for nineteen required criteria.','metCriteria':criteria[:1],'unmetCriteria':[],'inconclusiveCriteria':criteria[1:]}})
deadline=time.time()+40
while time.time()<deadline:
 try:data=api('/api/simulation-runs/'+run)
 except RuntimeError as e:
  if str(e).startswith('404:'):time.sleep(1);continue
  raise
 results=data.get('results')or{}
 if results.get('verdict')=='inconclusive':
  assert data['status']=='ERROR',data['status']
  assert results['metCriteria']==criteria[:1]
  assert results['unmetCriteria']==[]
  assert results['inconclusiveCriteria']==criteria[1:]
  print(json.dumps({'runId':run,'status':data['status'],'verdict':results['verdict'],'passed':1,'violations':0,'unknown':19}),flush=True)
  print('PASS native event -> fold -> API: incomplete evidence is never SUCCESS or nineteen business failures');break
 time.sleep(1)
else:raise RuntimeError('native evidence outcome did not arrive')
