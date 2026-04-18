// ── ALDA Lexer ────────────────────────────────────────────────────────────────
// Tokenizes the txt2midi subset of the ALDA language. Single-pass, single
// cursor over the source string. Token values (start/end offsets, numeric
// values) are produced directly — strings are not extracted until the parser
// or emitter actually needs them.
//
// Grammar subset (per PHOBOS-Audio-Subsystem-Spec.md §4.9):
//   • Instrument declarations   piano:           /voice "v1":
//   • Notes                     c d e f g a b
//   • Accidentals               c+  (sharp)   d-  (flat)
//   • Durations                 c8  c4  c2.
//   • Octaves                   o3  > <
//   • Chords                    c/e/g
//   • Rests                     r4
//   • Voices                    V1:
//   • Attributes                (tempo 120)  (volume 90)
//   • Barlines                  |              (ignored, whitespace)
//   • Comments                  # line comment
// ─────────────────────────────────────────────────────────────────────────────

export enum TokenType {
  NoteLetter     = 1,   // value = MIDI pitch class 0..11 (C=0, D=2, E=4, F=5, G=7, A=9, B=11)
  Sharp          = 2,
  Flat           = 3,
  Digit          = 4,   // value = 0..9 (for durations, octave numbers, etc.)
  Dot            = 5,   // dotted duration
  Slash          = 6,   // chord separator
  OctaveSet      = 7,   // 'o' literal — next digit(s) form octave
  OctaveUp       = 8,   // '>'
  OctaveDown     = 9,   // '<'
  Rest           = 10,  // 'r' literal
  VoiceMarker    = 11,  // 'V' literal (uppercase only) — followed by digit and colon
  Colon          = 12,
  Identifier     = 13,  // any word starting with letter other than single-letter note/rest
  StringLit      = 14,  // "..."
  LParen         = 15,
  RParen         = 16,
  Barline        = 17,  // '|' — already a no-op but emitted for completeness
  EOF            = 99,
}

export interface Token {
  type:  TokenType;
  start: number;      // inclusive
  end:   number;      // exclusive
  value: number;      // secondary payload (pitch class, digit value, etc.)
}

const PITCH_CLASS: Record<string, number> = {
  c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11,
};

export class AldaLexer {
  readonly source: string;
  private cursor = 0;
  private tokens: Token[] = [];

  constructor(source: string) {
    this.source = source;
  }

