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
  terminal: 'M3 5h18v14H3zM7 10l3 2.5L7 15M12.5 15H17',
  cpu: 'M6 6h12v12H6zM9.5 9.5h5v5h-5zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3',
  bug: 'M8 9a4 4 0 0 1 8 0v6a4 4 0 0 1-8 0zM9.5 5.5L7.5 3.5M14.5 5.5l2-2M8 10.5H4M8 15H4M16 10.5h4M16 15h4M12 11v8',
  folder: 'M3 6h6l2 2.5h10V19H3z',
  cloud: 'M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 11a3.75 3.75 0 0 1-.5 7.5z',
  rocket: 'M12 3c3 2.5 4.5 6 4.5 9.5V16h-9v-3.5C7.5 9 9 5.5 12 3zM7.5 13L5 16v3l2.5-1.5M16.5 13l2.5 3v3l-2.5-1.5M10 20h4M12 8.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  cart: 'M3 4h2.5l2.2 10.5h10L20 7.5H6.3M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM17 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  tag: 'M3 3h8.5l9.5 9.5-8.5 8.5L3 11.5zM7.5 7.5h.01',
  bell: 'M6 17v-6a6 6 0 0 1 12 0v6l1.5 2h-15zM10 21.5h4',
  calendar: 'M4 6h16v14H4zM4 10.5h16M8 3.5v4M16 3.5v4',
  mail: 'M3 6h18v12H3zM3 7l9 6.5L21 7',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.9c2.1.8 3.5 2.6 3.5 5.1',
  lock: 'M5 11h14v9.5H5zM8 11V7.5a4 4 0 0 1 8 0V11',
  key: 'M8 11a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM10.8 12.2L20 3M17 6l2.5 2.5M14.5 8.5l2 2',
  map: 'M3 6l6-2.5 6 2.5 6-2.5V18l-6 2.5-6-2.5-6 2.5zM9 3.5V18M15 6v14.5',
  compass: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15.5 8.5l-2 5-5 2 2-5z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z',
  flag: 'M5 21V4M5 4.5h13l-2.5 4.25L18 13H5',
  gift: 'M4 9h16v4H4zM5.5 13v7.5h13V13M12 9v11.5M12 9C10 9 7.5 8 7.5 6a2 2 0 0 1 4-.5zM12 9c2 0 4.5-1 4.5-3a2 2 0 0 0-4-.5z',
  gamepad: 'M7 7h10a5 5 0 0 1 0 10H7A5 5 0 0 1 7 7zM6.5 12h4M8.5 10v4M15 13.5h.01M17.5 10.5h.01',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 8a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  pencil: 'M4 20l1-4.5L16.5 4 20 7.5 8.5 19zM14 6.5l3.5 3.5',
  coffee: 'M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM17 10h1.5a2.5 2.5 0 0 1 0 5H17M8 3v3M12 3v3',
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
