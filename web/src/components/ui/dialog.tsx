import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: React.ReactNode;
	className?: string;
	size?: 'sm' | 'md' | 'lg' | 'xl';
}

const sizeClasses: Record<NonNullable<DialogProps['size']>, string> = {
	sm: 'max-w-md',
	md: 'max-w-lg',
	lg: 'max-w-2xl',
	xl: 'max-w-4xl',
};

/**
 * Lightweight modal. Click backdrop or press Escape to close.
 * Renders via portal to body so it escapes any parent overflow:hidden.
 */
export function Dialog({ open, onOpenChange, children, className, size = 'md' }: DialogProps) {
	useEffect(() => {
		if (!open) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') onOpenChange(false);
		}
		document.addEventListener('keydown', onKey);
		// Lock scroll while modal is open
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.removeEventListener('keydown', onKey);
			document.body.style.overflow = prevOverflow;
		};
	}, [open, onOpenChange]);

	if (!open) return null;

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-[8vh] backdrop-blur-sm animate-in fade-in"
			onClick={(e) => {
				// Click backdrop = close. Click inside panel does NOT close.
				if (e.target === e.currentTarget) onOpenChange(false);
			}}
		>
			<div
				className={cn(
					'relative w-full rounded-xl border bg-card shadow-2xl',
					sizeClasses[size],
					className,
				)}
				role="dialog"
				aria-modal="true"
			>
				<button
					type="button"
					onClick={() => onOpenChange(false)}
					className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					aria-label="Close"
				>
					<X className="h-4 w-4" />
				</button>
				{children}
			</div>
		</div>,
		document.body,
	);
}

export function DialogHeader({ children, className }: { children: React.ReactNode; className?: string }) {
	return <div className={cn('border-b px-6 py-4 pr-12', className)}>{children}</div>;
}

export function DialogTitle({ children, className }: { children: React.ReactNode; className?: string }) {
	return <h2 className={cn('text-lg font-semibold tracking-tight', className)}>{children}</h2>;
}

export function DialogDescription({ children, className }: { children: React.ReactNode; className?: string }) {
	return <p className={cn('mt-1 text-sm text-muted-foreground', className)}>{children}</p>;
}

export function DialogBody({ children, className }: { children: React.ReactNode; className?: string }) {
	return <div className={cn('max-h-[70vh] overflow-y-auto px-6 py-5', className)}>{children}</div>;
}
