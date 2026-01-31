import streamDeck, { action, KeyDownEvent, KeyUpEvent, SingletonAction, WillAppearEvent, DidReceiveSettingsEvent } from "@elgato/streamdeck";
import fs from "node:fs";
import path from "node:path";
import { decodeToPCM } from "../audio/decoder";
import os from "node:os";
import { spawn } from "node:child_process";

// Stream Deck button is 72x72 px (standard); use that for drawing.
const BUTTON_SIZE = 72;

// Constants
const BUTTON_TITLES = {
	PLAY: "Play",
	PLAYING: "▶",
	NO_FILE: "No File",
	MISSING: "Missing",
	DECODING: "Decoding",
	ERROR: "Error",
} as const;

const LOG_PREFIX = "[PlayAudio]";
const IS_MACOS = os.platform() === "darwin";
const AFPLAY_PATH = "/usr/bin/afplay";
const PLUGIN_FOLDER = "com.github.andr3van.theracue.sdPlugin";

type SetTitleFn = (title: string) => Promise<void> | void;

// Simple debounce for title updates (except timer which is per-second & immediate)
function createTitleDebouncer(fn: SetTitleFn, delay = 120): SetTitleFn {
	let t: NodeJS.Timeout | undefined;
	let last: string | undefined;
	return (title: string) => {
		if (last === title) return; // avoid redundant updates
		last = title;
		if (t) clearTimeout(t);
		t = setTimeout(() => { fn(title); }, delay);
	};
}

/**
 * Settings for PlayAudioAction.
 */
interface PlayAudioSettings {
	filePath?: string; // any audio format (decoded via ffmpeg)
	playMode?: "play-stop" | "play-once" | "play-while-pressed";
	stopMode?: "fade" | "immediate";
	fadeMode?: "none" | "separate" | "both"; // UI fade mode selection
	fadeInSeconds?: number;
	fadeOutSeconds?: number;
	volumePercent?: number;
	autoStopOnKeyUp?: boolean; // legacy support
	[key: string]: string | number | boolean | null | undefined | (string | number | boolean | null)[];
}

/**
 * Runtime state for a playing instance.
 */
interface PlaybackContext {
	startTime: number;
	stopping: boolean;
	fadeOutStart?: number;
	speaker?: any; // lazy-loaded speaker instance
	volume: number;
	fadeInMs: number;
	fadeOutMs: number;
	mode: ResolvedSettings["playMode"];
	stopMode: ResolvedSettings["stopMode"];
	childStream?: NodeJS.ReadableStream;
	ffmpegProc?: ReturnType<typeof spawn>; // ffmpeg child process for cleanup
	afplayProc?: ReturnType<typeof spawn>;
	timerInterval?: NodeJS.Timeout; // Timer for updating button display
	action?: any; // The action instance that initiated this playback
	setTitle?: SetTitleFn; // Function to update button title
	setTitleImmediate?: SetTitleFn; // Non-debounced (used by timer)
	finished?: boolean; // True once playback fully cleaned up
}

@action({ UUID: "com.github.andr3van.theracue.playaudio" })
export class PlayAudioAction extends SingletonAction<PlayAudioSettings> {
	// Map of action.id -> PlaybackContext for independent per-button playback
	private playbackContexts: Map<string, PlaybackContext> = new Map();

	override onWillAppear(ev: WillAppearEvent<PlayAudioSettings>): void | Promise<void> {
		const settings = applyDefaults(ev.payload.settings);
		streamDeck.logger.info(`${LOG_PREFIX} onWillAppear context=${ev.action.id} settings=${JSON.stringify(ev.payload.settings)}`);
		return this.updateButtonTitle(ev.action, settings);
	}

	override onWillDisappear(ev: any): void {
		const actionId = ev.action.id;
		streamDeck.logger.info(`${LOG_PREFIX} onWillDisappear context=${actionId}`);
		// Clean up any active playback for this button
		const ctx = this.playbackContexts.get(actionId);
		if (ctx && !ctx.finished) {
			streamDeck.logger.info(`${LOG_PREFIX} Cleaning up active playback for disappeared button ${actionId}`);
			this.finishPlayback(actionId, "");
		}
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<PlayAudioSettings>): void | Promise<void> {
		const settings = applyDefaults(ev.payload.settings);
		streamDeck.logger.info(`${LOG_PREFIX} onDidReceiveSettings context=${ev.action.id} settings=${JSON.stringify(ev.payload.settings)}`);
		return this.updateButtonTitle(ev.action, settings);
	}

