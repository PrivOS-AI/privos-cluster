import { LogOut, Moon, Sun, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { useTheme } from '@/components/theme-provider';

export function Topbar() {
    const { user, logout } = useAuth();
    const { theme, setTheme } = useTheme();

    const cycleTheme = () => {
        const next = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
        setTheme(next);
    };

    const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

    return (
        <header className="flex h-14 items-center justify-between gap-4 border-b bg-card px-4 md:px-6">
            <div className="text-sm font-medium text-muted-foreground">
                {user ? `Signed in as ${user.sub}` : 'Not signed in'}
            </div>
            <div className="flex items-center gap-1">
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={cycleTheme}
                    title={`Theme: ${theme}`}
                    aria-label="Toggle theme"
                >
                    <ThemeIcon className="h-4 w-4" />
                </Button>
                {user && (
                    <Button variant="ghost" size="sm" onClick={logout}>
                        <LogOut className="h-4 w-4" />
                        <span className="hidden md:inline">Logout</span>
                    </Button>
                )}
            </div>
        </header>
    );
}
