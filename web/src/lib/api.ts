import axios, { type AxiosError } from 'axios';

const TOKEN_STORAGE_KEY = 'privos-cluster.token';

// In dev we go through the Vite proxy at /api; in prod the SPA is served by
// the cluster itself, so /api is same-origin. Either way, '' as baseURL works.
export const api = axios.create({
    baseURL: import.meta.env.VITE_API_URL ?? '',
    timeout: 15_000,
});

api.interceptors.request.use((config) => {
    const token = getStoredToken();
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

// Subscribers that the auth context registers — we don't import the context
// here to avoid a cycle (api.ts is imported by auth-context.tsx).
type UnauthorizedHandler = () => void;
let unauthorizedHandlers: UnauthorizedHandler[] = [];

export function onUnauthorized(handler: UnauthorizedHandler): () => void {
    unauthorizedHandlers.push(handler);
    return () => {
        unauthorizedHandlers = unauthorizedHandlers.filter((h) => h !== handler);
    };
}

api.interceptors.response.use(
    (res) => res,
    (err: AxiosError) => {
        if (err.response?.status === 401) {
            for (const h of unauthorizedHandlers) h();
        }
        return Promise.reject(err);
    },
);

export function getStoredToken(): string | null {
    try {
        return localStorage.getItem(TOKEN_STORAGE_KEY);
    } catch {
        return null;
    }
}

export function setStoredToken(token: string | null): void {
    try {
        if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
        else localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
        // ignore storage errors (private mode etc)
    }
}

/**
 * Surface backend error envelopes ({error, reason, details}) as a single line
 * when the caller just wants to toast a message.
 */
export function errorMessage(err: unknown): string {
    if (axios.isAxiosError(err)) {
        const body = err.response?.data as { error?: string; reason?: string } | undefined;
        return body?.error
            ? body.reason
                ? `${body.error}: ${body.reason}`
                : body.error
            : err.message;
    }
    if (err instanceof Error) return err.message;
    return String(err);
}
