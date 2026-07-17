import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AuthProvider } from '@/lib/auth-context';
import { ThemeProvider } from '@/components/theme-provider';
import { ProtectedRoute } from '@/components/protected-route';
import { AppShell } from '@/components/layout/app-shell';
import { LoginPage } from '@/routes/login';
import { DashboardPage } from '@/routes/dashboard';
import { ContainersPage } from '@/routes/containers';
import { ContainerDetailPage } from '@/routes/container-detail';
import { ImagesPage } from '@/routes/images';
import { ImageDetailPage } from '@/routes/image-detail';
import { SettingsPage } from '@/routes/settings';
import { CapabilitiesPage } from '@/routes/capabilities';

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			retry: 1,
			// Refresh data when user returns to the tab or focuses the window.
			refetchOnWindowFocus: true,
			// Always refetch when a component mounts (including after F5).
			// This guarantees the UI reflects the latest server state on reload.
			refetchOnMount: 'always',
			// Treat data as stale immediately so cached responses don't shadow
			// fresh fetches after invalidate/refresh.
			staleTime: 0,
		},
	},
});

export default function App() {
	return (
		<ThemeProvider>
			<QueryClientProvider client={queryClient}>
				<AuthProvider>
					<BrowserRouter>
						<Routes>
							<Route path="/login" element={<LoginPage />} />
							<Route
								element={
									<ProtectedRoute>
										<AppShell />
									</ProtectedRoute>
								}
							>
								<Route index element={<DashboardPage />} />
								<Route path="containers" element={<ContainersPage />} />
								<Route path="containers/:containerId" element={<ContainerDetailPage />} />
								<Route path="images" element={<ImagesPage />} />
								<Route path="images/:imageId" element={<ImageDetailPage />} />
								<Route path="capabilities" element={<CapabilitiesPage />} />
								<Route path="settings" element={<SettingsPage />} />
							</Route>
							<Route path="*" element={<Navigate to="/" replace />} />
						</Routes>
						<Toaster richColors position="top-right" />
					</BrowserRouter>
				</AuthProvider>
			</QueryClientProvider>
		</ThemeProvider>
	);
}
