import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface AppState {
  projectId: string | null;
  setProjectId: (id: string | null) => void;
  theme: 'g10' | 'g100';
  toggleTheme: () => void;
}

const AppStateContext = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [projectId, setProjectIdState] = useState<string | null>(() => localStorage.getItem('agentforge.projectId') || null);
  const [theme, setTheme] = useState<'g10' | 'g100'>(() => (localStorage.getItem('agentforge.theme') as 'g10' | 'g100') || 'g100');

  const setProjectId = useCallback((id: string | null) => {
    setProjectIdState(id);
    if (id) localStorage.setItem('agentforge.projectId', id);
    else localStorage.removeItem('agentforge.projectId');
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === 'g100' ? 'g10' : 'g100';
      localStorage.setItem('agentforge.theme', next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ projectId, setProjectId, theme, toggleTheme }), [projectId, setProjectId, theme, toggleTheme]);
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppState {
  const state = useContext(AppStateContext);
  if (!state) throw new Error('useAppState outside provider');
  return state;
}
