import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { ProposedItem, RunOptions } from '../../../src/shared/types.ts';
import { api, type Item, type Session } from '../api.ts';

export interface BatchStart {
  title: string;
  item_ids: number[];
  new_items: ProposedItem[];
  prompt: string;
  force_plan: boolean;
  options: RunOptions;
}

/**
 * What you can do with a proposal card: start the batch, create the items, or dismiss it. Used by
 * the card in the chat and by the planning chat's card in the Inbox. Starting opens the new session;
 * the server closes a planning chat once none of its cards is left open.
 */
export function useProposalActions({ sessionId, eventId, project, onChange }: { sessionId: number; eventId: number; project?: { id: number; key: string }; onChange?: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['session', sessionId] });
    qc.invalidateQueries({ queryKey: ['inbox'] });
    qc.invalidateQueries({ queryKey: ['sessions'] });
    if (project) qc.invalidateQueries({ queryKey: ['items', project.id] });
    onChange?.();
  };
  const proposal = { session_id: sessionId, event_id: eventId };
  const start = useMutation({
    mutationFn: (b: BatchStart) => api.post<Session>(`/projects/${project!.key}/batches`, { ...b, proposal }),
    onSuccess: (s) => {
      refresh();
      nav(`/s/${s.id}`);
    },
  });
  const create = useMutation({
    mutationFn: (b: { items: ProposedItem[]; source_id: number | null }) => api.post<Item[]>(`/sessions/${sessionId}/accept-items`, { ...b, event_id: eventId }),
    onSuccess: refresh,
  });
  const dismiss = useMutation({ mutationFn: () => api.post(`/sessions/${sessionId}/dismiss-proposal`, { event_id: eventId }), onSuccess: refresh });
  return { start, create, dismiss, busy: start.isPending || create.isPending || dismiss.isPending, error: start.error ?? create.error ?? dismiss.error };
}
