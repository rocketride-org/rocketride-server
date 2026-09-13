import React, { useEffect, useRef, useState } from 'react';
import { Button, DetailPanel, ConfirmDialog } from 'shell';
import { Empty, Notice, Status, TextArea, TextField } from './controls';
import { importCases, pretty } from './spec';
import { downloadArtifact } from './api';
import type { EvaluationCase } from './types';

function TagsField({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }): React.ReactElement {
	const value = tags.join(', ');
	const [text, setText] = useState(value);
	const focused = useRef(false);
	useEffect(() => {
		if (!focused.current) setText(value);
	}, [value]);
	return (
		<TextField
			label="Tags"
			hint="Separate tags with commas."
			value={text}
			onFocus={() => {
				focused.current = true;
			}}
			onBlur={() => {
				focused.current = false;
				setText(value);
			}}
			onChange={(event) => {
				setText(event.target.value);
				onChange(
					event.target.value
						.split(',')
						.map((tag) => tag.trim())
						.filter(Boolean)
				);
			}}
		/>
	);
}

export default function CasesEditor({ cases, onChange, disabled, onImporting }: { cases: EvaluationCase[]; onChange: (cases: EvaluationCase[]) => void; disabled: boolean; onImporting: (pending: boolean) => void }): React.ReactElement {
	const [editing, setEditing] = useState<string | null>(null);
	const [search, setSearch] = useState('');
	const [error, setError] = useState('');
	const [importing, setImporting] = useState(false);
	const [removing, setRemoving] = useState<string | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const currentCases = useRef(cases);
	currentCases.current = cases;
	const changeCases = useRef(onChange);
	changeCases.current = onChange;
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const active = cases.find((item) => item.id === editing);
	const filtered = cases.filter((item) => `${item.name} ${item.id} ${(item.tags ?? []).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
	const patchCase = (patch: Partial<EvaluationCase>): void => {
		if (!active) return;
		onChange(cases.map((item) => (item.id === active.id ? { ...item, ...patch, ...(patch.input !== undefined || patch.reference !== undefined ? { approved: false } : {}) } : item)));
	};
	const importFile = async (file: File): Promise<void> => {
		if (disabled || importing) return;
		setError('');
		setImporting(true);
		onImporting(true);
		try {
			if (file.size > 5 * 1024 * 1024) throw new Error('Import files must be 5 MB or smaller.');
			const text = await file.text();
			const existing = currentCases.current;
			if (mounted.current) changeCases.current([...existing, ...importCases(text, file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'json', existing)]);
		} catch (reason) {
			if (mounted.current) setError(reason instanceof Error ? reason.message : 'Could not import cases.');
		} finally {
			if (mounted.current) {
				setImporting(false);
				onImporting(false);
			}
		}
	};
	return (
		<section className="rr-eval-section">
			<div className="rr-eval-section-heading">
				<div>
					<h3>
						Reviewed cases <span className="rr-eval-count">{cases.length}</span>
					</h3>
					<p>{cases.filter((item) => item.approved).length} reviewed · Review inputs and references before trusting a case.</p>
				</div>
				<div className="rr-eval-actions">
					<Button small variant="ghost" disabled={cases.length === 0} onClick={() => downloadArtifact('evaluation-cases.json', pretty(cases))}>
						Export cases JSON
					</Button>
					<Button small variant="ghost" disabled={disabled || importing} onClick={() => fileInput.current?.click()}>
						{importing ? 'Importing…' : 'Import JSON / CSV'}
					</Button>
					<Button
						small
						variant="secondary"
						disabled={disabled || importing}
						onClick={() => {
							const id = crypto.randomUUID();
							onChange([...cases, { id, name: `Case ${cases.length + 1}`, input: '', reference: '', approved: false, tags: [], provenance: { kind: 'manual' } }]);
							setEditing(id);
						}}
					>
						Add case
					</Button>
				</div>
			</div>
			<input
				ref={fileInput}
				type="file"
				accept=".json,.csv,application/json,text/csv"
				aria-label="Import evaluation cases"
				hidden
				onChange={(event) => {
					const file = event.target.files?.[0];
					event.target.value = '';
					if (file) void importFile(file);
				}}
			/>
			{error && <Notice error>{error}</Notice>}
			<details className="rr-eval-help">
				<summary>Import format and review rules</summary>
				<p>JSON: an array of cases with input and optional id, name, reference, tags, approved, provenance. CSV: id,name,input,reference,tags (semicolon-separated tags; quote multiline text). Existing IDs cannot be overwritten. All imported cases start unreviewed, even if the file says approved.</p>
			</details>
			{cases.length === 0 ? (
				<Empty title="Add your first reference case">Start with a real input and a reviewed expected answer. Empty cohorts cannot pass a gate.</Empty>
			) : (
				<>
					<TextField label="Find cases" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, case ID, or tag" />
					<div className="rr-eval-table-wrap">
						<table className="rr-eval-table">
							<caption className="rr-eval-sr-only">Evaluation reference cases</caption>
							<thead>
								<tr>
									<th scope="col">Case</th>
									<th scope="col">Input</th>
									<th scope="col">Reference</th>
									<th scope="col">Review</th>
								</tr>
							</thead>
							<tbody>
								{filtered.map((item) => (
									<tr key={item.id}>
										<th scope="row">
											<button className="rr-eval-link" onClick={() => setEditing(item.id)}>
												{item.name || 'Untitled case'}
											</button>
											<small>{(item.tags ?? []).join(' · ') || item.id}</small>
										</th>
										<td>
											<span className="rr-eval-preview">{item.input || 'Empty input'}</span>
										</td>
										<td>
											<span className="rr-eval-preview">{item.reference ?? 'No reference'}</span>
										</td>
										<td>
											<Status status={item.approved ? 'reviewed' : 'unreviewed'} />
										</td>
									</tr>
								))}
							</tbody>
						</table>
						{filtered.length === 0 && <Empty title="No matching cases">Try a different name, ID, or tag.</Empty>}
					</div>
				</>
			)}
			<DetailPanel
				open={Boolean(active)}
				onClose={() => setEditing(null)}
				title={active?.name || 'Edit case'}
				subtitle="Edits stay in your evaluation draft until you save a revision."
				contained
				width={580}
				minWidth={280}
				busy={disabled}
				footer={
					<div className="rr-eval-actions">
						<Button variant="danger" disabled={disabled} onClick={() => setRemoving(active?.id ?? null)}>
							Remove case
						</Button>
						<Button variant="secondary" onClick={() => setEditing(null)}>
							Done
						</Button>
					</div>
				}
			>
				{active && (
					<fieldset className="rr-eval-fields" disabled={disabled}>
						<TextField label="Case ID (stable)" value={active.id} readOnly />
						<TextField label="Case name" value={active.name} onChange={(event) => patchCase({ name: event.target.value })} />
						<TextArea label="Input sent to the pipeline" rows={5} value={active.input} onChange={(event) => patchCase({ input: event.target.value })} />
						<TextArea label="Expected reference" hint="Used by reference-based scorers. Never sent as target input." rows={5} value={active.reference ?? ''} onChange={(event) => patchCase({ reference: event.target.value })} />
						<TagsField key={active.id} tags={active.tags ?? []} onChange={(tags) => patchCase({ tags })} />
						<p className="rr-eval-muted">Provenance: {active.provenance?.kind ?? 'Not supplied'}. Editing input or reference requires another review.</p>
						{active.provenance && (
							<details>
								<summary>Recorded provenance</summary>
								<pre className="rr-eval-code-block">{pretty(active.provenance)}</pre>
								<p className="rr-eval-muted">Imported provenance is source metadata, not proof of reproducible execution. Trace examples need complete inputs and a fresh review.</p>
							</details>
						)}
						<label className="rr-eval-checkbox">
							<input type="checkbox" checked={active.approved} onChange={(event) => patchCase({ approved: event.target.checked })} />I reviewed this input and reference
						</label>
					</fieldset>
				)}
			</DetailPanel>
			{removing && (
				<ConfirmDialog
					title="Remove this case?"
					message="It will be removed from this draft. Saved revisions and previous run reports keep their evidence."
					confirmLabel="Remove case"
					destructive
					onConfirm={() => {
						onChange(cases.filter((item) => item.id !== removing));
						setRemoving(null);
						setEditing(null);
					}}
					onCancel={() => setRemoving(null)}
				/>
			)}
		</section>
	);
}
