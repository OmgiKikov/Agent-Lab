"""Read XLSX sheet headers and literal cell text for the native dataset importer."""
import io,json,posixpath,re,sys,zipfile
from xml.etree import ElementTree as ET
raw=sys.stdin.buffer.read(15_000_001)
if len(raw)>15_000_000:raise ValueError('Таблица больше 15 МБ')
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(io.BytesIO(raw)) as archive:
 if sum(x.file_size for x in archive.infolist())>50_000_000:raise ValueError('Распакованная таблица больше 50 МБ')
 shared=[]
 if 'xl/sharedStrings.xml' in archive.namelist():shared=[''.join(x.itertext()) for x in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('m:si',ns)]
 relns={'r':'http://schemas.openxmlformats.org/package/2006/relationships'}
 relationships={r.attrib['Id']:r.attrib['Target'] for r in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels')).findall('r:Relationship',relns)}
 sheets=[]
 for sheet in ET.fromstring(archive.read('xl/workbook.xml')).findall('m:sheets/m:sheet',ns):
  target=relationships.get(sheet.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'))
  if not target:continue
  filename=target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/'+target)
  if filename not in archive.namelist():continue
  rows=[]
  for row in ET.fromstring(archive.read(filename)).findall('.//m:sheetData/m:row',ns):
   cells={}
   for cell in row.findall('m:c',ns):
    letters=re.match(r'[A-Z]+',cell.attrib.get('r','A1')).group();index=0
    for letter in letters:index=index*26+ord(letter)-64
    value=cell.find('m:v',ns);text=value.text if value is not None and value.text else ''
    if cell.attrib.get('t')=='s':text=shared[int(text)] if text else ''
    elif cell.attrib.get('t')=='inlineStr':
     inline=cell.find('m:is',ns);text=''.join(inline.itertext()) if inline is not None else ''
    cells[index-1]=text
   if cells:rows.append([cells.get(i,'') for i in range(max(cells)+1)])
  if not rows:continue
  headers=rows[0]
  if len(headers)!=len(set(headers)):raise ValueError('Повторяющиеся заголовки колонок: '+sheet.attrib['name'])
  sheets.append({'name':sheet.attrib['name'],'rows':[{h:r[i] if i<len(r) else '' for i,h in enumerate(headers)} for r in rows[1:]]})
print(json.dumps(sheets,ensure_ascii=False))
