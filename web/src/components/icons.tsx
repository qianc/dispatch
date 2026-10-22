import type { ReactNode } from 'react';

// Outline icons in one style: 24px grid, round joins and ends, drawn in the text colour.
export const icons = {
  inbox: <path d="M3 13h4l2 3h6l2-3h4M5 4h14l2 9v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" />,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  projects: <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />,
  assistant: <path d="M4 4h16v12H9l-5 4zM8 8.5h8M8 11.5h5" />,
  settings: <path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm8 3-2-.6-.6-1.5 1-1.9-1.4-1.4-1.9 1-1.5-.6L13 4h-2l-.6 2-1.5.6-1.9-1L5.6 7l1 1.9L6 10.4 4 11v2l2 .6.6 1.5-1 1.9L7 18.4l1.9-1 1.5.6.6 2h2l.6-2 1.5-.6 1.9 1 1.4-1.4-1-1.9.6-1.5 2-.6z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  /** two speech bubbles: a conversation about something (Discuss, planning chats) */
  discuss: <path d="M3 4.5h12v8H8l-3.5 3v-3H3zM15 8.5h6v8h-1.5v3l-3.5-3h-5v-4" />,
};

export function Icon({ name, size = 18, strokeWidth = 1.7, className }: { name: keyof typeof icons; size?: number; strokeWidth?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" className={className ?? 'shrink-0'} aria-hidden="true">
      {icons[name] as ReactNode}
    </svg>
  );
}