	/**
	 * Updates the button title based on settings.
	 */
	private updateButtonTitle(action: any, settings: ResolvedSettings): void | Promise<void> {
		const title = deriveTitleFromPath(settings.filePath) || "";
		return action.setTitle(title);
	}

/* Key down behavior depends on playMode */
	override async onKeyDown(ev: KeyDownEvent<PlayAudioSettings>): Promise<void> {
		const settings = applyDefaults(ev.payload.settings);
		const actionId = ev.action.id;
		streamDeck.logger.info(`${LOG_PREFIX} onKeyDown context=${actionId}`);
		
		if (!settings.filePath) {
			await ev.action.setTitle(BUTTON_TITLES.NO_FILE);
			return;
		}

		// Get this button's playback context
		const ctx = this.playbackContexts.get(actionId);

		switch (settings.playMode) {
			case "play-stop": {
				if (ctx && !ctx.finished) {
					this.stopPlayback(actionId, settings);
					await this.updateButtonTitle(ev.action, settings);
				} else {
					// Don't set title here - let startPlayback handle it (timer or PLAYING)
					this.startPlayback(actionId, settings, ev.action);
				}
				break;
			}
			case "play-once": {
				if (!ctx || ctx.finished) {
					// Don't set title here - let startPlayback handle it (timer or PLAYING)
					this.startPlayback(actionId, settings, ev.action);
				}
				break;
			}
			case "play-while-pressed": {
				if (!ctx || ctx.finished) {
					// Don't set title here - let startPlayback handle it (timer or PLAYING)
					this.startPlayback(actionId, settings, ev.action);
				}
				break;
			}
		}
	}

	override async onKeyUp(ev: KeyUpEvent<PlayAudioSettings>): Promise<void> {
		const settings = applyDefaults(ev.payload.settings);
		const actionId = ev.action.id;
		const ctx = this.playbackContexts.get(actionId);
		
		if (settings.playMode === "play-while-pressed" && ctx && !ctx.finished) {
			this.stopPlayback(actionId, settings);
			await this.updateButtonTitle(ev.action, settings);
		}
	}

	private async startPlayback(actionId: string, settings: ResolvedSettings, action: any) {
		if (!action) {
			streamDeck.logger.error(`${LOG_PREFIX} No action reference available`);
			return;
		}
		
		const attemptedPaths = resolveCandidatePaths(settings.filePath!);
		let resolved: string | undefined;
		for (const p of attemptedPaths) {
			if (fs.existsSync(p)) {
				resolved = p;
				break;
			}
		}
		if (!resolved) {
			streamDeck.logger.warn(`${LOG_PREFIX} File not found after attempts: ${attemptedPaths.join(" | ")}`);
			await action.setTitle(BUTTON_TITLES.MISSING);
			return;
		}
		streamDeck.logger.info(`${LOG_PREFIX} [${actionId}] Starting playback path='${resolved}' mode=${settings.playMode} stopMode=${settings.stopMode} fadeIn=${settings.fadeInSeconds}s fadeOut=${settings.fadeOutSeconds}s volume=${settings.volumePercent}%`);
		
		// Check if fades or volume control are needed
		const needsFade = settings.fadeInSeconds > 0 || settings.fadeOutSeconds > 0;
		const needsVolumeControl = settings.volumePercent !== 100;
		
		// On macOS, use afplay only if no fades or volume control are needed
		// afplay doesn't support fades or volume control
		if (IS_MACOS && !needsFade && !needsVolumeControl) {
			return this.startAfplayPlayback(actionId, resolved, settings, action);
		}
		
		// Use speaker module for fade support or other platforms
		return this.startSpeakerPlayback(actionId, resolved, settings, action);
	}

