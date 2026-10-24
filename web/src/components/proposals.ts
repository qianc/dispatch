import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
 * The items picked on a batch card, kept in the browser so an untick survives a reload and the
 * Inbox's Start button starts what the card shows (DISP-38).
 */
export function useCardPicks(sessionId: number, eventId: number, proposed: number[]) {
  const key = `dispatch:card:${sessionId}:${eventId}`;
  const [picked, setPicked] = useState<Set<number>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
      if (Array.isArray(saved)) return new Set(proposed.filter((id) => saved.includes(id)));
    } catch { /* a bad entry: start from the card */ }
    return new Set(proposed);
  });
  const update = (next: Set<number>) => {
    setPicked(next);
    localStorage.setItem(key, JSON.stringify([...next]));
  };
  return [picked, update] as const;
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
