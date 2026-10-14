import { useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, type ProjectSummary } from '../api.ts';
import { Page } from '../components/Layout.tsx';
import { RichMd, dirOf, fileUrl, type LinkContext } from '../components/RichMd.tsx';
import { Empty, ErrorText } from '../components/ui.tsx';

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

/** A file linked from item text: markdown rendered, images shown, other text as-is. */
export function FileView() {
  const { key = '' } = useParams();
  const [params] = useSearchParams();
  const path = params.get('path') ?? '';
  const sourceId = params.get('source') ? Number(params.get('source')) : null;
  const { data: project } = useQuery({ queryKey: ['project', key], queryFn: () => api.get<ProjectSummary>(`/projects/${key}`) });
  const ctx: LinkContext | null = project ? { project, sourceId, baseDir: dirOf(path) } : null;
  const isImage = IMAGE.test(path);
  const { data: text, error, isLoading } = useQuery({
    queryKey: ['file', key, path, sourceId],
    enabled: !!ctx && !isImage,
    queryFn: async () => {
      const res = await fetch(fileUrl(ctx!, path), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
      return res.text();
    },
  });
  const name = path.split('/').pop() ?? path;
  return (
    <Page title={name} subtitle={path} back>
      {!ctx || isLoading ? <Empty>Loading…</Empty> : null}
      <div className="px-4 pt-3">
        <ErrorText error={error} />
        {ctx && isImage && <img src={fileUrl(ctx, path)} alt={name} className="max-w-full rounded-lg" />}
        {ctx && text !== undefined && (/\.(md|markdown)$/i.test(path)
          ? <RichMd ctx={ctx}>{text}</RichMd>
          : <pre className="text-[12px] font-mono whitespace-pre-wrap break-words">{text}</pre>)}
      </div>
    </Page>
  );
}