	/**
	 * Start playback using macOS afplay (no fade support).
	 */
	private startAfplayPlayback(actionId: string, filePath: string, settings: ResolvedSettings, action: any): void {
		streamDeck.logger.info(`${LOG_PREFIX} [${actionId}] Using afplay for '${filePath}'`);
		
		const proc = spawn(AFPLAY_PATH, [filePath]);
		const rawSetTitle = action.setTitle.bind(action);
		const ctx: PlaybackContext = {
			startTime: Date.now(),
			stopping: false,
			finished: false,
			volume: settings.volumePercent / 100,
			fadeInMs: settings.fadeInSeconds * 1000,
			fadeOutMs: settings.fadeOutSeconds * 1000,
			mode: settings.playMode,
			stopMode: settings.stopMode,
			afplayProc: proc,
			action: action,
			setTitle: createTitleDebouncer(rawSetTitle),
			setTitleImmediate: rawSetTitle
		};
		this.playbackContexts.set(actionId, ctx);
		
		// afplay doesn't support fades, so show playing indicator with green circle
		this.renderPlayingIndicator(action);
		
		proc.on("close", (code, signal) => { 
			streamDeck.logger.info(`${LOG_PREFIX} [${actionId}] afplay close code=${code} signal=${signal}`); 
			this.finishPlayback(actionId, ""); 
		});
		proc.on("error", err => { 
			streamDeck.logger.error(`${LOG_PREFIX} [${actionId}] afplay error ${(err as Error).message}`); 
			this.finishPlayback(actionId, BUTTON_TITLES.ERROR); 
		});
	}

	/**
	 * Start playback using speaker module with ffmpeg decoding (supports fades).
	 */
	private async startSpeakerPlayback(actionId: string, filePath: string, settings: ResolvedSettings, action: any): Promise<void> {
		try {
			await action.setTitle(BUTTON_TITLES.DECODING);
			let SpeakerMod: any;
			try {
				SpeakerMod = (await import("speaker"))?.default;
			} catch (e) {
				streamDeck.logger.warn(`${LOG_PREFIX} speaker import failed (${(e as Error).message})`);
			}
			if (!SpeakerMod) {
				streamDeck.logger.error(`${LOG_PREFIX} No audio backend available`);
				await action.setTitle(BUTTON_TITLES.ERROR);
				return;
			}
			
			const decoded = await decodeToPCM(filePath, {
				onStderr: l => {
					const lower = l.toLowerCase();
					const benign = lower.includes('broken pipe') || lower.includes('error muxing a packet') || lower.includes('error writing trailer') || lower.includes('error closing file');
					if (lower.includes('error') && !benign) {
						streamDeck.logger.error(`[ffmpeg] ${l}`);
					} else if (benign) {
						// These occur when we intentionally terminate ffmpeg early (e.g., user stops with fade)
						streamDeck.logger.debug(`[ffmpeg][expected-after-stop] ${l}`);
					} else {
						streamDeck.logger.debug(`[ffmpeg] ${l}`);
					}
				}
			});
			streamDeck.logger.info(`${LOG_PREFIX} [${actionId}] ffmpeg decoding started '${filePath}' sr=${decoded.format.sampleRate}`);
			const speaker = new SpeakerMod({ channels: decoded.format.channels, sampleRate: decoded.format.sampleRate, bitDepth: decoded.format.bitDepth });
			const rawSetTitle = action.setTitle.bind(action);
			const ctx: PlaybackContext = {
				startTime: Date.now(),
				stopping: false,
				finished: false,
				speaker,
				volume: settings.volumePercent / 100,
				fadeInMs: settings.fadeInSeconds * 1000,
				fadeOutMs: settings.fadeOutSeconds * 1000,
				mode: settings.playMode,
				stopMode: settings.stopMode,
				childStream: decoded.stream,
				ffmpegProc: decoded.ffmpegProcess, // Store ffmpeg process for cleanup
				action: action,
				setTitle: createTitleDebouncer(rawSetTitle),
				setTitleImmediate: rawSetTitle
			};
			this.playbackContexts.set(actionId, ctx);
			
			// Start timer display if fade in is enabled, otherwise show playing indicator
			if (settings.fadeInSeconds > 0) {
				this.startFadeTimer(actionId, ctx, 'in');
			} else {
				this.renderPlayingIndicator(action);
			}

			let total = 0;
			decoded.stream.on("data", (chunk: Buffer) => {
				// If playback context has changed (stopped) or finished, ignore further data
				const currentCtx = this.playbackContexts.get(actionId);
				if (!currentCtx || currentCtx !== ctx || ctx.finished) return;
				total += chunk.length;
				if (total < 32768) streamDeck.logger.debug(`${LOG_PREFIX} [${actionId}] first-chunk bytes=${chunk.length}`);
				const continueWriting = this.applyGainAndFades(actionId, ctx, chunk);
				// If fade logic finished playback, skip writing the (now irrelevant) chunk
				if (!continueWriting) return;
				// Extra guard: speaker may have been ended asynchronously
				if (!ctx.speaker || ctx.speaker.writableEnded) return;
				const ok = ctx.speaker.write(chunk);
				if (!ok) { decoded.stream.pause(); }
			});
			speaker.on("drain", () => decoded.stream.resume());
			decoded.stream.on("end", () => {
				streamDeck.logger.info(`${LOG_PREFIX} [${actionId}] playback complete totalBytes=${total}`);
				this.finishPlayback(actionId);
			});
			decoded.stream.on("error", (err) => {
				streamDeck.logger.error(`${LOG_PREFIX} [${actionId}] stream error ${(err as Error).message}`);
				this.finishPlayback(actionId, BUTTON_TITLES.ERROR);
			});
		} catch (e) {
			streamDeck.logger.error(`${LOG_PREFIX} [${actionId}] decode/start error ${(e as Error).stack}`);
			await action.setTitle(BUTTON_TITLES.ERROR);
		}
	}

