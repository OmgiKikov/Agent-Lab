"""Adds the Agent Lab section to a Raindrop Workshop checkout (app/src). Idempotent."""
import sys
from pathlib import Path

src = Path(sys.argv[1])

nav = src / 'components/NavSidebar.tsx'
text = nav.read_text()
if 'agent lab' not in text:
    text = text.replace('import { Activity, Bookmark, Search, Settings } from "lucide-react";',
                        'import { Activity, Bookmark, FlaskConical, Search, Settings } from "lucide-react";')
    text = text.replace('export type Page = "runs" | "search" | "saved" | "settings";',
                        'export type Page = "lab" | "runs" | "search" | "saved" | "settings";')
    text = text.replace('  { id: "runs", label: "runs", path: "/runs", icon: Activity },',
                        '  { id: "lab", label: "agent lab", path: "/lab", icon: FlaskConical },\n'
                        '  { id: "runs", label: "runs", path: "/runs", icon: Activity },')
    assert 'agent lab' in text, 'NavSidebar layout changed upstream'
    nav.write_text(text)

router = src / 'router.tsx'
text = router.read_text()
if 'LabPage' not in text:
    text = text.replace('import { RunsPage } from "./pages/RunsPage";',
                        'import { RunsPage } from "./pages/RunsPage";\nimport { LabPage } from "./pages/LabPage";')
    text = text.replace('      { index: true, element: <Navigate to="/runs" replace /> },',
                        '      { index: true, element: <Navigate to="/lab" replace /> },\n'
                        '      { path: "lab", element: <LabPage /> },\n'
                        '      { path: "lab/:step", element: <LabPage /> },\n'
                        '      { path: "lab/:step/:itemId", element: <LabPage /> },')
    assert 'lab/:step/:itemId' in text, 'router layout changed upstream'
    router.write_text(text)
# Upstream fix: with initialData=[] and staleTime=2s the list of an existing run is
# never fetched on mount, so annotations of past runs only appeared via live WS.
hook = src / 'hooks/use-annotations.ts'
text = hook.read_text()
if 'initialData: [] as Annotation[],' in text:
    hook.write_text(text.replace('initialData: [] as Annotation[],', 'placeholderData: [] as Annotation[],'))
# Agent Lab judge notes: the daemon only accepts user/claude-code/codex as a source, so Lab
# marks its notes with a prefix; the UI turns that into its own author "Судья · Agent Lab".
api = src / 'api/annotations.ts'
text = api.read_text()
if 'LAB_NOTE_MARK' not in text:
    text = text.replace('export type AnnotationSource = "user" | "claude-code" | "codex";',
                        'export type AnnotationSource = "user" | "claude-code" | "codex" | "agent-lab";\n\n'
                        'const LAB_NOTE_MARK = "[agent-lab] ";\n\n'
                        '/** Agent Lab verdicts arrive as codex notes with a prefix; show them as the Lab judge. */\n'
                        'export function fromLab(annotation: Annotation): Annotation {\n'
                        '  if (!annotation.note?.startsWith(LAB_NOTE_MARK)) return annotation;\n'
                        '  return { ...annotation, source: "agent-lab", note: annotation.note.slice(LAB_NOTE_MARK.length) };\n'
                        '}')
    text = text.replace('  return apiJson<Annotation[]>(`/api/annotations?run_id=${encodeURIComponent(runId)}`);',
                        '  return (await apiJson<Annotation[]>(`/api/annotations?run_id=${encodeURIComponent(runId)}`)).map(fromLab);')
    assert 'map(fromLab)' in text, 'annotations api changed upstream'
    api.write_text(text)

hook = src / 'hooks/use-annotations.ts'
text = hook.read_text()
if 'fromLab' not in text:
    text = text.replace('  deleteAnnotation,\n  listAnnotations,', '  deleteAnnotation,\n  fromLab,\n  listAnnotations,')
    text = text.replace('    if (data.op === "insert") {\n', '    if (data.op === "insert") {\n      data = { ...data, annotation: fromLab(data.annotation) };\n', 1)
    assert 'fromLab(data.annotation)' in text, 'annotations hook changed upstream'
    hook.write_text(text)

chip = src / 'components/AnnotationChip.tsx'
text = chip.read_text()
if '"agent-lab"' not in text:
    text = text.replace('  codex: "›",\n  user: "·",', '  codex: "›",\n  user: "·",\n  "agent-lab": "⚖",')
    text = text.replace('  if (source === "codex") return "Codex";', '  if (source === "codex") return "Codex";\n  if (source === "agent-lab") return "Судья · Agent Lab";')
    assert 'Судья · Agent Lab' in text, 'annotation chip changed upstream'
    chip.write_text(text)

row = src / 'components/TraceAnnotations.tsx'
text = row.read_text()
if 'pre-line' not in text:
    text = text.replace('<div style={{ fontSize: 12, color: C.fg, lineHeight: 1.5 }}><DeepLinkedText text={annotation.note} /></div>',
                        '<div style={{ fontSize: 12, color: C.fg, lineHeight: 1.5, whiteSpace: annotation.source === "agent-lab" ? "pre-line" : undefined }}><DeepLinkedText text={annotation.note} /></div>')
    assert 'pre-line' in text, 'trace annotations changed upstream'
    row.write_text(text)
print('patched', src)
