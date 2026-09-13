import React, { useId } from 'react';
import { InputField, commonStyles } from 'shell';

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactElement }): React.ReactElement {
	const id = useId();
	return (
		<div className="rr-eval-field">
			<label htmlFor={id}>{label}</label>
			{React.cloneElement(children, { id, 'aria-describedby': hint ? `${id}-hint` : undefined })}
			{hint && (
				<span className="rr-eval-muted" id={`${id}-hint`}>
					{hint}
				</span>
			)}
		</div>
	);
}
export function TextField(props: React.ComponentProps<typeof InputField> & { label: string; hint?: string }): React.ReactElement {
	const { label, hint, ...input } = props;
	return (
		<Field label={label} hint={hint}>
			<InputField {...input} style={{ width: '100%', minWidth: 0, ...input.style }} />
		</Field>
	);
}
export function SelectField({ label, hint, children, ...select }: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string }): React.ReactElement {
	return (
		<Field label={label} hint={hint}>
			<select {...select} style={{ ...commonStyles.inputField, width: '100%', height: 34 }}>
				{children}
			</select>
		</Field>
	);
}
export function TextArea({ label, hint, ...input }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }): React.ReactElement {
	return (
		<Field label={label} hint={hint}>
			<textarea {...input} className={`rr-eval-textarea ${input.className ?? ''}`} />
		</Field>
	);
}
export function Status({ status }: { status: string }): React.ReactElement {
	return <span className={`rr-eval-status rr-eval-status-${status}`}>{status}</span>;
}
export function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }): React.ReactElement {
	return (
		<div className={`rr-eval-notice${error ? ' rr-eval-notice-error' : ''}`} role={error ? 'alert' : 'status'}>
			{children}
		</div>
	);
}
export function Empty({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
	return (
		<div className="rr-eval-empty" style={{ ...commonStyles.empty, flexDirection: 'column' }}>
			<h3>{title}</h3>
			<p>{children}</p>
		</div>
	);
}
export const dateLabel = (value: string): string => {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};
export const durationLabel = (value: number | undefined): string => (value == null || !Number.isFinite(value) ? 'Unavailable' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`);