	private stopPlayback(actionId: string, settings: ResolvedSettings) {
		const ctx = this.playbackContexts.get(actionId);
		if (!ctx) return;
		if (ctx.stopping) return;
		
		streamDeck.logger.info(`${LOG_PREFIX} [${actionId}] Stopping playback stopMode=${ctx.stopMode} fadeOutMs=${ctx.fadeOutMs}`);
		ctx.stopping = true;
		
		// Clear fade in timer if it's running
		if (ctx.timerInterval) {
			clearInterval(ctx.timerInterval);
			ctx.timerInterval = undefined;
		}
		
		// For afplay, we can only do immediate stop (no fade support)
		if (ctx.afplayProc) {
			streamDeck.logger.info(`${LOG_PREFIX} [${actionId}] Killing afplay process`);
			ctx.afplayProc.kill("SIGTERM");
			this.playbackContexts.delete(actionId);
			// Restore button to default state (clear image, set title to blank or filename)
			if (ctx.action) {
				ctx.action.setImage('');
				ctx.action.setTitle("");
			}
			return;
		}
		
		// For speaker-based playback, handle immediate or fade stop
		if (ctx.stopMode === "immediate" || ctx.fadeOutMs === 0) {
			streamDeck.logger.info(`${LOG_PREFIX} [${actionId}] Immediate stop`);
			// Proper cleanup order: stop source before destination
			// First kill ffmpeg process
			if (ctx.ffmpegProc) {
				ctx.ffmpegProc.kill("SIGTERM");
			}
			// Then unpipe and pause the stream
			if (ctx.childStream) {
				ctx.childStream.unpipe();
				ctx.childStream.pause();
				ctx.childStream.removeAllListeners();
			}
			// Then close the speaker (destination)
			if (ctx.speaker) {
				ctx.speaker.removeAllListeners();
				ctx.speaker.end?.();
			}
			// Finally destroy the stream
			if (ctx.childStream) {
				(ctx.childStream as any).destroy?.();
			}
			this.playbackContexts.delete(actionId);
			// Restore button to default state (clear image, set title to blank or filename)
			if (ctx.action) {
				ctx.action.setImage('');
				ctx.action.setTitle("");
			}
		} else {
			streamDeck.logger.info(`${LOG_PREFIX} [${actionId}] Starting fade out fadeOutMs=${ctx.fadeOutMs}`);
			// Start fade out timer (this will immediately show the countdown)
			this.startFadeTimer(actionId, ctx, 'out');
		}
		// Fade stop will be handled in applyGainAndFades
	}

