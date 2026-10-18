import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';
import type { WorkerRecord } from '../../src/shared/types.ts';

export type WorkerRow = WorkerRecord & { connected: boolean };

export const useWorkers = () =>
  useQuery({ queryKey: ['workers'], queryFn: () => api.get<{ workers: WorkerRow[]; default_worker_id: number }>('/workers'), staleTime: 15_000 });

export const workerName = (workers: WorkerRow[] | undefined, id: number | null | undefined) => workers?.find((w) => w.id === id)?.name ?? (id ? `#${id}` : 'default');
