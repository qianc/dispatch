// Markdown for item/source text, with links that work inside the app:
//   #anchor        → the item whose title has that heading slug (backlog files link items this way)
//   relative path  → the in-app file viewer (repo default branch, or the source file's folder)
//   images         → served by the same file route; one from another host shows as a link (DISP-144)
import Markdown, { defaultUrlTransform, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api, type Item, type Project } from '../api.ts';
import { cx, inAppHref, MdImage } from './ui.tsx';
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

/**
 * react-markdown empties every `data:` URL. An image may have one, for the bitmap types only (not
 * SVG, which can carry script); a link never does (DISP-104).
 */
export const urlTransform: UrlTransform = (url, key, node) =>
  node.tagName === 'img' && key === 'src' && /^data:image\/(png|jpeg|gif|webp)[;,]/i.test(url) ? url : defaultUrlTransform(url);

/** decodeURIComponent, or the text as it is when it has a bad escape like `%zz` (DISP-223). */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** An `#anchor` link: the item it names is looked up when it is clicked, not with the whole list (DISP-247). */
function AnchorLink({ project, anchor, children }: { project: LinkContext['project']; anchor: string; children: ReactNode }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [missing, setMissing] = useState(false);
  if (missing) return <span className="text-accent/70">{children}</span>;
  const open = async (e: MouseEvent) => {
    e.preventDefault();
    const [target] = await qc.fetchQuery({
      queryKey: ['anchor', project.id, anchor],
      queryFn: () => api.get<Item[]>(`/projects/${project.key}/items?slug=${encodeURIComponent(anchor)}`),
    });
    if (target) void nav(`/items/${target.id}`);
    else setMissing(true);
  };
  return <a href={`#${anchor}`} onClick={(e) => open(e).catch(() => undefined)}>{children}</a>;
}

export function RichMd({ children, ctx, className }: { children: string; ctx: LinkContext; className?: string }) {
  return (
    <div className={cx('md', className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={{
          a: ({ href = '', children: c }) => {
            if (/^(https?:|mailto:|[\\/]{2})/.test(href)) return <a href={href} target="_blank" rel="noreferrer">{c}</a>;
            if (inAppHref(href)) return <Link to={href}>{c}</Link>;
            if (href.startsWith('#')) return <AnchorLink project={ctx.project} anchor={safeDecode(href.slice(1))}>{c}</AnchorLink>;
            const path = joinPath(ctx.baseDir ?? '', safeDecode(href.split('#')[0]));
            return <Link to={viewerUrl(ctx, path)}>{c}</Link>;
          },
          img: ({ src = '', alt }) => {
            const s = String(src);
            const url = /^(https?:|data:|\/)/.test(s) ? s : fileUrl(ctx, joinPath(ctx.baseDir ?? '', s));
            return <MdImage src={url} alt={alt} />;
          },
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
