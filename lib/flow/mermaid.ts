import type { FlowContent, FlowTransitions } from './flow';

interface Edge {
  readonly label: string;
  readonly to: string;
}

function escapeLabel(value: string): string {
  return value
    .replaceAll('#', '#35;')
    .replaceAll('&', '#amp;')
    .replaceAll('"', '#quot;')
    .replaceAll('|', '#124;')
    .replaceAll('<', '#lt;')
    .replaceAll('>', '#gt;')
    .replaceAll('[', '#91;')
    .replaceAll(']', '#93;')
    .replaceAll('{', '#123;')
    .replaceAll('}', '#125;')
    .replaceAll('(', '#40;')
    .replaceAll(')', '#41;');
}

function nodeId(key: string): string {
  return `n_${key.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function nodeIds(keys: readonly string[]): Map<string, string> {
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const key of keys) {
    const base = nodeId(key);
    let id = base;
    let suffix = 2;
    while (taken.has(id)) {
      id = `${base}_${suffix}`;
      suffix += 1;
    }
    taken.add(id);
    if (!ids.has(key)) {
      ids.set(key, id);
    }
  }
  return ids;
}

function conditionLabel(
  type: string,
  condition: { readonly Operator: string; readonly Operands: readonly string[] },
): string {
  const operand = condition.Operands.length === 1 ? condition.Operands[0] : undefined;
  if (type === 'CheckHoursOfOperation' && condition.Operator === 'Equals' && operand === 'True') {
    return 'inHours';
  }
  if (type === 'CheckHoursOfOperation' && condition.Operator === 'Equals' && operand === 'False') {
    return 'outOfHours';
  }
  if (condition.Operator === 'Exists' && condition.Operands.length === 0) {
    return 'Exists';
  }
  if (condition.Operator === 'Equals' && operand !== undefined) {
    return operand;
  }
  return [condition.Operator, ...condition.Operands].join(' ');
}

function edges(type: string, transitions: FlowTransitions): Edge[] {
  return [
    ...(transitions.NextAction === undefined ? [] : [{ label: 'next', to: transitions.NextAction }]),
    ...(transitions.Conditions ?? []).map((branch) => ({
      label: conditionLabel(type, branch.Condition),
      to: branch.NextAction,
    })),
    ...(transitions.Errors ?? []).map((branch) => ({
      label: branch.ErrorType,
      to: branch.NextAction,
    })),
  ];
}

export function toMermaid(content: FlowContent): string {
  const ids = nodeIds(content.Actions.map((action) => action.Identifier));
  const idFor = (key: string) => ids.get(key) ?? nodeId(key);
  const lines = ['flowchart TD'];
  for (const action of content.Actions) {
    lines.push(`  ${idFor(action.Identifier)}["${escapeLabel(action.Identifier)}<br/>${escapeLabel(action.Type)}"]`);
  }
  for (const action of content.Actions) {
    for (const edge of edges(action.Type, action.Transitions)) {
      lines.push(`  ${idFor(action.Identifier)} -->|"${escapeLabel(edge.label)}"| ${idFor(edge.to)}`);
    }
  }
  return lines.join('\n');
}

export function diagramPage(title: string, content: FlowContent): string {
  return `# ${title}\n\n\`\`\`mermaid\n${toMermaid(content)}\n\`\`\`\n`;
}
