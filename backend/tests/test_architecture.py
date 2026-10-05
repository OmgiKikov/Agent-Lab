"""The layers of backend/lab and the one direction of their imports (docs/backend.md, «Слои»).

A module imports from its own layer or from a layer its layer may use, never from one above, and no modules import
each other in a circle, not even inside a function. What the code still breaks is listed here by name, and the lists
only shrink: a fixed import fails the test until it leaves the list, a new one fails it at once.
"""

import ast
import unittest
from pathlib import Path

LAB = Path(__file__).resolve().parents[1] / 'lab'

# What each layer may import besides itself (docs/superpowers/specs/2026-10-05-backend-architecture-design.md, п. 2).
USES = {
    'app': {'api', 'flows', 'roles', 'agents', 'domain', 'storage', 'models', 'config'},
    'api': {'flows', 'agents', 'domain', 'storage', 'models', 'config'},
    'flows': {'roles', 'agents', 'domain', 'storage', 'models', 'config'},
    'roles': {'models', 'domain'},
    'agents': {'domain', 'config'},
    'models': {'storage', 'config'},
    'storage': {'domain', 'config'},
    'domain': set(),
    'config': set(),
}
# A package is its layer (lab/flows/… is flows); the modules outside the packages are named here.
LAYERS = {
    'lab.app': 'app',
    'lab.migrate': 'app',
    'lab.api': 'api',
    'lab.jobs': 'api',
    'lab.config': 'config',
    # Until they move into their packages.
    'lab.discover': 'flows',
    'lab.tone': 'flows',
    'lab.tone_advice': 'flows',
    'lab.tone_history': 'flows',
    'lab.accuracy_history': 'flows',
    'lab.cards': 'flows',
    'lab.simulate': 'flows',
    'lab.severity': 'flows',
    'lab.scenarios': 'flows',
    'lab.problems': 'flows',
    'lab.compare': 'flows',
    'lab.judge': 'roles',
    'lab.judge_reply': 'roles',
    'lab.prompts': 'roles',
    'lab.quotes': 'domain',
    'lab.history': 'domain',
    'lab.metric': 'domain',
    'lab.checks': 'domain',
    'lab.personas': 'domain',
    'lab.transcript': 'domain',
    'lab.policy_files': 'domain',
    'lab.logs': 'storage',
    'lab.store': 'storage',
    'lab.registry': 'storage',
    'lab.llm': 'models',
    'lab.context': 'agents',
}
# Imports that go up today, importer → imported.
UPWARD = {
    ('lab.agents', 'lab.store'),  # agents → storage
    ('lab.agents.source', 'lab.store'),  # agents → storage
    ('lab.agents.world', 'lab.llm'),  # agents → models
    ('lab.agents.world', 'lab.prompts'),  # agents → roles
    ('lab.context.sources', 'lab.store'),  # agents → storage
    ('lab.judge', 'lab.context.knowledge'),  # roles → agents
    ('lab.judge', 'lab.logs'),  # roles → storage
    ('lab.severity', 'lab.jobs'),  # flows → api
    ('lab.simulate', 'lab.jobs'),  # flows → api
    ('lab.store', 'lab.accuracy_history'),  # storage → flows
    ('lab.tone', 'lab.jobs'),  # flows → api
}
# Modules that import each other in a circle today: store → accuracy_history → discover → judge → llm → gateway → store.
CIRCLES = {
    'lab.accuracy_history',
    'lab.agents',
    'lab.agents.source',
    'lab.context.knowledge',
    'lab.context.sources',
    'lab.discover',
    'lab.judge',
    'lab.llm',
    'lab.llm.gateway',
    'lab.logs',
    'lab.store',
}


def module_of(path: Path) -> str:
    parts = path.relative_to(LAB.parent).with_suffix('').parts
    return '.'.join(parts[:-1] if parts[-1] == '__init__' else parts)


def modules() -> dict[str, Path]:
    return {module_of(path): path for path in sorted(LAB.rglob('*.py'))}


def imports(module: str, path: Path, known: set[str]) -> set[str]:
    """The Lab's modules this one imports, anywhere in it: at the top, inside a function, under TYPE_CHECKING."""
    package = module if path.name == '__init__.py' else module.rpartition('.')[0]
    found = set()
    for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'))):
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ''
            if node.level:
                anchor = package.split('.')[: len(package.split('.')) - node.level + 1]
                base = '.'.join([*anchor, *([node.module] if node.module else [])])
            names = [f'{base}.{alias.name}' if f'{base}.{alias.name}' in known else base for alias in node.names]
        else:
            continue
        found.update(name for name in names if name in known and name != module)
    return found


def layer(module: str) -> str | None:
    for name in (module, *(module.rsplit('.', depth)[0] for depth in range(1, module.count('.')))):
        if name in LAYERS:
            return LAYERS[name]
    parts = module.split('.')
    return parts[1] if len(parts) > 1 and parts[1] in USES else None


def graph() -> dict[str, set[str]]:
    found = modules()
    known = set(found)
    return {module: imports(module, path, known) for module, path in found.items() if module != 'lab'}


def circles(edges: dict[str, set[str]]) -> set[str]:
    """The modules that lie on a circle of imports (Tarjan's strongly connected components)."""
    index, low, stack, on_stack, found = {}, {}, [], set(), set()

    def visit(module: str) -> None:
        index[module] = low[module] = len(index)
        stack.append(module)
        on_stack.add(module)
        for other in edges.get(module, ()):
            if other not in index:
                visit(other)
                low[module] = min(low[module], low[other])
            elif other in on_stack:
                low[module] = min(low[module], index[other])
        if low[module] == index[module]:
            component = []
            while True:
                other = stack.pop()
                on_stack.discard(other)
                component.append(other)
                if other == module:
                    break
            if len(component) > 1:
                found.update(component)

    for module in sorted(edges):
        if module not in index:
            visit(module)
    return found


class ArchitectureTests(unittest.TestCase):
    def test_every_module_has_a_layer(self) -> None:
        self.assertEqual([module for module in graph() if layer(module) is None], [])

    def test_imports_go_down_the_layers(self) -> None:
        upward = {
            (module, other)
            for module, others in graph().items()
            for other in others
            if layer(other) != layer(module) and layer(other) not in USES[layer(module)]
        }
        self.assertEqual(sorted(upward - UPWARD), [], 'new imports up the layers')
        self.assertEqual(sorted(UPWARD - upward), [], 'fixed: remove them from UPWARD')

    def test_no_modules_import_each_other_in_a_circle(self) -> None:
        found = circles(graph())
        self.assertEqual(sorted(found - CIRCLES), [], 'new modules on a circle of imports')
        self.assertEqual(sorted(CIRCLES - found), [], 'off the circle now: remove them from CIRCLES')


if __name__ == '__main__':
    unittest.main()