  tokenize(): Token[] {
    const src = this.source;
    const len = src.length;

    while (this.cursor < len) {
      const c = src[this.cursor];

      // Whitespace + barlines
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '|') {
        this.cursor++;
        continue;
      }

      // Comments to end of line
      if (c === '#') {
        while (this.cursor < len && src[this.cursor] !== '\n') this.cursor++;
        continue;
      }

      // Parens for attributes
      if (c === '(') { this.emit(TokenType.LParen, this.cursor, this.cursor + 1, 0); this.cursor++; continue; }
      if (c === ')') { this.emit(TokenType.RParen, this.cursor, this.cursor + 1, 0); this.cursor++; continue; }

      // Chord separator
      if (c === '/') { this.emit(TokenType.Slash, this.cursor, this.cursor + 1, 0); this.cursor++; continue; }

      // Accidentals
      if (c === '+') { this.emit(TokenType.Sharp, this.cursor, this.cursor + 1, 0); this.cursor++; continue; }
      if (c === '-') { this.emit(TokenType.Flat,  this.cursor, this.cursor + 1, 0); this.cursor++; continue; }

      // Dotted duration
      if (c === '.') { this.emit(TokenType.Dot, this.cursor, this.cursor + 1, 0); this.cursor++; continue; }

      // Octave shift
      if (c === '>') { this.emit(TokenType.OctaveUp,   this.cursor, this.cursor + 1, 0); this.cursor++; continue; }
      if (c === '<') { this.emit(TokenType.OctaveDown, this.cursor, this.cursor + 1, 0); this.cursor++; continue; }

      // Colon — instrument or voice terminator
      if (c === ':') { this.emit(TokenType.Colon, this.cursor, this.cursor + 1, 0); this.cursor++; continue; }

      // Digit
      if (c >= '0' && c <= '9') {
        this.emit(TokenType.Digit, this.cursor, this.cursor + 1, c.charCodeAt(0) - 48);
        this.cursor++;
        continue;
      }

      // String literal (instrument alias)
      if (c === '"') {
        const start = this.cursor;
        this.cursor++;
        while (this.cursor < len && src[this.cursor] !== '"') this.cursor++;
        if (this.cursor >= len) throw new Error(`Unterminated string literal at offset ${start}`);
        this.cursor++; // consume closing quote
        this.emit(TokenType.StringLit, start, this.cursor, 0);
        continue;
      }

      // Lowercase letter — candidate note, rest, octave marker, or identifier
      if (c >= 'a' && c <= 'z') {
        // Single-letter notes c d e f g a b.
        //
        // ALDA disambiguation: a note can be followed by accidentals (+,-),
        // a duration number (c4, c8, c16), a dot for dotted rhythm (c4.), or
        // whitespace. It becomes an identifier ONLY if followed by another
        // letter or underscore ("cello", "clarinet"). We don't check digits
        // in the continuation test — digits after a note letter are always
        // durations, not part of a name.
        if (c in PITCH_CLASS) {
          const next = this.cursor + 1 < len ? src[this.cursor + 1] : '';
          if (isWordContinuation(next)) {
            this.readIdentifier();
            continue;
          }
          this.emit(TokenType.NoteLetter, this.cursor, this.cursor + 1, PITCH_CLASS[c]);
          this.cursor++;
          continue;
        }

        // 'r' rest — same single-letter rule
        if (c === 'r') {
          const next = this.cursor + 1 < len ? src[this.cursor + 1] : '';
          if (isWordContinuation(next)) {
            this.readIdentifier();
            continue;
          }
          this.emit(TokenType.Rest, this.cursor, this.cursor + 1, 0);
          this.cursor++;
          continue;
        }

        // 'o' octave-set — must be followed by a digit
        if (c === 'o') {
          const next = this.cursor + 1 < len ? src[this.cursor + 1] : '';
          if (next >= '0' && next <= '9') {
            this.emit(TokenType.OctaveSet, this.cursor, this.cursor + 1, 0);
            this.cursor++;
            continue;
          }
          // Otherwise fall through to identifier
        }

        // Anything else starting with a letter → identifier
        this.readIdentifier();
        continue;
      }

      // Uppercase V — voice marker (V1, V2). Any other uppercase is identifier.
      if (c === 'V') {
        const next = this.cursor + 1 < len ? src[this.cursor + 1] : '';
        if (next >= '0' && next <= '9') {
          this.emit(TokenType.VoiceMarker, this.cursor, this.cursor + 1, 0);
          this.cursor++;
          continue;
        }
        this.readIdentifier();
        continue;
      }
      if (c >= 'A' && c <= 'Z') {
        this.readIdentifier();
        continue;
      }

      throw new Error(`Unexpected character '${c}' at offset ${this.cursor}`);
    }

    this.emit(TokenType.EOF, this.cursor, this.cursor, 0);
    return this.tokens;
  }

  private emit(type: TokenType, start: number, end: number, value: number): void {
    this.tokens.push({ type, start, end, value });
  }

  private readIdentifier(): void {
    const start = this.cursor;
    while (this.cursor < this.source.length && isIdentifierChar(this.source[this.cursor])) {
      this.cursor++;
    }
    this.emit(TokenType.Identifier, start, this.cursor, 0);
  }
}

function isIdentifierChar(c: string): boolean {
  if (c.length === 0) return false;
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
         (c >= '0' && c <= '9') || c === '_' || c === '-';
}

/**
 * Stricter than isIdentifierChar: lookahead test used to decide whether a
 * single note letter ("c") is actually the start of a longer identifier
 * ("cello"). An identifier STARTS with a letter followed by another letter
 * or underscore — we deliberately exclude digits here because `c4` in ALDA
 * is a note-with-duration, not a name containing a digit.
 *
 * Once readIdentifier() is inside a word it uses the more permissive
 * isIdentifierChar — at that point we already know we're in an identifier,
 * so "voice2" and "my_piano-1" are fine.
 */
function isWordContinuation(c: string): boolean {
  if (c.length === 0) return false;
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
