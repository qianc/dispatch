import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { PROJECT_COLORS, defaultProjectColor, type ProjectColor, type ProjectIcon } from '../../../src/shared/projectLook.ts';
import { api, type ProjectSummary } from '../api.ts';
import { cx } from './ui.tsx';

// Outline icons on the 24px grid, drawn like the menu's (round joins and ends, text colour).
export const PROJECT_ICON_PATHS: Record<ProjectIcon, string> = {
  slides: 'M4 4h16v11H4zM12 15v5M8 20h8M8 8h8M8 11h5',
  desktop: 'M3 5h18v11H3zM9 20h6M12 16v4',
  phone: 'M7 2.5h10v19H7zM11 18h2',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3.5 9h17M3.5 15h17M12 3c-3 3.5-3 14.5 0 18M12 3c3 3.5 3 14.5 0 18',
  code: 'M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14',
  chart: 'M4 20V11M10 20V5M16 20v-8M3 20h18',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  book: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5zM5 19.5A1.5 1.5 0 0 0 6.5 21H19',
  home: 'M3 11l9-7 9 7M5 9.5V20h14V9.5M10 20v-6h4v6',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  flask: 'M9 3h6M10 3v6L4.5 19A1.3 1.3 0 0 0 5.6 21h12.8a1.3 1.3 0 0 0 1.1-2L14 9V3M7 15h10',
  wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5l3 3 5.8-5.8a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
  briefcase: 'M3 7h18v13H3zM8 7V4h8v3M3 12.5h18',
  camera: 'M3 6.5h4l1.5-2h7l1.5 2h4v12H3zM12 9a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  leaf: 'M5 19C5 10 10.5 4.5 20 4c-.5 9.5-6 15-15 15zM5 19l8-8',
  star: 'M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.3L12 17.5l-5.5 2.9 1-6.3L3 9.7l6.2-.9z',
  heart: 'M12 20s-8-4.9-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 9c0 6.1-8 11-8 11z',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z',
};

type Look = Pick<ProjectSummary, 'key' | 'color' | 'icon'>;

export const lookColor = (p: Look) => PROJECT_COLORS[(p.color as ProjectColor) ?? defaultProjectColor(p.key)] ?? PROJECT_COLORS[defaultProjectColor(p.key)];

/** The project's colour and icon in a small tinted square (its key's first letter if no icon is set). */
export function ProjectBadge({ project, size = 24, className }: { project: Look; size?: number; className?: string }) {
  const color = lookColor(project);
  const path = project.icon ? PROJECT_ICON_PATHS[project.icon as ProjectIcon] : null;
  return (
    <span
      className={cx('inline-flex items-center justify-center shrink-0 rounded-md font-bold', className)}
      style={{ width: size, height: size, color, background: `color-mix(in srgb, ${color} 16%, transparent)`, fontSize: size * 0.5 }}
      aria-hidden="true"
    >
      {path ? (
        <svg width={size * 0.66} height={size * 0.66} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" strokeLinecap="round"><path d={path} /></svg>
      ) : project.key.charAt(0)}
    </span>
  );
}

/** Projects by key, from the shared project list query, for colouring keys anywhere. */
export function useProjectLooks() {
  const { data = [] } = useQuery({ queryKey: ['projects'], queryFn: () => api.get<ProjectSummary[]>('/projects') });
  return new Map(data.map((p) => [p.key, p] as const));
}

/** A project key in its project's colour, with its badge when `badge` is set. */
export function ProjectKey({ k, badge, className }: { k: string | null | undefined; badge?: boolean; className?: string }): ReactNode {
  const looks = useProjectLooks();
  if (!k) return null;
  const p = looks.get(k) ?? { key: k, color: null, icon: null };
  return (
    <span className={cx('inline-flex items-center gap-1.5 shrink-0 text-[12px] font-semibold', className)} style={{ color: lookColor(p) }}>
      {badge && <ProjectBadge project={p} size={18} />}
      {k}
    </span>
  );
}
