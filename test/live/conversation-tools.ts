// Инструменты, которые внешний разговор Agent Lab отдаёт модели: встроенные инструменты Pi и
// инструменты расширения agent-lab. Общий источник для диагностики схем на шлюзе.
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createCodingTools, createReadOnlyTools } from '@earendil-works/pi-coding-agent';
import agentLab from '../../extensions/agent-lab.ts';

export interface DeclaredTool { name: string; description: string; parameters: unknown }

export async function conversationTools(cwd = process.cwd()): Promise<DeclaredTool[]> {
  // Разговор получает инструменты правки кода и поиска; повторы по имени убираются.
  const byName = new Map([...createCodingTools(cwd), ...createReadOnlyTools(cwd)].map(tool => [tool.name, tool]));
  const builtIn = [...byName.values()].map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  const extension: DeclaredTool[] = [];
  await agentLab({
    registerTool: (tool: ToolDefinition) => extension.push({ name: tool.name, description: tool.description, parameters: tool.parameters }),
    registerCommand() {}, registerProvider() {}, on() {}, sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI);
  return [...builtIn, ...extension];
}
