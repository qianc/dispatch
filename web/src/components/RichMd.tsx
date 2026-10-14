// Markdown for item/source text, with links that work inside the app:
//   #anchor        → the item whose title has that heading slug (backlog files link items this way)
//   relative path  → the in-app file viewer (repo default branch, or the source file's folder)
//   images         → served by the same file route
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, type Item, type Project } from '../api.ts';
import { cx } from './ui.tsx';
import { dirOf, joinPath, slug } from '../../../src/shared/paths.ts';

export { dirOf, joinPath, slug };

export interface LinkContext {
  project: Pick<Project, 'id' | 'key'>;
  sourceId?: number | null;
  /** folder of the document being shown, relative to the repo root ('' for item text) */
  baseDir?: string;
}

export const fileUrl = (ctx: LinkContext, path: string) =>
  `/api/projects/${ctx.project.key}/file?path=${encodeURIComponent(path)}${ctx.sourceId ? `&source=${ctx.sourceId}` : ''}`;
export const viewerUrl = (ctx: LinkContext, path: string) =>
  `/files/${ctx.project.key}?path=${encodeURIComponent(path)}${ctx.sourceId ? `&source=${ctx.sourceId}` : ''}`;

export function RichMd({ children, ctx, className }: { children: string; ctx: LinkContext; className?: string }) {
  const { data: items = [] } = useQuery({
    queryKey: ['items', ctx.project.id],
    queryFn: () => api.get<Item[]>(`/projects/${ctx.project.key}/items`),
    enabled: children.includes('](#'),
  });
  return (
    <div className={cx('md', className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href = '', children: c }) => {
            if (/^(https?:|mailto:)/.test(href)) return <a href={href} target="_blank" rel="noreferrer">{c}</a>;
            if (href.startsWith('/')) return <Link to={href}>{c}</Link>;
            if (href.startsWith('#')) {
              const target = items.find((i) => slug(i.title) === decodeURIComponent(href.slice(1)));
              return target ? <Link to={`/items/${target.id}`}>{c}</Link> : <span className="text-accent/70">{c}</span>;
            }
            const path = joinPath(ctx.baseDir ?? '', decodeURIComponent(href.split('#')[0]));
            return <Link to={viewerUrl(ctx, path)}>{c}</Link>;
          },
          img: ({ src = '', alt }) => {
            const s = String(src);
            const url = /^(https?:|data:|\/)/.test(s) ? s : fileUrl(ctx, joinPath(ctx.baseDir ?? '', s));
            return <img src={url} alt={alt ?? ''} className="max-w-full rounded-lg" loading="lazy" />;
          },
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
