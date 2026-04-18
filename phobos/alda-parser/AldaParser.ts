import { AldaLexer, Token, TokenType } from './AldaLexer.js';

// ── ALDA AST ──────────────────────────────────────────────────────────────────

export type AldaNode =
  | InstrumentDecl
  | VoiceDecl
  | Note
  | Chord
  | Rest
  | OctaveChange
  | Attribute;

export interface InstrumentDecl {
  kind:   'instrument';
  name:   string;           // 'piano', 'violin', 'cello', …
  alias:  string | null;    // optional "v1" alias
}

export interface VoiceDecl {
  kind:   'voice';
  number: number;           // 1-based voice index
}

/** MIDI pitch = octave*12 + pitchClass + accidental. Computed by emitter from context. */
export interface Note {
  kind:          'note';
  pitchClass:    number;                 // 0..11
  accidental:    -1 | 0 | 1;             // flat=-1, natural=0, sharp=1
  durationNum:   number | null;          // 1,2,4,8,16,32 — note value (null = inherit)
  dotted:        boolean;
}

export interface Chord {
  kind:  'chord';
  notes: Note[];                         // all share the same duration
}

export interface Rest {
  kind:         'rest';
  durationNum:  number | null;
  dotted:       boolean;
}

export interface OctaveChange {
  kind:   'octave';
  mode:   'set' | 'up' | 'down';
  value:  number | null;    // for 'set' mode: absolute octave; else null
}

export interface Attribute {
  kind:  'attribute';
  name:  string;            // 'tempo' | 'volume' | 'panning' | …
  value: number;
}

// ── Parser ────────────────────────────────────────────────────────────────────

export class AldaParser {
  private readonly source: string;
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.source = source;
    this.tokens = new AldaLexer(source).tokenize();
  }

  parse(): AldaNode[] {
    const out: AldaNode[] = [];
    while (!this.atEnd()) {
      const node = this.parseOne();
      if (node) out.push(node);
    }
    return out;
  }

  // ── Dispatch ────────────────────────────────────────────────────────────

  private parseOne(): AldaNode | null {
    const tk = this.peek();
    switch (tk.type) {
      case TokenType.Identifier:
        return this.parseInstrumentOrAttributeBareword();

      case TokenType.VoiceMarker:
        return this.parseVoice();

      case TokenType.NoteLetter:
        return this.parseNoteOrChord();

      case TokenType.Rest:
        return this.parseRest();

      case TokenType.OctaveSet:
        return this.parseOctaveSet();

      case TokenType.OctaveUp:
        this.advance();
        return { kind: 'octave', mode: 'up',   value: null };

      case TokenType.OctaveDown:
        this.advance();
        return { kind: 'octave', mode: 'down', value: null };

      case TokenType.LParen:
        return this.parseAttribute();

      case TokenType.EOF:
        return null;

      default:
        throw new Error(`Unexpected token type ${tk.type} at offset ${tk.start}: "${this.text(tk)}"`);
    }
  }

  // ── Instrument declaration ──────────────────────────────────────────────
  //   piano:
  //   violin "v1":
  //   cello:

  private parseInstrumentOrAttributeBareword(): AldaNode {
    const first = this.advance();
    const name  = this.text(first);

    let alias: string | null = null;
    if (this.peek().type === TokenType.StringLit) {
      const s = this.advance();
      // Strip quotes
      alias = this.source.slice(s.start + 1, s.end - 1);
    }

    if (this.peek().type !== TokenType.Colon) {
      throw new Error(`Expected ':' after instrument/voice "${name}" at offset ${first.start}`);
    }
    this.advance(); // consume ':'
    return { kind: 'instrument', name, alias };
  }

  private parseVoice(): VoiceDecl {
    this.advance(); // V
    const d = this.expect(TokenType.Digit);
    let num = d.value;
    // Optional second digit (V12 unlikely but supported)
    while (this.peek().type === TokenType.Digit) {
      num = num * 10 + this.advance().value;
    }
    this.expect(TokenType.Colon);
    return { kind: 'voice', number: num };
  }

  // ── Note / Chord ────────────────────────────────────────────────────────

  private parseNoteOrChord(): AldaNode {
    const firstNote = this.parseSingleNote();

    // Chord if followed by slash + another note
    if (this.peek().type !== TokenType.Slash) return firstNote;

    const notes: Note[] = [firstNote];
    while (this.peek().type === TokenType.Slash) {
      this.advance(); // '/'
      if (this.peek().type !== TokenType.NoteLetter) {
        throw new Error(`Expected note letter after '/' at offset ${this.peek().start}`);
      }
      notes.push(this.parseSingleNote());
    }
    return { kind: 'chord', notes };
  }

  private parseSingleNote(): Note {
    const letter = this.expect(TokenType.NoteLetter);
    let accidental: -1 | 0 | 1 = 0;

    if (this.peek().type === TokenType.Sharp) { this.advance(); accidental =  1; }
    else if (this.peek().type === TokenType.Flat)  { this.advance(); accidental = -1; }

    const { durationNum, dotted } = this.readOptionalDuration();

    return {
      kind:       'note',
      pitchClass: letter.value,
      accidental,
      durationNum,
      dotted,
    };
  }

  private parseRest(): Rest {
    this.advance(); // 'r'
    const { durationNum, dotted } = this.readOptionalDuration();
    return { kind: 'rest', durationNum, dotted };
  }

  /** Reads duration digits (1, 2, 4, 8, 16, 32, …) optionally followed by a dot. */
  private readOptionalDuration(): { durationNum: number | null; dotted: boolean } {
    if (this.peek().type !== TokenType.Digit) return { durationNum: null, dotted: false };
    let num = this.advance().value;
    while (this.peek().type === TokenType.Digit) {
      num = num * 10 + this.advance().value;
    }
    const dotted = this.peek().type === TokenType.Dot;
    if (dotted) this.advance();
    return { durationNum: num, dotted };
  }

  // ── Octave set ──────────────────────────────────────────────────────────

  private parseOctaveSet(): OctaveChange {
    this.advance(); // 'o'
    let value = this.expect(TokenType.Digit).value;
    while (this.peek().type === TokenType.Digit) {
      value = value * 10 + this.advance().value;
    }
    return { kind: 'octave', mode: 'set', value };
  }

  // ── Attribute ───────────────────────────────────────────────────────────
  //   (tempo 120)
  //   (volume 90)
  //   (panning 50)

  private parseAttribute(): Attribute {
    this.advance(); // '('
    const nameTk = this.expect(TokenType.Identifier);
    const name   = this.text(nameTk);
    // Read numeric value — digits only, possibly multi-digit
    if (this.peek().type !== TokenType.Digit) {
      throw new Error(`Expected numeric value for attribute "${name}" at offset ${nameTk.start}`);
    }
    let value = this.advance().value;
    while (this.peek().type === TokenType.Digit) {
      value = value * 10 + this.advance().value;
    }
    this.expect(TokenType.RParen);
    return { kind: 'attribute', name, value };
  }

  // ── Token utilities ─────────────────────────────────────────────────────

  private peek(): Token { return this.tokens[this.pos]; }

  private advance(): Token { return this.tokens[this.pos++]; }

  private atEnd(): boolean { return this.tokens[this.pos].type === TokenType.EOF; }

  private expect(type: TokenType): Token {
    const t = this.tokens[this.pos];
    if (t.type !== type) {
      throw new Error(`Expected token type ${type}, got ${t.type} at offset ${t.start}`);
    }
    this.pos++;
    return t;
  }

  private text(tk: Token): string {
    return this.source.slice(tk.start, tk.end);
  }
}
