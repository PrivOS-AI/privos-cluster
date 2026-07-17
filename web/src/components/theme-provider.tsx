import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'system';

interface ThemeContextValue {
    theme: Theme;
    setTheme: (theme: Theme) => void;
    resolved: 'light' | 'dark';
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = 'privos-cluster.theme';

function readStored(): Theme {
    try {
        const v = localStorage.getItem(STORAGE_KEY) as Theme | null;
        if (v === 'light' || v === 'dark' || v === 'system') return v;
    } catch {
        // ignore
    }
    return 'system';
}

function resolveTheme(theme: Theme): 'light' | 'dark' {
    if (theme !== 'system') return theme;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [theme, setThemeState] = useState<Theme>(() => readStored());
    const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(readStored()));

    useEffect(() => {
        const next = resolveTheme(theme);
        setResolved(next);
        const root = document.documentElement;
        root.classList.remove('light', 'dark');
        root.classList.add(next);
    }, [theme]);

    // Listen to system pref changes only while in 'system' mode.
    useEffect(() => {
        if (theme !== 'system') return;
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = () => setResolved(mq.matches ? 'dark' : 'light');
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, [theme]);

    const setTheme = (t: Theme) => {
        try {
            localStorage.setItem(STORAGE_KEY, t);
        } catch {
            // ignore
        }
        setThemeState(t);
    };

    return (
        <ThemeContext.Provider value={{ theme, setTheme, resolved }}>{children}</ThemeContext.Provider>
    );
}

export function useTheme(): ThemeContextValue {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
    return ctx;
}
