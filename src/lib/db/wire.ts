/**
 * PostgreSQL frontend/backend protocol v3: encoding, framing, and parsing.
 *
 * Why this is hand-written rather than a driver dependency: IMPLEMENTATION_PLAN.md
 * §1 records that this platform's premise is near-zero fixed cost, and that every
 * dependency is a supply-chain and maintenance cost carried against that premise.
 * The subset of the protocol the platform actually needs is small and closed —
 * startup, three authentication mechanisms, the extended query flow, the simple
 * query flow for DDL, and asynchronous notifications. It is written once, tested
 * against a real server, and then does not change, because the wire protocol has
 * been stable at version 3.0 since 2003.
 *
 * The counter-argument — that a hand-written driver is where subtle bugs live —
 * is answered by testing every path against a real PostgreSQL rather than against
 * a mock. There is no fake server anywhere in this package, deliberately: a fake
 * server would only ever prove that the encoder agrees with the decoder.
 *
 * Reference: PostgreSQL documentation, "Frontend/Backend Protocol".
 */

/** Protocol version 3.0, encoded as (major << 16) | minor. */
export const PROTOCOL_VERSION = 196608;

/** Magic code requesting a TLS upgrade before the startup packet is sent. */
export const SSL_REQUEST_CODE = 80877103;

/**
 * Growable big-endian buffer builder.
 *
 * Exists because every frontend message is a sequence of fixed-width integers and
 * NUL-terminated strings whose total length is not known until the end, while the
 * length prefix has to be written first. Building the body separately and framing
 * it afterwards is simpler than a two-pass size calculation, and impossible to get
 * out of sync with the body it describes.
 */
export class Writer {
  #buf: Buffer;
  #len = 0;

  constructor(initialSize = 256) {
    this.#buf = Buffer.allocUnsafe(Math.max(initialSize, 8));
  }

