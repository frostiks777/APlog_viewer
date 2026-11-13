import { compileMatcher, styleIdsFor, visibleFlags, type CompiledMatcher } from './evaluate';
import type { EvalRequest, RuleError, WorkerReply, WorkerRule } from './protocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<EvalRequest>) => void) | null;
  postMessage(message: WorkerReply): void;
}

const scope = self as unknown as WorkerScope;

function compileAll(rules: WorkerRule[], errors: RuleError[]): CompiledMatcher[] {
  const compiled: CompiledMatcher[] = [];
  for (const rule of rules) {
    const { matcher, error } = compileMatcher(rule);
    if (error) errors.push({ id: rule.id, message: error });
    if (matcher) compiled.push(matcher);
  }
  return compiled;
}

scope.onmessage = (event) => {
  const request = event.data;
  if (!request || request.type !== 'eval') return;

  try {
    const errors: RuleError[] = [];
    const rules = compileAll(request.rules, errors);
    const include = compileAll(request.include, errors);
    const exclude = compileAll(request.exclude, errors);

    // «start» уходит ровно перед матчингом правила: именно там возможен бэктрекинг.
    const announce = (ruleId: string) => scope.postMessage({ type: 'start', id: request.id, ruleId });

    scope.postMessage({
      type: 'done',
      id: request.id,
      styles: styleIdsFor(request.lines, rules, announce),
      visible: visibleFlags(request.lines, include, exclude, announce),
      errors,
    });
  } catch (cause) {
    scope.postMessage({ type: 'fatal', id: request.id, message: (cause as Error).message });
  }
};
