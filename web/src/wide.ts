import { useSyncExternalStore } from 'react';

// Desktop layout (sidebar instead of the tab bar, item drawer) from this width up. Keep in step with
// the `lg` breakpoint and the media queries in styles.css.
const query = window.matchMedia('(min-width: 1024px)');

export function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      query.addEventListener('change', cb);
      return () => query.removeEventListener('change', cb);
    },
    () => query.matches,
  );
}
