import { useCallback, useEffect, useRef, useState } from 'react';

export interface IRecordedAudio {
	audioBase64: string;
	mimeType?: string;
}

export interface IPushToTalkRecorder {
	isStarting: boolean;
	isRecording: boolean;
	error: string | null;
	start: () => Promise<void>;
	stop: () => Promise<IRecordedAudio | null>;
	resetError: () => void;
}

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

function getRecorderMimeType(): string | undefined {
	if (typeof MediaRecorder === 'undefined') return undefined;
	return MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

async function blobToBase64(blob: Blob): Promise<string> {
	const buffer = await blob.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	let binary = '';
	const chunkSize = 0x8000;

	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}

	return window.btoa(binary);
}

function normalizeRecordingError(error: unknown): string {
	const name = error instanceof DOMException ? error.name : '';
	if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone permission denied';
	if (name === 'NotFoundError') return 'No microphone found';
	if (error instanceof Error) return error.message;
	return 'Could not start microphone recording';
}

export function usePushToTalkRecorder(): IPushToTalkRecorder {
	const [isStarting, setIsStarting] = useState(false);
	const [isRecording, setIsRecording] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const chunksRef = useRef<Blob[]>([]);

	const cleanup = useCallback(() => {
		recorderRef.current = null;
		streamRef.current?.getTracks().forEach((track) => track.stop());
		streamRef.current = null;
		setIsStarting(false);
		setIsRecording(false);
	}, []);

	useEffect(() => cleanup, [cleanup]);

	const start = useCallback(async () => {
		setError(null);
		if (!navigator.mediaDevices?.getUserMedia) {
			setError('Microphone recording is not available in this webview');
			return;
		}
		if (typeof MediaRecorder === 'undefined') {
			setError('MediaRecorder is not available in this webview');
			return;
		}
		if (recorderRef.current?.state === 'recording') return;

		setIsStarting(true);
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
				},
			});
			const mimeType = getRecorderMimeType();
			const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
			chunksRef.current = [];
			streamRef.current = stream;
			recorderRef.current = recorder;

			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunksRef.current.push(event.data);
			};
			recorder.start();
			setIsRecording(true);
		} catch (err) {
			cleanup();
			setError(normalizeRecordingError(err));
		} finally {
			setIsStarting(false);
		}
	}, [cleanup]);

	const stop = useCallback(async (): Promise<IRecordedAudio | null> => {
		const recorder = recorderRef.current;
		if (!recorder || recorder.state === 'inactive') {
			cleanup();
			return null;
		}

		const stopped = new Promise<void>((resolve) => {
			recorder.onstop = () => resolve();
		});
		recorder.stop();
		await stopped;

		const mimeType = recorder.mimeType || undefined;
		cleanup();

		const blob = new Blob(chunksRef.current, { type: mimeType });
		chunksRef.current = [];
		if (blob.size === 0) return null;

		return {
			audioBase64: await blobToBase64(blob),
			mimeType,
		};
	}, [cleanup]);

	return {
		isStarting,
		isRecording,
		error,
		start,
		stop,
		resetError: () => setError(null),
	};
}
