// The server's default model (DISP-117) and how a model reads in the app.
import { useQuery } from '@tanstack/react-query';
import type { ModelDefaults } from '../../src/shared/types.ts';
import { api } from './api.ts';

export const useModelDefaults = () => useQuery({ queryKey: ['settings', 'model'], queryFn: () => api.get<ModelDefaults>('/settings/model') });

const FAMILY: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', fable: 'Fable', haiku: 'Haiku' };

/** "claude-opus-5-5" → "Opus 5.5"; a family alone ("opus") → "Opus"; anything else as it is. */
export function modelName(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/.exec(model);
  if (m && FAMILY[m[1]]) return `${FAMILY[m[1]]} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' (1M)' : ''}`;
  return FAMILY[model] ?? model;
}

/** The hint under a model picker: what Default is now. */
export const defaultHint = (d: ModelDefaults | undefined) => (d ? `Default: the server's default, now ${modelName(d.model)} at ${d.effort} effort.` : undefined);