	/**
	 * Applies gain and fade effects to an audio chunk (PCM 16-bit LE).
	 * Note: Only works with speaker backend, not afplay.
	 */
	private applyGainAndFades(actionId: string, ctx: PlaybackContext, chunk: Buffer): boolean {
		if (ctx.afplayProc) return true; // fallback path: no gain processing
		const now = Date.now();
		const elapsed = now - ctx.startTime;
		let baseGain = ctx.volume;
		
		// Apply fade in with smooth exponential curve (equal-power)
		if (!ctx.stopping && ctx.fadeInMs > 0 && elapsed < ctx.fadeInMs) {
			const fadeInProgress = elapsed / ctx.fadeInMs;
			// Exponential curve: converts linear progress to smooth audio fade
			// Using -60dB range (0.001 to 1.0) for professional fade
			const dbRange = 60;
			const minGain = Math.pow(10, -dbRange / 20); // -60dB
			baseGain *= minGain + (1 - minGain) * Math.pow(fadeInProgress, 2);
		}
		
		// Apply fade out
		if (ctx.stopping && ctx.stopMode === "fade" && ctx.fadeOutMs > 0) {
			ctx.fadeOutStart ??= now;
			const fadeElapsed = now - ctx.fadeOutStart;
			
				// Check if fade is complete
			if (fadeElapsed >= ctx.fadeOutMs) {
				streamDeck.logger.info(`${LOG_PREFIX} [${actionId}] Fade out finished`);
				// Clear timer
				if (ctx.timerInterval) {
					clearInterval(ctx.timerInterval);
					ctx.timerInterval = undefined;
				}
				// Update button title before clearing playback (will show filename or blank)
				ctx.setTitle?.("");
				ctx.finished = true;				// Proper cleanup order: stop source before destination
				// First kill ffmpeg process to stop producing data
				if (ctx.ffmpegProc) {
					ctx.ffmpegProc.kill("SIGTERM");
				}
				// Then unpipe and pause the stream
				if (ctx.childStream) {
					ctx.childStream.unpipe();
					ctx.childStream.pause();
					ctx.childStream.removeAllListeners();
				}
				// Then close the speaker (destination)
				if (ctx.speaker) {
					ctx.speaker.removeAllListeners();
					ctx.speaker.end?.();
				}
				// Finally destroy the stream
				if (ctx.childStream) {
					(ctx.childStream as any).destroy?.();
				}
				this.playbackContexts.delete(actionId);
				return false; // signal caller to stop writing
			}
			
			// Apply smooth fade out with exponential curve (equal-power)
			const fadeOutProgress = fadeElapsed / ctx.fadeOutMs;
			const fadeOutRemaining = 1 - fadeOutProgress;
			// Exponential curve for fade out: smooth from 1.0 to -60dB
			const dbRange = 60;
			const minGain = Math.pow(10, -dbRange / 20); // -60dB
			baseGain *= minGain + (1 - minGain) * Math.pow(fadeOutRemaining, 2);
		}
		
		// Apply gain to samples (16-bit LE, stereo interleaved)
		// Apply per-sample for smoothest possible fade
		for (let i = 0; i < chunk.length; i += 2) {
			let sample = chunk.readInt16LE(i);
			sample = Math.max(-32768, Math.min(32767, Math.round(sample * baseGain)));
			chunk.writeInt16LE(sample, i);
		}
		return true; // continue writing
	}

