import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import json from "@rollup/plugin-json";
import path from "node:path";
import url from "node:url";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "com.github.andr3van.theracue.sdPlugin";

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
	input: "src/plugin.ts",
	output: {
	    file: `${sdPlugin}/bin/plugin.js`,
	    inlineDynamicImports: true,
	    format: "cjs",
	    exports: "auto",
	    sourcemap: isWatching,
	    sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
		    return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
	    }
	},
	external: ["speaker"], // Exclude native modules from bundle (loaded dynamically at runtime)
	plugins: [
		{
			name: "watch-externals",
			buildStart: function () {
				this.addWatchFile(`${sdPlugin}/manifest.json`);
			},
		},
		typescript({
			mapRoot: isWatching ? "./" : undefined
		}),
		nodeResolve({
			browser: false,
			exportConditions: ["node"],
			preferBuiltins: true
		}),
		commonjs(),
		json(),
		!isWatching && terser(),
		{
			name: "emit-package-file",
			generateBundle() {
				// Override root package.json "type": "module" for runtime inside the .sdPlugin bundle
				this.emitFile({ fileName: "package.json", source: `{ "type": "commonjs" }`, type: "asset" });
			}
		}
	]
};

export default config;
