// Minimal ambient declarations for packages without bundled types.
declare module "speaker" {
	import { Writable } from "node:stream";
	interface SpeakerOptions {
		channels?: number;
		bitDepth?: number;
		sampleRate?: number;
		float?: boolean;
		signed?: boolean;
		endian?: string;
	}
	export default class Speaker extends Writable {
		constructor(opts: SpeakerOptions);
	}
}

declare module "wav" {
	import { Transform } from "node:stream";
	class Reader extends Transform {
		on(event: "format", listener: (format: any) => void): this;
		on(event: "data", listener: (chunk: Buffer) => void): this;
	}
	export { Reader };
	const _default: { Reader: typeof Reader };
	export default _default;
}