	/**
	 * Start a timer to update the button display during fade in or fade out
	 */
	private startFadeTimer(actionId: string, ctx: PlaybackContext, direction: 'in' | 'out'): void {
		if (!ctx.setTitle) {
			streamDeck.logger.warn(`${LOG_PREFIX} [${actionId}] No setTitle function available for timer`);
			return;
		}
		
		const fadeMs = direction === 'in' ? ctx.fadeInMs : ctx.fadeOutMs;
		const fadeSeconds = Math.round(fadeMs / 1000);
		
		streamDeck.logger.info(`${LOG_PREFIX} [${actionId}] Starting ${direction} timer for ${fadeSeconds}s`);
		
		if (fadeSeconds === 0) return;
		
		// Clear any existing timer
		if (ctx.timerInterval) {
			clearInterval(ctx.timerInterval);
		}
		
		// For fade out, set the start time now
		if (direction === 'out') {
			ctx.fadeOutStart = Date.now();
		}
		
		// Update timer display function
		const updateDisplay = () => {
			const currentCtx = this.playbackContexts.get(actionId);
			if (!currentCtx || currentCtx !== ctx) {
				// Playback stopped, clear timer
				if (ctx.timerInterval) {
					clearInterval(ctx.timerInterval);
					ctx.timerInterval = undefined;
				}
				return;
			}
			
			const now = Date.now();
			let elapsed: number;
			let remaining: number;
			
			if (direction === 'in') {
				// Fade in: count up from 0 to N seconds
				elapsed = Math.floor((now - ctx.startTime) / 1000);
				if (elapsed >= fadeSeconds) {
					// Fade in complete, stop timer and show playing indicator
					streamDeck.logger.info(`${LOG_PREFIX} [${actionId}] Fade in timer complete`);
					if (ctx.timerInterval) {
						clearInterval(ctx.timerInterval);
						ctx.timerInterval = undefined;
					}
					if (ctx.action) {
						this.renderPlayingIndicator(ctx.action);
					}
					return;
				}
				// Show elapsed time counting UP: 0s, 1s, 2s, ..., Ns
				this.renderCircularTimer(ctx, elapsed / fadeSeconds, direction, `${elapsed}s`);
			} else {
				// Fade out: count down from N to 0
				if (!ctx.fadeOutStart) {
					ctx.fadeOutStart = now;
				}
				elapsed = Math.floor((now - ctx.fadeOutStart) / 1000);
				remaining = Math.max(0, fadeSeconds - elapsed);
				
				if (remaining === 0) {
					// Fade out complete, show final state and restore
					streamDeck.logger.info(`${LOG_PREFIX} [${actionId}] Fade out timer complete`);
					if (ctx.timerInterval) {
						clearInterval(ctx.timerInterval);
						ctx.timerInterval = undefined;
					}
					// Show complete circle before restoring
					this.renderCircularTimer(ctx, 1, direction, '0s').then(() => {
						// Restore to initial state after a brief moment (blank or filename)
						setTimeout(() => {
							if (ctx.action) {
								ctx.action.setImage('');
								ctx.action.setTitle("");
							}
						}, 300);
					}).catch(() => {
						// Fallback if render fails
						if (ctx.action) {
							ctx.action.setImage('');
							ctx.action.setTitle("");
						}
					});
					return;
				}
				this.renderCircularTimer(ctx, 1 - (remaining / fadeSeconds), direction, `${remaining}s`);
			}
		};
		
		// Show initial timer immediately
		updateDisplay();
		
		// Update timer every second
		ctx.timerInterval = setInterval(updateDisplay, 1000);
	}

	private finishPlayback(actionId: string, title: string = "") {
		streamDeck.logger.info(`${LOG_PREFIX} [${actionId}] Finishing playback`);
		const ctx = this.playbackContexts.get(actionId);
		if (!ctx) return;
		
		// Clear timer if running
		if (ctx.timerInterval) {
			clearInterval(ctx.timerInterval);
			ctx.timerInterval = undefined;
		}
		const actionToUpdate = ctx.action;
		ctx.finished = true;
		
		// Kill ffmpeg process first
		if (ctx.ffmpegProc) {
			ctx.ffmpegProc.kill("SIGTERM");
		}
		if (ctx.childStream) {
			ctx.childStream.unpipe();
			ctx.childStream.removeAllListeners();
			(ctx.childStream as any).destroy?.();
		}
		if (ctx.speaker) {
			ctx.speaker.removeAllListeners();
			ctx.speaker.end?.();
		}
		if (ctx.afplayProc) {
			ctx.afplayProc.kill("SIGTERM");
		}
		this.playbackContexts.delete(actionId);
		
		// Restore button to default state (clear image and set title)
		if (actionToUpdate) {
			actionToUpdate.setImage('');
			actionToUpdate.setTitle(title);
		}
	}

