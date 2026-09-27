#!/usr/bin/env python3
"""Resume a public synthetic preparation after a lost save receipt; no model or agent calls."""
import json,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
ns={'__file__':str(ROOT/'source-tests/native-workflows.e2e.py')}
exec((ROOT/'source-tests/native-workflows.e2e.py').read_text().split("dataset=api(")[0],ns)
session=ns['session'];project=ns['project'];directory=ROOT/'langwatch/.local/data/agent-lab'/project
jobs=[(p,json.loads(p.read_text())) for p in directory.glob('*.json')]
file,job=next((p,j) for p,j in jobs if j.get('purpose')=='verify' and not j.get('agentId') and any(d.get('id')=='public-fixture' for d in j.get('dialogues',[])) and j.get('cards'))
original_ids=[c.get('scenarioId') for c in job['cards']]
assert all(original_ids)
backup=ROOT/'langwatch/.local/evidence/resume-public-fixture-before.json';backup.write_text(json.dumps(job))
job['status']='interrupted';job['cards'][0]['status']='draft';job['cards'][0].pop('scenarioId',None)
file.write_text(json.dumps(job))
session('/api/agent-lab/resume',{'projectId':project,'id':job['id']})
deadline=time.time()+30
while time.time()<deadline:
 current=session('/api/agent-lab/analysis/'+job['id']+'?projectId='+project)
 if current['status'] in ['done','failed']:
  assert current['status']=='done',current.get('error')
  assert current['results']==[], 'resume entered production judgment'
  assert [c.get('scenarioId') for c in current['cards']]==original_ids,'duplicate or missing native scenario'
  print('PASS native resume: direct preparation keeps zero recorded judgments and recovers the same native scenario');break
 time.sleep(1)
else:raise RuntimeError('resume did not finish')
