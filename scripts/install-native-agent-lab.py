#!/usr/bin/env python3
"""Apply the Agent Lab workflow to LangWatch's own source, build and deploy it."""
import hashlib,json,os,shutil,subprocess,time
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
HOME=ROOT/'langwatch/.local'; APP=HOME/'app/platform/app'; CUSTOM=ROOT/'langwatch-custom'
NODE='/opt/homebrew/bin/node' if Path('/opt/homebrew/bin/node').is_file() else shutil.which('node')
ENV={**os.environ,'PATH':str(Path(NODE).parent)+os.pathsep+os.environ.get('PATH',''),'NODE_ENV':'production','BUILD_TIME':'1'}

def edit(file,anchor,replacement,marker):
 text=file.read_text()
 if marker in text:return
 if anchor not in text:raise RuntimeError('Версия LangWatch изменилась: точка подключения не найдена в '+str(file))
 file.write_text(text.replace(anchor,replacement,1))

def main():
 if not APP.exists():raise SystemExit('Сначала запустите LangWatch')
 subprocess.run(['python3',str(ROOT/'scripts/migrate-native-agent-lab.py')],check=True)
 tools=HOME/'build-tools'
 if not (tools/'node_modules/@vitejs/plugin-react').exists() or not (tools/'node_modules/selfsigned').exists():
  npm=str(Path(NODE).parent/'npm')
  subprocess.run([npm,'install','--prefix',str(tools),'--ignore-scripts','--no-audit','--no-fund','vite@8.1.2','@vitejs/plugin-react@6.0.3','selfsigned@3.0.1'],env=ENV,check=True)
 for name in ('vite','@vitejs/plugin-react','selfsigned'):
  target=APP/'node_modules'/name
  if not target.exists():target.parent.mkdir(parents=True,exist_ok=True);target.symlink_to(tools/'node_modules'/name,target_is_directory=True)
 sass=APP/'node_modules/sass'
 if not sass.exists():
  shared=HOME/'app/node_modules/.pnpm/node_modules/sass'
  if shared.exists():sass.symlink_to(shared,target_is_directory=True)
  else:
   subprocess.run([str(Path(NODE).parent/'npm'),'install','--prefix',str(tools),'--ignore-scripts','--no-audit','--no-fund','sass@1.101.0'],env=ENV,check=True)
   sass.symlink_to(tools/'node_modules/sass',target_is_directory=True)
 # The published server installs production dependencies only. Reuse cached
 # browser dependencies from its pnpm store without changing runtime packages.
 package=json.loads((APP/'package.json').read_text())
 skip=('@types/','@testing-library/','@testcontainers/')
 excluded={'@biomejs/biome','babel-plugin-react-compiler','concurrently','fishery','node-mocks-http','testcontainers'}
 missing=[name+'@'+version for name,version in package.get('devDependencies',{}).items()
          if not (APP/'node_modules'/name).exists() and not (HOME/'app/node_modules/.pnpm/node_modules'/name).exists()
          and not (tools/'node_modules'/name).exists() and not name.startswith(skip) and name not in excluded]
 if missing:subprocess.run([str(Path(NODE).parent/'npm'),'install','--prefix',str(tools),'--ignore-scripts','--legacy-peer-deps','--no-audit','--no-fund',*missing],env=ENV,check=True)
 for name in package.get('devDependencies',{}):
  target=APP/'node_modules'/name;shared=HOME/'app/node_modules/.pnpm/node_modules'/name
  if not target.exists() and shared.exists():target.parent.mkdir(parents=True,exist_ok=True);target.symlink_to(shared,target_is_directory=True)
  elif not target.exists() and (tools/'node_modules'/name).exists():target.parent.mkdir(parents=True,exist_ok=True);target.symlink_to(tools/'node_modules'/name,target_is_directory=True)
 peers=['@tiptap/core@3.31.3','@tiptap/extensions@3.31.3','monaco-editor@0.55.1']
 absent=[spec for spec in peers if not (tools/'node_modules'/spec.rsplit('@',1)[0]).exists()]
 if absent:subprocess.run([str(Path(NODE).parent/'npm'),'install','--prefix',str(tools),'--ignore-scripts','--legacy-peer-deps','--no-audit','--no-fund',*absent],env=ENV,check=True)
 # Browser plugins resolve their runtime peers from the isolated tools dir.
 for name in {*package.get('dependencies',{}), 'react-dom'}:
  peer=tools/'node_modules'/name;runtime=APP/'node_modules'/name
  if not peer.exists() and runtime.exists():peer.parent.mkdir(parents=True,exist_ok=True);peer.symlink_to(runtime.resolve(),target_is_directory=True)
 vite=APP/'vite.config.ts';config=vite.read_text()
 if 'dedupe: ["zod"]' in config:vite.write_text(config.replace('dedupe: ["zod"]','dedupe: ["zod", "react", "react-dom"]'))
 for source in CUSTOM.rglob('*'):
  if source.is_file() and source.suffix in ('.ts','.tsx','.py'):
   destination=APP/source.relative_to(CUSTOM);destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,destination)
 router=APP/'src/server/api-router.ts'
 edit(router,'export function createApiRouter()',"import { app as agentLabApp } from './agent-lab/routes';\n\nexport function createApiRouter()",'import { app as agentLabApp }')
 edit(router,'  const api = new Hono();','  const api = new Hono();\n  api.route("/", agentLabApp);','api.route("/", agentLabApp)')
 datasets=APP/'src/pages/[project]/datasets.tsx'
 edit(datasets,'import {',"import { AgentLabPanel } from '~/components/agent-lab/AgentLabPanel';\nimport {",'import { AgentLabPanel }')
 edit(datasets,'        <Spacer />','        <Spacer />\n        {project && <AgentLabPanel projectId={project.id} projectSlug={project.slug} />}','<AgentLabPanel projectId=')
 detail=APP/'src/pages/[project]/datasets/[id].tsx'
 edit(detail,'import {',"import { AgentLabPanel } from '~/components/agent-lab/AgentLabPanel';\nimport {",'import { AgentLabPanel }')
 edit(detail,'      <Box width="full" paddingX={6} paddingY={6}>','      <Box width="full" paddingX={6} paddingY={6}>\n        {project && <Box marginBottom={4}><AgentLabPanel projectId={project.id} projectSlug={project.slug} datasetId={datasetId} /></Box>}','<AgentLabPanel projectId=')
 experiment=APP/'src/pages/[project]/experiments/[experiment].tsx'
 edit(experiment,'import {',"import { AgentLabPanel } from '~/components/agent-lab/AgentLabPanel';\nimport {",'import { AgentLabPanel }')
 edit(experiment,'    <DashboardLayout>\n      {project && experiment.data', '    <DashboardLayout>\n      {project && String(experimentSlug).startsWith("real-log-analysis-") && <Box padding={4}><AgentLabPanel projectId={project.id} projectSlug={project.slug} analysisPrefix={String(experimentSlug).slice("real-log-analysis-".length)} /></Box>}\n      {project && experiment.data','analysisPrefix={String(experimentSlug)')
 edit(datasets,'  return (\n    <DashboardLayout>\n      <PageLayout.Header>', '  if (router.query.agentLab === \"1\" && project) return <DashboardLayout><AgentLabPanel projectId={project.id} projectSlug={project.slug} /></DashboardLayout>;\n\n  return (\n    <DashboardLayout>\n      <PageLayout.Header>', 'if (router.query.agentLab === \"1\"')
 menu=APP/'src/components/MainMenu.tsx'
 edit(menu,'      <PageMenuLink','      <PageMenuLink path="/[project]/datasets?agentLab=1" icon={Workflow} label="Анализ агента" project={project} showLabel={showExpanded} />\n      <PageMenuLink','label="Анализ агента"')
 # Remove the old proxy from source. The old files and data remain recoverable.
 start=APP/'src/start.ts';text=start.read_text();text=text.replace("import { handleLocalReview } from './server/local-review-proxy';\n",'').replace('      if (await handleLocalReview(req, res)) return;\n\n','');start.write_text(text)
 stamp=hashlib.sha256(b''.join(p.read_bytes() for p in sorted(CUSTOM.rglob('*')) if p.is_file() and p.suffix in ('.ts','.tsx','.py'))+router.read_bytes()+datasets.read_bytes()+detail.read_bytes()+menu.read_bytes()+experiment.read_bytes()).hexdigest()
 marker=HOME/'native-agent-lab-build-hash'
 if marker.exists() and marker.read_text()==stamp:
  print('Native Agent Lab уже установлен: http://localhost:5560/local-dev-project-se7hbx/datasets?agentLab=1');return
 # Build separately: failed builds never erase the user's running client.
 staged=APP/'dist/client-agent-lab-staged'
 subprocess.run([NODE,str(APP/'node_modules/vite/bin/vite.js'),'build','--outDir',str(staged)],cwd=APP,env=ENV,check=True)
 server_sources=[p for p in CUSTOM.rglob('*.ts') if '/server/' in str(p)]
 server_stamp=hashlib.sha256(b''.join(p.read_bytes() for p in sorted(server_sources))+router.read_bytes()+start.read_bytes()).hexdigest()
 server_marker=HOME/'native-agent-lab-server-hash'
 server_changed=not server_marker.exists() or server_marker.read_text()!=server_stamp
 if server_changed:subprocess.run([NODE,'scripts/build-server.mjs'],cwd=APP,env=ENV,check=True)
 live=APP/'dist/client'
 for source in staged.rglob('*'):
  if source.is_file() and source.name!='index.html':
   destination=live/source.relative_to(staged);destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,destination)
 shutil.copyfile(staged/'index.html',live/'index.html')
 # Old bookmark opens the native dataset panel; no parallel product remains.
 (live/'agent-review.html').write_text('<!doctype html><html lang="ru"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/local-dev-project-se7hbx/datasets?agentLab=1"><a href="/local-dev-project-se7hbx/datasets?agentLab=1">Открыть анализ внутри LangWatch</a></html>')
 if not server_changed:
  marker.write_text(stamp)
  print('Интерфейс LangWatch обновлён; API и прогоны продолжают работать.');return
 environment=dict(ENV)
 for line in (HOME/'.env').read_text().splitlines():
  if '=' in line and not line.startswith('#'):
   name,value=line.split('=',1);environment[name]=value.strip('"')
 environment['NODE_ENV']='production'
 environment.pop('BUILD_TIME',None)
 listeners=subprocess.run(['lsof','-t','-iTCP:5560','-sTCP:LISTEN'],text=True,capture_output=True).stdout.split()
 supervisor=None
 for listener in set(listeners):
  pid=int(listener)
  for _ in range(12):
   line=subprocess.run(['ps','-p',str(pid),'-o','ppid=,command='],text=True,capture_output=True).stdout.strip()
   if not line:break
   parent,command=line.split(None,1)
   if 'langwatch-server start' in command and 'npm exec' not in command:supervisor=pid;break
   pid=int(parent)
   if pid<=1:break
 # The managed CLI shuts down its infrastructure when its web child exits.
 # Restart through the same CLI so all native services return together.
 if supervisor:
  os.kill(supervisor,2)
  for _ in range(120):
   if not subprocess.run(['ps','-p',str(supervisor),'-o','pid='],text=True,capture_output=True).stdout.strip():break
   time.sleep(.5)
  else:raise RuntimeError('Supervisor LangWatch ещё завершает работу')
  for _ in range(60):
   active=subprocess.run(['lsof','-t','-iTCP:5560','-iTCP:6560','-iTCP:6561','-sTCP:LISTEN'],text=True,capture_output=True).stdout.strip()
   if not active:break
   time.sleep(.5)
  else:raise RuntimeError('Сервисы LangWatch ещё завершают работу')
 else:
  for pid in set(listeners):os.kill(int(pid),15)
 for _ in range(60):
  if not subprocess.run(['lsof','-t','-iTCP:5560','-sTCP:LISTEN'],text=True,capture_output=True).stdout.strip():break
  time.sleep(.5)
 else:raise RuntimeError('Предыдущий LangWatch ещё завершает работу')
 environment['LANGWATCH_HOME']=str(HOME)
 environment['LANGWATCH_CONNECT_DISABLED']='true'
 environment['DISABLE_USAGE_STATS']='true'
 environment['LANGWATCH_LOCAL_STORAGE_PATH']=str(HOME/'data/objects')
 with (HOME/'native-agent-lab-web.log').open('ab') as log:
  command=[str(Path(NODE).parent/'npm'),'exec','--yes','--package=@langwatch/server@3.17.0','--','langwatch-server','start','--yes','--no-open'] if supervisor else [NODE,'--enable-source-maps','dist/server/server.cjs']
  child=subprocess.Popen(command,cwd=APP,env=environment,stdout=log,stderr=log,start_new_session=True)
 (HOME/'run/native-agent-lab.pid').write_text(str(child.pid))
 import urllib.request
 for _ in range(120):
  try:
   with urllib.request.urlopen('http://localhost:5560/auth/signin',timeout=2) as response:
    if response.status==200:break
  except Exception:pass
  if child.poll() is not None:raise RuntimeError('LangWatch не запустился; смотрите native-agent-lab-web.log')
  time.sleep(.5)
 else:raise RuntimeError('LangWatch не ответил после перезапуска')
 marker.write_text(stamp)
 server_marker.write_text(server_stamp)
 print('Native Agent Lab установлен в Datasets, Experiments и Scenarios.')

if __name__=='__main__':main()
