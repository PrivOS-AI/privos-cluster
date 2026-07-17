import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getStoredToken, onUnauthorized, setStoredToken } from './api';

export interface AuthUser {
    iss: string;
    sub: string;
}

interface AuthContextValue {
    user: AuthUser | null;
    token: string | null;
    loading: boolean;
    login: (username: string, password: string) => Promise<void>;
    logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [token, setToken] = useState<string | null>(() => getStoredToken());
    const [user, setUser] = useState<AuthUser | null>(null);
    const [loading, setLoading] = useState<boolean>(Boolean(getStoredToken()));

    const logout = useCallback(() => {
        setStoredToken(null);
        setToken(null);
        setUser(null);
    }, []);

    // Hook the api's 401 handler to logout — keeps the token jar in sync with
    // server-side expiry.
    useEffect(() => onUnauthorized(logout), [logout]);

    // On boot, if we have a token, hydrate /auth/me. On 401 the interceptor
    // above clears state, so we don't need to handle that here explicitly.
    useEffect(() => {
        if (!token) {
            setLoading(false);
            return;
        }
        setLoading(true);
        api.get<AuthUser>('/api/v1/auth/me')
            .then((res) => setUser(res.data))
            .catch(() => setUser(null))
            .finally(() => setLoading(false));
    }, [token]);

    const login = useCallback(async (username: string, password: string) => {
        const res = await api.post<{
            token: string;
            user: { username: string };
        }>(
            '/api/v1/auth/login',
            { username, password },
        );
        setStoredToken(res.data.token);
        setToken(res.data.token);
        setUser({ iss: 'privos-cluster-admin', sub: res.data.user.username });
        setLoading(false);
    }, []);

    const value = useMemo<AuthContextValue>(
        () => ({ user, token, loading, login, logout }),
        [user, token, loading, login, logout],
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
    return ctx;
}