	/**
	 * Render a green circular indicator with play icon to show active playback
	 */
	private async renderPlayingIndicator(action: any) {
		try {
			const center = BUTTON_SIZE / 2;
			const radius = 18;
			const strokeWidth = 3;
			
			// Create SVG with full green circle
			const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${BUTTON_SIZE}" height="${BUTTON_SIZE}" xmlns="http://www.w3.org/2000/svg">
  <!-- Background -->
  <rect width="${BUTTON_SIZE}" height="${BUTTON_SIZE}" fill="#000000" opacity="0.4"/>
  
  <!-- Green circle (full) -->
  <circle cx="${center}" cy="${center}" r="${radius}" 
          fill="none" stroke="#4CAF50" stroke-width="${strokeWidth}"/>
  
  <!-- Inner circle -->
  <circle cx="${center}" cy="${center}" r="${radius - strokeWidth - 1}" 
          fill="#000000" opacity="0.7"/>
  
  <!-- Play icon -->
  <text x="${center}" y="${center + 5}" 
        font-family="Arial, sans-serif" font-size="15" font-weight="bold"
        fill="#FFFFFF" text-anchor="middle" dominant-baseline="middle">
    ▶
  </text>
</svg>`;
			
			// Convert SVG to base64 data URL
			const svgBase64 = Buffer.from(svg).toString('base64');
			const dataUrl = `data:image/svg+xml;base64,${svgBase64}`;
			
			await action.setTitle('');
			await action.setImage(dataUrl);
		} catch (e) {
			streamDeck.logger.error(`${LOG_PREFIX} renderPlayingIndicator error: ${(e as Error).message}`);
		}
	}

	/**
	 * Render circular progress image and push to the specific action that initiated playback
	 * progress 0..1
	 * Uses SVG to avoid native module dependencies
	 */
	private async renderCircularTimer(ctx: PlaybackContext, progress: number, direction: 'in' | 'out', label: string) {
		try {
			// Render ONLY to the action that initiated playback
			const action = ctx.action;
			if (!action) {
				streamDeck.logger.warn(`${LOG_PREFIX} No action reference available for timer rendering`);
				return;
			}
			
		streamDeck.logger.debug(`${LOG_PREFIX} Rendering timer to action ${action.id}`);
		
		const center = BUTTON_SIZE / 2;
		const radius = 18; // Match the playing indicator size
		const strokeWidth = 3;
		const progressColor = direction === 'in' ? '#4CAF50' : '#FF5252';
		const text = label.replace(/s$/, '');			// Calculate arc path for progress
			// Progress goes from top (12 o'clock) clockwise
			const progressAngle = Math.min(1, Math.max(0, progress)) * 360;
			const largeArcFlag = progressAngle > 180 ? 1 : 0;
			
			// Convert angle to coordinates (starting at top, going clockwise)
			const endAngleRad = (progressAngle - 90) * Math.PI / 180;
			const endX = center + radius * Math.cos(endAngleRad);
			const endY = center + radius * Math.sin(endAngleRad);
			
		// Create SVG with circular progress
		const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${BUTTON_SIZE}" height="${BUTTON_SIZE}" xmlns="http://www.w3.org/2000/svg">
  <!-- Background -->
  <rect width="${BUTTON_SIZE}" height="${BUTTON_SIZE}" fill="#000000" opacity="0.4"/>
  
  <!-- Background ring -->
  <circle cx="${center}" cy="${center}" r="${radius}" 
          fill="none" stroke="#333333" stroke-width="${strokeWidth}"/>
  
  ${progressAngle > 0 ? `
  <!-- Progress arc -->
  <path d="M ${center} ${center - radius}
           A ${radius} ${radius} 0 ${largeArcFlag} 1 ${endX} ${endY}"
        fill="none" stroke="${progressColor}" stroke-width="${strokeWidth}" stroke-linecap="round"/>
  ` : ''}
  
  <!-- Inner circle -->
  <circle cx="${center}" cy="${center}" r="${radius - strokeWidth - 1}" 
          fill="#000000" opacity="0.7"/>
  
  <!-- Text label -->
  <text x="${center}" y="${center + 5}" 
        font-family="Arial, sans-serif" font-size="15" font-weight="bold"
        fill="#FFFFFF" text-anchor="middle" dominant-baseline="middle">
    ${text}
  </text>
</svg>`;			// Convert SVG to base64 data URL
			const svgBase64 = Buffer.from(svg).toString('base64');
			const dataUrl = `data:image/svg+xml;base64,${svgBase64}`;
			
			streamDeck.logger.debug(`${LOG_PREFIX} renderCircularTimer svg size=${svg.length} progress=${progress.toFixed(2)} dir=${direction} label='${label}'`);
			
			// Send only to the action that initiated playback
			try {
				await action.setTitle(''); // Clear title first
				await action.setImage(dataUrl);
			} catch (e) {
				streamDeck.logger.error(`${LOG_PREFIX} Failed to update action ${action.id}: ${(e as Error).message}`);
			}
		} catch (e) {
			streamDeck.logger.error(`${LOG_PREFIX} renderCircularTimer error: ${(e as Error).message}`);
			streamDeck.logger.debug(`${LOG_PREFIX} renderCircularTimer stack: ${(e as Error).stack}`);
		}
	}
}

