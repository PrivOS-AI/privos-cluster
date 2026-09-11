/**
 * Strict JSON parsing for the local-runtime ABI wire body. TS port of
 * `strict_json_loads` in `infra/local-runtime-driver/privos_local_runtime_driver/canonical.py`
 * — standard `JSON.parse` silently keeps the *last* value of a duplicate
 * object key; the ABI's fail-closed contract requires rejecting the whole
 * payload instead. Canonical-hash computation itself (sorted keys, no
 * insignificant whitespace, unpadded base64url sha256) already exists at
 * `../security/artifacts.js` (`canonicalJson` / `sha256Base64Url`) and is
 * reused rather than re-implemented here — see `abi-schema.ts`.
 */
import { ContractError } from './errors.js';

class Cursor {
	pos = 0;
	constructor(readonly text: string) {}

	get done(): boolean {
		return this.pos >= this.text.length;
	}

	peek(): string {
		return this.text[this.pos] ?? '';
	}

	skipWhitespace(): void {
		while (!this.done && ' \t\n\r'.includes(this.peek())) this.pos++;
	}

	expect(char: string): void {
		if (this.peek() !== char) throw new ContractError(`expected '${char}' at position ${this.pos}`);
		this.pos++;
	}
}

function parseLiteral(cursor: Cursor, literal: string, value: unknown): unknown {
	if (cursor.text.startsWith(literal, cursor.pos)) {
		cursor.pos += literal.length;
		return value;
	}
	throw new ContractError(`invalid JSON literal at position ${cursor.pos}`);
}

function parseString(cursor: Cursor): string {
	cursor.expect('"');
	let result = '';
	while (true) {
		if (cursor.done) throw new ContractError('unterminated JSON string');
		const ch = cursor.text[cursor.pos]!;
		cursor.pos++;
		if (ch === '"') return result;
		if (ch === '\\') {
			const esc = cursor.text[cursor.pos];
			cursor.pos++;
			switch (esc) {
				case '"': result += '"'; break;
				case '\\': result += '\\'; break;
				case '/': result += '/'; break;
				case 'b': result += '\b'; break;
				case 'f': result += '\f'; break;
				case 'n': result += '\n'; break;
				case 'r': result += '\r'; break;
				case 't': result += '\t'; break;
				case 'u': {
					const hex = cursor.text.slice(cursor.pos, cursor.pos + 4);
					if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ContractError('invalid \\u escape in JSON string');
					result += String.fromCharCode(parseInt(hex, 16));
					cursor.pos += 4;
					break;
				}
				default:
					throw new ContractError('invalid escape sequence in JSON string');
			}
			continue;
		}
		const code = ch.charCodeAt(0);
		if (code < 0x20) throw new ContractError('unescaped control character in JSON string');
		result += ch;
	}
}

const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

function parseNumber(cursor: Cursor): number {
	const match = NUMBER_RE.exec(cursor.text.slice(cursor.pos));
	if (!match) throw new ContractError(`invalid JSON number at position ${cursor.pos}`);
	cursor.pos += match[0].length;
	return Number(match[0]);
}

function parseValue(cursor: Cursor): unknown {
	cursor.skipWhitespace();
	if (cursor.done) throw new ContractError('unexpected end of JSON input');
	const ch = cursor.peek();
	if (ch === '{') return parseObject(cursor);
	if (ch === '[') return parseArray(cursor);
	if (ch === '"') return parseString(cursor);
	if (ch === 't') return parseLiteral(cursor, 'true', true);
	if (ch === 'f') return parseLiteral(cursor, 'false', false);
	if (ch === 'n') return parseLiteral(cursor, 'null', null);
	if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNumber(cursor);
	throw new ContractError(`unexpected character '${ch}' at position ${cursor.pos}`);
}

function parseObject(cursor: Cursor): Record<string, unknown> {
	cursor.expect('{');
	const result: Record<string, unknown> = {};
	cursor.skipWhitespace();
	if (cursor.peek() === '}') {
		cursor.pos++;
		return result;
	}
	while (true) {
		cursor.skipWhitespace();
		const key = parseString(cursor);
		if (Object.prototype.hasOwnProperty.call(result, key)) {
			throw new ContractError(`duplicate JSON member '${key}'`);
		}
		cursor.skipWhitespace();
		cursor.expect(':');
		result[key] = parseValue(cursor);
		cursor.skipWhitespace();
		if (cursor.peek() === ',') {
			cursor.pos++;
			continue;
		}
		cursor.expect('}');
		return result;
	}
}

function parseArray(cursor: Cursor): unknown[] {
	cursor.expect('[');
	const result: unknown[] = [];
	cursor.skipWhitespace();
	if (cursor.peek() === ']') {
		cursor.pos++;
		return result;
	}
	while (true) {
		result.push(parseValue(cursor));
		cursor.skipWhitespace();
		if (cursor.peek() === ',') {
			cursor.pos++;
			continue;
		}
		cursor.expect(']');
		return result;
	}
}

/**
 * Parses `text` as strict JSON, rejecting duplicate object members at any
 * nesting level (unlike `JSON.parse`, which silently keeps the last value).
 * Throws `ContractError` on any malformed or non-standard input — this is
 * the first fail-closed gate the local-runtime ABI applies to every request
 * body, before any structural or semantic validation.
 */
export function strictJsonParse(text: string): unknown {
	const cursor = new Cursor(text);
	const value = parseValue(cursor);
	cursor.skipWhitespace();
	if (!cursor.done) throw new ContractError('trailing content after JSON value');
	return value;
}
