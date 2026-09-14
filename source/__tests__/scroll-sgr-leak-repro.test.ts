import {EventEmitter} from "node:events";
import {createElement as h} from "react";
import {describe, it, expect} from "vitest";
import render from "../ink/render.js";
import Text from "../ink/components/Text.js";
import useInput from "../ink/hooks/use-input.js";

// Reproduces the macOS "11MMMMMM" gibberish: a scroll-wheel flood of SGR mouse
// reports gets split across read boundaries while the event loop is busy (the
// "agav hangs then emits crazy characters" symptom). The tails of split SGR
// reports collapse to bare `digitM` / `M` fragments and leak into the prompt.

type FakeStdout = NodeJS.WriteStream & {chunks: string[]};

const makeStdout = (): FakeStdout => {
	const emitter = new EventEmitter() as unknown as FakeStdout;
	emitter.chunks = [];
	emitter.isTTY = true;
	emitter.columns = 120;
	emitter.rows = 30;
	emitter.write = ((data: string) => {
		emitter.chunks.push(data);
		return true;
	}) as FakeStdout["write"];
	return emitter;
};

const makeStdin = (): NodeJS.ReadStream => {
	const emitter = new EventEmitter() as unknown as NodeJS.ReadStream;
	emitter.isTTY = true;
	emitter.setRawMode = (() => emitter) as NodeJS.ReadStream["setRawMode"];
	emitter.resume = (() => emitter) as NodeJS.ReadStream["resume"];
	emitter.pause = (() => emitter) as NodeJS.ReadStream["pause"];
	emitter.read = (() => null) as NodeJS.ReadStream["read"];
	emitter.setEncoding = (() => emitter) as NodeJS.ReadStream["setEncoding"];
	return emitter;
};

const captured: string[] = [];
const Capture = () => {
	useInput((input: string) => {
		captured.push(input);
	});
	return h(Text, null, "capture");
};

const mount = () => {
	const stdout = makeStdout();
	const stdin = makeStdin();
	const instance = render(h(Capture), {
		stdout,
		stdin,
		patchConsole: false,
		exitOnCtrlC: false,
	});
	return {stdout, stdin, instance};
};

// A wheel-up SGR report: button 64, at col 11, row 5.
const sgr = (col: number, row: number) => `\x1b[<64;${col};${row}M`;

describe("ink layer drops split SGR wheel reports (11MMMMMM gibberish)", () => {
	it("does not leak tails when a flood is split mid-sequence", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// Build a flood of concatenated reports, then split it at arbitrary
		// byte offsets — exactly what a busy event loop does under a scroll.
		let flood = "";
		for (let i = 0; i < 8; i++) flood += sgr(11, 5 + i);

		// Split every 7 bytes so boundaries fall inside the `;col;rowM` tails.
		for (let i = 0; i < flood.length; i += 7) {
			stdin.emit("data", flood.slice(i, i + 7));
		}
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("");
		instance.unmount();
	});

	it("does not leak when the escape timer flushes between reads (hang)", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// One report split so the leading \x1b lands alone at a read end, then
		// wait past the 50ms escape timer AND the 150ms mouse-burst window so
		// the tail arrives "cold" — the hang scenario.
		const report = sgr(11, 5);
		const splitAt = report.indexOf("<") + 4; // mid-body
		stdin.emit("data", report.slice(0, 1)); // lone ESC
		await new Promise(r => setTimeout(r, 220));
		stdin.emit("data", report.slice(1)); // "[<64;11;5M" headless
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("");
		void splitAt;
		instance.unmount();
	});

	it("stays quiet as a hung flood drains rapidly (11MMMMMM)", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// The hang symptom: the event loop was blocked while the terminal
		// flooded scroll reports, so wall-clock time passed but no reads were
		// processed. When the loop unblocks, the piled-up reads drain back to
		// back — a full report, then a stream of collapsed tails and lone
		// terminators. That is the exact `11MMMMMM` the user sees.
		stdin.emit("data", sgr(11, 5)); // full report -> starts the flood
		stdin.emit("data", "11M");
		stdin.emit("data", "M");
		stdin.emit("data", "M");
		stdin.emit("data", "M");
		stdin.emit("data", "M");
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("");
		instance.unmount();
	});

	it("drops lone M/m terminators while a flood is in flight", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// A lone `M`/`m` chunk is the SGR terminator of a report whose whole
		// body was consumed at a prior read boundary. During a flood it is
		// never user input and must be dropped even if a little wall-clock
		// time passed between the drained reads.
		stdin.emit("data", sgr(11, 5));
		await new Promise(r => setTimeout(r, 60));
		stdin.emit("data", "M");
		await new Promise(r => setTimeout(r, 60));
		stdin.emit("data", "m");
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("");
		instance.unmount();
	});
});