type ResolvedSettings = Required<Pick<PlayAudioSettings, "filePath" | "fadeInSeconds" | "fadeOutSeconds" | "playMode" | "stopMode" | "volumePercent">>;

function applyDefaults(s: PlayAudioSettings): ResolvedSettings {
	// Legacy conversion
	const legacyPlayWhilePressed = s.autoStopOnKeyUp ? "play-while-pressed" : undefined;
	
	// Decode the file path if it's URL-encoded
	let filePath = s.filePath ?? "";
	if (filePath && filePath.includes('%')) {
		try {
			const decoded = decodeURIComponent(filePath);
			filePath = decoded; // Use decoded version
		} catch (e) {
			// Keep original if decode fails
			streamDeck.logger.warn(`${LOG_PREFIX} Failed to decode filePath, using as-is: ${filePath}`);
		}
	}
	
	// Default to no fade for new buttons
	const fadeInSeconds = clampNumber(s.fadeInSeconds, 0, 30, 0);
	const fadeOutSeconds = clampNumber(s.fadeOutSeconds, 0, 30, 0);
	
	// Use explicit stopMode from settings, defaulting to "immediate" if no fades
	const stopMode = (s.stopMode as ResolvedSettings["stopMode"]) || (fadeOutSeconds > 0 ? "fade" : "immediate");
	
	return {
		filePath,
		fadeInSeconds,
		fadeOutSeconds,
		playMode: (s.playMode as ResolvedSettings["playMode"]) || legacyPlayWhilePressed || "play-stop",
		stopMode,
		volumePercent: clampNumber(s.volumePercent, 0, 100, 75)
	};
}

function clampNumber(v: number | undefined, min: number, max: number, d: number): number {
	if (typeof v !== "number" || Number.isNaN(v)) return d;
	return Math.min(max, Math.max(min, v));
}

/**
 * Resolves a file path to an absolute path, trying multiple candidate locations.
 * Tries: absolute path, relative to cwd, relative to plugin folder.
 */
function resolveCandidatePaths(p: string): string[] {
	if (!p) return [];
	const out: string[] = [];
	if (path.isAbsolute(p)) {
		out.push(p);
	} else {
		// Try relative to working dir (plugin root) and .sdPlugin folder
		out.push(path.join(process.cwd(), p));
		out.push(path.join(process.cwd(), PLUGIN_FOLDER, p));
	}
	return [...new Set(out)];
}

/**
 * Derives a button title from a file path by extracting the filename without extension.
 */
function deriveTitleFromPath(p?: string): string {
	if (!p) return "";
	return path.basename(p).replace(/\.[^.]+$/, "");
}
