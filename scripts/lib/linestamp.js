/**
 * Prefix each line written to a stream with the wall-clock time it arrived.
 */

/**
 * Create a writer that stamps whole lines. A partial line is held until its
 * newline arrives or end() is called. Use one writer per source stream, so
 * partial lines of stdout and stderr never mix.
 *
 * @param {{write: Function}} sink - Receives the stamped text
 * @param {() => Date} [now] - Clock, replaceable in tests
 * @returns {{write: (data: Buffer|string) => void, end: () => void}}
 */
function createLineStamper(sink, now = () => new Date()) {
	let carry = '';
	const stamp = (line) => `${now().toISOString()} ${line}\n`;

	return {
		write(data) {
			const lines = (carry + data.toString()).split('\n');
			carry = lines.pop();
			if (lines.length) sink.write(lines.map((line) => stamp(line.replace(/\r$/, ''))).join(''));
		},
		end() {
			if (carry) sink.write(stamp(carry.replace(/\r$/, '')));
			carry = '';
		},
	};
}

module.exports = { createLineStamper };
