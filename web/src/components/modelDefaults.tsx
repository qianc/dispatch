// Settings: the server's default model and effort (DISP-117). Every worker runs a session on
// Default with these; the install owner sets them, everyone else sees them.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_MODELS, EFFORTS, type ModelDefaults } from '../../../src/shared/types.ts';
import { api } from '../api.ts';
import { modelName, useModelDefaults } from '../models.ts';
import { ErrorText, Field, Section, Segmented } from './ui.tsx';

const EFFORT_LABELS = { low: 'Low', medium: 'Med', high: 'High', xhigh: 'XHigh', max: 'Max' } as const;

export function ModelDefaultsSection({ owner }: { owner: boolean }) {
  const qc = useQueryClient();
  const { data } = useModelDefaults();
  const save = useMutation({
    mutationFn: (patch: Partial<ModelDefaults>) => api.put<ModelDefaults>('/settings/model', patch),
    onSuccess: (next) => qc.setQueryData(['settings', 'model'], next),
  });
  return (
    <Section title="Default model">
      <div className="mx-3">
        <p className="text-[13px] text-muted mb-2">
          What a session on Default runs on, on every worker of this server. A model family, not a version: a session runs on the newest version of it. The session shows the exact model it runs on.
          {!owner && ' Only the install owner can change it.'}
        </p>
        {data && (owner ? (
          <>
            <Field label="Model" group><Segmented value={data.model} onChange={(model) => save.mutate({ model })} options={DEFAULT_MODELS.map((m) => ({ value: m, label: modelName(m) }))} /></Field>
            <Field label="Effort" group><Segmented value={data.effort} onChange={(effort) => save.mutate({ effort })} options={EFFORTS.filter((e) => e !== 'default').map((e) => ({ value: e, label: EFFORT_LABELS[e] }))} /></Field>
            <ErrorText error={save.error} />
          </>
        ) : (
          <p className="text-[14px]">{modelName(data.model)} at {data.effort} effort</p>
        ))}
      </div>
    </Section>
  );
}
