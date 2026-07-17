import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth-context';

export function ProtectedRoute({ children }: { children: ReactNode }) {
    const { user, loading, token } = useAuth();
    const location = useLocation();

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
                Checking session…
            </div>
        );
    }

    if (!token || !user) {
        // Preserve the user's intended destination so we can route back after login.
        return <Navigate to="/login" state={{ from: location }} replace />;
    }

    return <>{children}</>;
}
