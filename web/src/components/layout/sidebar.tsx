import { NavLink } from 'react-router-dom';
import { Boxes, Container, LayoutDashboard, Settings, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavItem {
    to: string;
    label: string;
    icon: typeof LayoutDashboard;
}

const NAV: NavItem[] = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/containers', label: 'Containers', icon: Container },
    { to: '/images', label: 'Images', icon: Boxes },
    { to: '/capabilities', label: 'Capabilities', icon: Sparkles },
    { to: '/settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
    return (
        <aside className="hidden w-60 shrink-0 border-r bg-card md:flex md:flex-col">
            <div className="flex h-14 items-center gap-2 border-b px-4">
                <img
                    src="/logo.png"
                    alt="PrivOS Cluster"
                    className="h-8 w-8 rounded-md object-contain"
                />
                <div className="text-sm font-semibold">PrivOS Cluster</div>
            </div>
            <nav className="flex-1 space-y-1 p-3 text-sm">
                {NAV.map(({ to, label, icon: Icon }) => (
                    <NavLink
                        key={to}
                        to={to}
                        end={to === '/'}
                        className={({ isActive }) =>
                            cn(
                                'flex items-center gap-3 rounded-md px-3 py-2 transition-colors',
                                isActive
                                    ? 'bg-accent text-accent-foreground'
                                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                            )
                        }
                    >
                        <Icon className="h-4 w-4" />
                        <span>{label}</span>
                    </NavLink>
                ))}
            </nav>
            <div className="border-t p-3 text-xs text-muted-foreground">
                v0.1.0 · {new Date().getFullYear()}
            </div>
        </aside>
    );
}