  #ensure(extra: number): void {
    if (this.#len + extra <= this.#buf.length) return;
    let size = this.#buf.length;
    while (size < this.#len + extra) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.#buf.copy(next, 0, 0, this.#len);
    this.#buf = next;
  }

  byte(value: number): this {
    this.#ensure(1);
    this.#buf.writeUInt8(value, this.#len);
    this.#len += 1;
    return this;
  }

  int16(value: number): this {
    this.#ensure(2);
    this.#buf.writeInt16BE(value, this.#len);
    this.#len += 2;
    return this;
  }

  int32(value: number): this {
    this.#ensure(4);
    this.#buf.writeInt32BE(value, this.#len);
    this.#len += 4;
    return this;
  }

  /** A NUL-terminated UTF-8 string, the protocol's only string form. */
  cstring(value: string): this {
    const bytes = Buffer.from(value, 'utf8');
    this.#ensure(bytes.length + 1);
    bytes.copy(this.#buf, this.#len);
    this.#len += bytes.length;
    this.#buf.writeUInt8(0, this.#len);
    this.#len += 1;
    return this;
  }

  raw(bytes: Buffer): this {
    this.#ensure(bytes.length);
    bytes.copy(this.#buf, this.#len);
    this.#len += bytes.length;
    return this;
  }

  /** A view over the written bytes. Only valid until the next write. */
  take(): Buffer {
    return this.#buf.subarray(0, this.#len);
  }
}

/**
 * Wrap a message body in its protocol frame.
 *
 * `type` is omitted only for the startup and SSL-request packets, the two
 * messages the frontend sends before a type byte is meaningful. The length field
 * counts itself, which is the single most common off-by-four in a protocol
 * implementation, so it is computed here and nowhere else.
 */
export function frame(type: string | undefined, body: Buffer): Buffer {
  const prefix = type === undefined ? 0 : 1;
  const out = Buffer.allocUnsafe(prefix + 4 + body.length);
  if (type !== undefined) out.writeUInt8(type.charCodeAt(0), 0);
  out.writeInt32BE(body.length + 4, prefix);
  body.copy(out, prefix + 4);
  return out;
}

/** Sequential reader over a backend message body. */
export class Reader {
  readonly #buf: Buffer;
  #offset = 0;

  constructor(buf: Buffer) {
    this.#buf = buf;
  }

  get remaining(): number {
    return this.#buf.length - this.#offset;
  }

  byte(): number {
    const value = this.#buf.readUInt8(this.#offset);
    this.#offset += 1;
    return value;
  }

  int16(): number {
    const value = this.#buf.readInt16BE(this.#offset);
    this.#offset += 2;
    return value;
  }

  int32(): number {
    const value = this.#buf.readInt32BE(this.#offset);
    this.#offset += 4;
    return value;
  }

  cstring(): string {
    const end = this.#buf.indexOf(0, this.#offset);
    if (end === -1) throw new RangeError('unterminated protocol string');
    const value = this.#buf.toString('utf8', this.#offset, end);
    this.#offset = end + 1;
    return value;
  }

  bytes(length: number): Buffer {
    const value = this.#buf.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  rest(): Buffer {
    const value = this.#buf.subarray(this.#offset);
    this.#offset = this.#buf.length;
    return value;
  }
}

// ---------------------------------------------------------------------------
// Frontend messages
// ---------------------------------------------------------------------------

/**
 * The startup packet.
 *
 * `parameters` carries session GUCs as well as `user` and `database`. Pinning
 * `TimeZone`, `DateStyle` and `extra_float_digits` here rather than with a
 * follow-up `SET` matters: it makes the text representation of every value the
 * server sends deterministic from the first byte, so decoding never depends on
 * how the server itself happens to be configured. A server whose `timezone` is
 * set to something local would otherwise return timestamps this client would
 * have to guess the meaning of — and guessing wrong shifts every stored
 * timestamp by hours, which is exactly the kind of difference between
 * deployments that `environment-portability.md` AC8 forbids.
 */
export function startupMessage(parameters: Readonly<Record<string, string>>): Buffer {
  const w = new Writer();
  w.int32(PROTOCOL_VERSION);
  for (const [key, value] of Object.entries(parameters)) {
    w.cstring(key);
    w.cstring(value);
  }
  w.byte(0);
  return frame(undefined, w.take());
}

export function sslRequestMessage(): Buffer {
  const w = new Writer(8);
  w.int32(SSL_REQUEST_CODE);
  return frame(undefined, w.take());
}

/** Cleartext or MD5 password response. Both use the same message type. */
export function passwordMessage(payload: string): Buffer {
  const w = new Writer();
  w.cstring(payload);
  return frame('p', w.take());
}

export function saslInitialResponseMessage(mechanism: string, data: Buffer): Buffer {
  const w = new Writer();
  w.cstring(mechanism);
  w.int32(data.length);
  w.raw(data);
  return frame('p', w.take());
}

export function saslResponseMessage(data: Buffer): Buffer {
  return frame('p', data);
}

/**
 * Parse a statement.
 *
 * `paramTypes` is always empty in this client, which tells the server to infer
 * each parameter's type from where it is used. Declaring types here would mean
 * every call site had to know the column type it is comparing against, and would
 * break silently the first time a migration changed one.
 */
export function parseMessage(name: string, sql: string, paramTypes: readonly number[] = []): Buffer {
  const w = new Writer(sql.length + 32);
  w.cstring(name);
  w.cstring(sql);
  w.int16(paramTypes.length);
  for (const oid of paramTypes) w.int32(oid);
  return frame('P', w.take());
}

/**
 * Bind parameters to a portal.
 *
 * Every parameter and every result column uses the text format (format code 0).
 * Binary format would be faster, but it makes the client responsible for the
 * exact on-wire layout of every type, which is where a driver acquires a long
 * tail of type-specific bugs. Text is self-describing, and at the message volumes
 * `cost-efficient-operation.md` contemplates the difference is not measurable.
 */
export function bindMessage(
  portal: string,
  statement: string,
  parameters: readonly (Buffer | null)[],
): Buffer {
  const w = new Writer();
  w.cstring(portal);
  w.cstring(statement);
  w.int16(0); // all parameters in text format
  w.int16(parameters.length);
  for (const value of parameters) {
    if (value === null) {
      w.int32(-1);
    } else {
      w.int32(value.length);
      w.raw(value);
    }
  }
  w.int16(0); // all results in text format
  return frame('B', w.take());
}

export function describeMessage(kind: 'S' | 'P', name: string): Buffer {
  const w = new Writer();
  w.byte(kind.charCodeAt(0));
  w.cstring(name);
  return frame('D', w.take());
}

export function executeMessage(portal: string, maxRows = 0): Buffer {
  const w = new Writer();
  w.cstring(portal);
  w.int32(maxRows);
  return frame('E', w.take());
}

export function queryMessage(sql: string): Buffer {
  const w = new Writer(sql.length + 8);
  w.cstring(sql);
  return frame('Q', w.take());
}

export const SYNC_MESSAGE = frame('S', Buffer.alloc(0));
export const TERMINATE_MESSAGE = frame('X', Buffer.alloc(0));

// ---------------------------------------------------------------------------
// Backend messages
// ---------------------------------------------------------------------------

/** A column's description from a RowDescription message. */
export interface FieldDescription {
  readonly name: string;
  readonly typeOid: number;
}

export function parseRowDescription(body: Buffer): FieldDescription[] {
  const r = new Reader(body);
  const count = r.int16();
  const fields: FieldDescription[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = r.cstring();
    r.int32(); // table oid
    r.int16(); // column attribute number
    const typeOid = r.int32();
    r.int16(); // type size
    r.int32(); // type modifier
    r.int16(); // format code
    fields.push({ name, typeOid });
  }
  return fields;
}

/** Raw column values for one row. `null` distinguishes SQL NULL from empty string. */
export function parseDataRow(body: Buffer): (string | null)[] {
  const r = new Reader(body);
  const count = r.int16();
  const values: (string | null)[] = [];
  for (let i = 0; i < count; i += 1) {
    const length = r.int32();
    values.push(length === -1 ? null : r.bytes(length).toString('utf8'));
  }
  return values;
}

/**
 * The field map of an ErrorResponse or NoticeResponse.
 *
 * Keyed by the single-character field codes: `S` severity, `C` SQLSTATE,
 * `M` message, `D` detail, `n` constraint name, `t` table, and so on.
 *
 * Treat `M` and `D` as sensitive. A unique-violation detail reads
 * `Key (email)=(...) already exists`, so the server's own error text can carry a
 * client's email address or an end customer's phone number. That is why
 * `errors.ts` maps these onto the platform taxonomy using the SQLSTATE and the
 * constraint name only, and never propagates `D`.
 */
export function parseErrorFields(body: Buffer): Record<string, string> {
  const r = new Reader(body);
  const fields: Record<string, string> = {};
  for (;;) {
    if (r.remaining === 0) break;
    const code = r.byte();
    if (code === 0) break;
    fields[String.fromCharCode(code)] = r.cstring();
  }
  return fields;
}

export interface BackendNotification {
  readonly processId: number;
  readonly channel: string;
  readonly payload: string;
}

export function parseNotification(body: Buffer): BackendNotification {
  const r = new Reader(body);
  return { processId: r.int32(), channel: r.cstring(), payload: r.cstring() };
}

/**
 * Split a stream buffer into complete backend messages.
 *
 * Returns what it could fully decode plus the unconsumed remainder. TCP provides
 * no message boundaries, so a RowDescription can arrive split across two `data`
 * events and two small messages can arrive in one. Keeping the remainder rather
 * than assuming one whole message per event is the difference between a client
 * that works under load and one that works only in tests.
 */
export function splitMessages(buffer: Buffer): {
  readonly messages: readonly { readonly type: string; readonly body: Buffer }[];
  readonly rest: Buffer;
} {
  const messages: { type: string; body: Buffer }[] = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 5) break;
    const length = buffer.readInt32BE(offset + 1);
    if (buffer.length - offset < length + 1) break;
    messages.push({
      type: String.fromCharCode(buffer.readUInt8(offset)),
      body: buffer.subarray(offset + 5, offset + 1 + length),
    });
    offset += 1 + length;
  }
  return { messages, rest: offset === 0 ? buffer : buffer.subarray(offset) };
}
