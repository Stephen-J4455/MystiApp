import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

/**
 * Lets individual screens temporarily hide the bottom dock (e.g. a detail view
 * that wants full screen height) without the dock being re-implemented per
 * screen. Mirrors the admin app's DockVisibilityContext.
 */
const DockVisibilityContext = createContext({
  dockVisible: true,
  setDockVisible: () => {},
});

export function DockVisibilityProvider({ children }) {
  const [dockVisible, setDockVisible] = useState(true);

  const value = useMemo(() => ({ dockVisible, setDockVisible }), [dockVisible]);

  return (
    <DockVisibilityContext.Provider value={value}>
      {children}
    </DockVisibilityContext.Provider>
  );
}

export function useDockVisibility() {
  return useContext(DockVisibilityContext);
}

/**
 * Convenience hook: hides the dock while `isFocused` and restores it on blur.
 * Returns a ref-spreadable props object so a screen can do:
 *
 *   const dockProps = useHideDockWhileFocused(isFocused);
 *   <View {...dockProps}>
 */
export function useHideDockWhileFocused(isFocused) {
  const { setDockVisible } = useDockVisibility();

  const hide = useCallback(() => setDockVisible(false), [setDockVisible]);
  const show = useCallback(() => setDockVisible(true), [setDockVisible]);

  return useMemo(
    () => (isFocused ? { onFocus: hide, onBlur: show } : null),
    [isFocused, hide, show],
  );
}

export default DockVisibilityContext;
