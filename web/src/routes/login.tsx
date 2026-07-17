import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth-context';
import { errorMessage } from '@/lib/api';

const LoginSchema = z.object({
    username: z.string().min(1, 'username required'),
    password: z.string().min(1, 'password required'),
});

type LoginValues = z.infer<typeof LoginSchema>;

export function LoginPage() {
    const navigate = useNavigate();
    const location = useLocation();
    const { login, user, loading } = useAuth();
    const [submitting, setSubmitting] = useState(false);

    const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/';

    // If we already have a session (e.g. user hit /login with a valid token),
    // bounce them straight to where they came from.
    useEffect(() => {
        if (!loading && user) navigate(from, { replace: true });
    }, [loading, user, from, navigate]);

    const {
        register,
        handleSubmit,
        formState: { errors },
    } = useForm<LoginValues>({
        resolver: zodResolver(LoginSchema),
        defaultValues: { username: 'admin', password: '' },
    });

    const onSubmit = async (values: LoginValues) => {
        setSubmitting(true);
        try {
            await login(values.username, values.password);
            navigate(from, { replace: true });
        } catch (err) {
            toast.error(errorMessage(err));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="text-center">
                    <img
                        src="/logo.png"
                        alt="PrivOS Cluster"
                        className="mx-auto mb-2 h-14 w-14 rounded-md object-contain"
                    />
                    <CardTitle>PrivOS Cluster</CardTitle>
                    <CardDescription>Sign in to PrivOS Cluster Management System</CardDescription>
                </CardHeader>
                <CardContent>
                    <form className="space-y-4" onSubmit={handleSubmit(onSubmit)}>
                        <div className="space-y-2">
                            <Label htmlFor="username">Username</Label>
                            <Input
                                id="username"
                                autoComplete="username"
                                {...register('username')}
                            />
                            {errors.username && (
                                <p className="text-xs text-destructive">{errors.username.message}</p>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="password">Password</Label>
                            <Input
                                id="password"
                                type="password"
                                autoComplete="current-password"
                                {...register('password')}
                            />
                            {errors.password && (
                                <p className="text-xs text-destructive">{errors.password.message}</p>
                            )}
                        </div>
                        <Button type="submit" className="w-full" disabled={submitting}>
                            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                            Sign in
                        </Button>
                    </form>
                </CardContent>
            </Card>
        </div>
    );
}
