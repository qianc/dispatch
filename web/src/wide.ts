import { useSyncExternalStore } from 'react';

// Desktop layout (sidebar instead of the tab bar, item drawer) from this width up. Keep in step with
// the `lg` breakpoint and the media queries in styles.css.
function useMedia(query: MediaQueryList): boolean {
  return useSyncExternalStore(
    (cb) => {
      query.addEventListener('change', cb);
      return () => query.removeEventListener('change', cb);
    },
    () => query.matches,
  );
}

const wide = window.matchMedia('(min-width: 1024px)');
/** Room for three columns: list, item and chat side by side. */
const veryWide = window.matchMedia('(min-width: 1280px)');

export const useWide = () => useMedia(wide);
export const useVeryWide = () => useMedia(veryWide);
